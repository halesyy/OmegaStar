//! The cards runs raise: open, replaced, answered, due back, parked and withdrawn.

use super::*;

impl Store {
    /// An employee's finished runs with a card you have not answered yet, oldest first.
    pub fn open_cards(&self, employee_id: &str) -> Result<Vec<Run>> {
        self.runs_where(
            concat!("WHERE employee_id = ? AND json_valid(data)
               AND EXISTS (SELECT 1 FROM ", cards!(), " WHERE json_extract(c.value, '$.answer') IS NULL)
               AND state NOT IN ", active!(), "
             ORDER BY created_at, rowid"),
            &[&employee_id],
        )
    }

    /// Work runs with a card about `topic` (`Card::topic`) still waiting on you (`Card::waiting`: no answer yet, or put
    /// off with Later), oldest first: finished ones, and ones the usage limit sent back to the queue with the cards
    /// they raised.
    pub fn open_topic_runs(&self, topic: &str) -> Result<Vec<Run>> {
        self.runs_where(
            concat!("WHERE json_valid(data)
               AND EXISTS (SELECT 1 FROM ", cards!(), "
                           WHERE json_extract(c.value, '$.key') = ? AND ", card_waiting!(), ")
               AND state != 'running' AND lane = 'work'
             ORDER BY created_at, rowid"),
            &[&topic],
        )
    }

    /// An employee's cards that a newer card replaced after `since`, with when, oldest first.
    pub fn replaced_cards(&self, employee_id: &str, since: Ts) -> Result<Vec<(Ts, Card)>> {
        // The stored times compare as text: a second's leeway keeps every later one, and the exact test is below.
        let after = serde_json::to_value(since - chrono::Duration::seconds(1))?;
        let runs = self.runs_where(
            concat!("WHERE employee_id = ? AND json_valid(data)
               AND EXISTS (SELECT 1 FROM ", cards!(), "
                           WHERE json_extract(c.value, '$.answer.how') = 'replaced' AND json_extract(c.value, '$.answer.at') > ?)"),
            &[&employee_id, &after.as_str()],
        )?;
        let mut v: Vec<(Ts, Card)> = runs
            .into_iter()
            .flat_map(|r| r.cards)
            .filter_map(|c| c.answer.as_ref().filter(|a| a.how == AnswerHow::Replaced && a.at > since).map(|a| (a.at, c.clone())))
            .collect();
        v.sort_by_key(|(at, _)| *at);
        Ok(v)
    }

    /// An employee's decision and item cards you answered after `since` (a tap, your own words or No), newest first,
    /// leaving out the runs of `session`, which heard them already, and answers still held back for their run. Your own
    /// words count only from when this build first opened the office: an older build put one typed reply on every card
    /// open in its thread, so an answer typed before then may not be about its card at all.
    pub fn answered_cards(&self, employee_id: &str, since: Ts, session: &str) -> Result<Vec<Card>> {
        let typed_since = self.meta::<Ts>("typed_answers_since")?.unwrap_or(since);
        // The stored times compare as text: a second's leeway keeps every later one, and the exact test is below.
        let after = serde_json::to_value(since - chrono::Duration::seconds(1))?;
        let runs = self.runs_where(
            concat!("WHERE employee_id = ? AND session != ? AND json_valid(data)
               AND EXISTS (SELECT 1 FROM ", cards!(), "
                           WHERE json_extract(c.value, '$.answer.how') IN ('tapped', 'typed', 'rejected') AND json_extract(c.value, '$.answer.at') > ?)"),
            &[&employee_id, &session, &after.as_str()],
        )?;
        let mut v: Vec<Card> = runs
            .into_iter()
            .flat_map(|r| r.cards)
            .filter(|c| !matches!(c.ask, CardAsk::Chore { .. }))
            .filter(|c| c.answer.as_ref().is_some_and(|a| matches!(a.how, AnswerHow::Tapped | AnswerHow::Typed | AnswerHow::Rejected) && !a.held && a.at > since))
            .filter(|c| c.answer.as_ref().is_some_and(|a| a.how != AnswerHow::Typed || a.at > typed_since))
            .collect();
        v.sort_by_key(|c| std::cmp::Reverse(c.answer.as_ref().map(|a| a.at)));
        Ok(v)
    }

    /// Runs not working right now with a card you said Later to that is due back by `at`, oldest first.
    pub fn cards_due_back(&self, at: Ts) -> Result<Vec<Run>> {
        // The stored times compare as text: a second's leeway keeps every earlier one, and the exact test is below.
        let by = serde_json::to_value(at + chrono::Duration::seconds(1))?;
        let runs = self.runs_where(
            concat!("WHERE json_valid(data) AND state != 'running'
               AND EXISTS (SELECT 1 FROM ", cards!(), "
                           WHERE json_extract(c.value, '$.backAt') IS NOT NULL AND json_extract(c.value, '$.backAt') <= ?)
             ORDER BY created_at, rowid"),
            &[&by.as_str()],
        )?;
        Ok(runs.into_iter().filter(|r| r.cards.iter().any(|c| c.back_at.is_some_and(|t| t <= at))).collect())
    }

    /// Current employees' runs holding a card you parked, newest first.
    pub fn parked_runs(&self) -> Result<Vec<Run>> {
        self.runs_where(
            concat!("WHERE employee_id IN (SELECT id FROM employees WHERE departed_at IS NULL) AND json_valid(data)
               AND EXISTS (SELECT 1 FROM ", cards!(), "
                           WHERE json_extract(c.value, '$.parked') = 1)
             ORDER BY created_at DESC, rowid DESC"),
            &[],
        )
    }

    /// Whether `employee_id` closed a card about `topic` with `close_ask` after `since`.
    pub fn withdrew_since(&self, employee_id: &str, topic: &str, since: Ts) -> Result<bool> {
        let after = serde_json::to_value(since - chrono::Duration::seconds(1))?;
        let runs = self.runs_where(
            concat!("WHERE employee_id = ? AND json_valid(data)
               AND EXISTS (SELECT 1 FROM ", cards!(), "
                           WHERE json_extract(c.value, '$.key') = ? AND json_extract(c.value, '$.answer.how') = 'withdrawn'
                             AND json_extract(c.value, '$.answer.at') > ?)"),
            &[&employee_id, &topic, &after.as_str()],
        )?;
        let withdrawn = |c: &Card| c.key.as_deref() == Some(topic) && c.answer.as_ref().is_some_and(|a| a.how == AnswerHow::Withdrawn && a.at > since);
        Ok(runs.iter().flat_map(|r| &r.cards).any(withdrawn))
    }

    /// A schedule's runs from before `before` with a decision or item card still waiting on you (`Card::waiting`),
    /// oldest first.
    pub fn open_cards_of_schedule(&self, schedule_id: &str, before: Ts) -> Result<Vec<Run>> {
        self.runs_where(
            concat!("WHERE schedule_id = ? AND created_at < ? AND json_valid(data)
               AND EXISTS (SELECT 1 FROM ", cards!(), "
                           WHERE json_extract(c.value, '$.ask.type') IN ('choices', 'items') AND ", card_waiting!(), ")
             ORDER BY created_at, rowid"),
            &[&schedule_id, &ms(before)],
        )
    }
}
