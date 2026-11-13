//! The reporting hierarchy. You (the user) are a node in it: every employee reports up to you, and
//! only people can sit above you. Every org mutation edits an `Org` in memory and must pass
//! `Org::validate` before anything is saved, so the rules live here and nowhere else.

use crate::model::*;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq)]
pub struct Org {
    pub company: Company,
    pub employees: Vec<Employee>,
    pub people: Vec<Person>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Node<'a> {
    You,
    Member(&'a str),
}

impl Org {
    fn employee(&self, id: &str) -> Option<&Employee> {
        self.employees.iter().find(|e| e.id == id)
    }

    fn person(&self, id: &str) -> Option<&Person> {
        self.people.iter().find(|p| p.id == id)
    }

    fn person_mut(&mut self, id: &str) -> Option<&mut Person> {
        self.people.iter_mut().find(|p| p.id == id)
    }

    fn name(&self, id: &str) -> String {
        self.employee(id).map(|e| e.name.clone()).or_else(|| self.person(id).map(|p| p.name.clone())).unwrap_or_else(|| "someone".into())
    }

    /// The node directly above; `None` at the top of the company (or for an unknown member).
    fn up<'a>(&'a self, n: Node<'a>) -> Option<Node<'a>> {
        match n {
            Node::You => self.company.reports_to.as_deref().map(Node::Member),
            Node::Member(id) => match self.employee(id) {
                Some(e) => Some(e.manager_id.as_deref().map_or(Node::You, Node::Member)),
                None => match &self.person(id)?.manager {
                    PersonManager::You => Some(Node::You),
                    PersonManager::Member { id } => Some(Node::Member(id)),
                    PersonManager::Top => None,
                },
            },
        }
    }

    /// Everyone above `from`, nearest first. `Err` on a cycle.
    fn chain<'a>(&'a self, from: Node<'a>) -> std::result::Result<Vec<Node<'a>>, ()> {
        let mut seen = HashSet::from([from]);
        let mut out = vec![];
        let mut cur = from;
        while let Some(next) = self.up(cur) {
            if !seen.insert(next) {
                return Err(());
            }
            out.push(next);
            cur = next;
        }
        Ok(out)
    }

    fn reports_up_to_you(&self, id: &str) -> bool {
        self.chain(Node::Member(id)).map(|c| c.contains(&Node::You)).unwrap_or(false)
    }

    /// The people you report up through: your manager first, the top of the company last.
    fn line_above_you(&self) -> Vec<String> {
        self.chain(Node::You)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|n| match n {
                Node::Member(id) => Some(id.to_string()),
                Node::You => None,
            })
            .collect()
    }

    /// Everyone who does not report up to you: the line above you and the people under them.
    fn above_you(&self) -> HashSet<String> {
        self.people.iter().filter(|p| !self.reports_up_to_you(&p.id)).map(|p| p.id.clone()).collect()
    }

    /// The hierarchy rules. Every mutation ends here before it is saved.
    pub fn validate(&self) -> Result<()> {
        if let Some(b) = &self.company.reports_to {
            if let Some(e) = self.employee(b) {
                return Err(AppError::invalid(format!(
                    "{} is an agent. Only a real person can sit above you: every agent reports up to you.",
                    e.name
                )));
            }
            if self.person(b).is_none() {
                return Err(AppError::invalid("the person you report to is not in the org chart"));
            }
        }
        let managers = self
            .employees
            .iter()
            .map(|e| (&e.id, e.manager_id.as_deref()))
            .chain(self.people.iter().map(|p| (&p.id, p.manager.member_id())));
        for (id, manager) in managers {
            match manager {
                Some(m) if m == id => return Err(AppError::invalid(format!("{} can't report to themselves", self.name(id)))),
                Some(m) if self.employee(m).is_none() && self.person(m).is_none() => return Err(AppError::invalid("manager not found")),
                _ => {}
            }
        }
        let nodes = std::iter::once(Node::You).chain(self.employees.iter().map(|e| Node::Member(&e.id))).chain(self.people.iter().map(|p| Node::Member(&p.id)));
        for n in nodes {
            if self.chain(n).is_err() {
                return Err(AppError::invalid("that manager would create a reporting cycle"));
            }
        }
        if let Some(e) = self.employees.iter().find(|e| !self.reports_up_to_you(&e.id)) {
            return Err(AppError::invalid(format!(
                "{} is an agent, and every agent reports up to you. Only people can sit above you.",
                e.name
            )));
        }
        let tops: Vec<&Person> = self.people.iter().filter(|p| p.manager == PersonManager::Top).collect();
        match (&self.company.reports_to, tops.as_slice()) {
            (None, [p, ..]) => Err(AppError::invalid(format!(
                "{} can't be at the top of the company: you are. Choose who they report to.",
                p.name
            ))),
            (Some(_), [_, p, ..]) => Err(AppError::invalid(format!(
                "{} can't also be at the top of the company. Only the person at the top of your reporting line has no manager.",
                p.name
            ))),
            _ => Ok(()),
        }
    }

    /// Puts `to` directly above you (`None`: you become the top of the company).
    ///
    /// A person who already sits above you keeps their manager. A person from below you moves, alone,
    /// into your old place in the line: under your previous manager, or at the top. Their person
    /// reports stay with them; agents never sit above you, so any agent left under someone above you
    /// now reports to you. Clearing puts every person on your line back under you.
    pub fn set_reports_to(&mut self, to: Option<&str>) -> Result<()> {
        if self.company.reports_to.as_deref() == to {
            return Ok(());
        }
        let Some(to) = to else {
            for id in self.line_above_you() {
                if let Some(p) = self.person_mut(&id) {
                    p.manager = PersonManager::You;
                }
            }
            self.company.reports_to = None;
            return Ok(());
        };
        if let Some(e) = self.employee(to) {
            return Err(AppError::invalid(format!(
                "{} is an agent. Only a real person can sit above you: you stay in charge of every agent.",
                e.name
            )));
        }
        if self.person(to).is_none() {
            return Err(AppError::invalid("that person is not in the org chart"));
        }
        if !self.above_you().contains(to) {
            let place = match self.company.reports_to.clone() {
                Some(b) => PersonManager::Member { id: b },
                None => PersonManager::Top,
            };
            if let Some(p) = self.person_mut(to) {
                p.manager = place;
            }
        }
        self.company.reports_to = Some(to.to_string());
        let above = self.above_you();
        for e in self.employees.iter_mut().filter(|e| e.manager_id.as_ref().is_some_and(|m| above.contains(m))) {
            e.manager_id = None;
        }
        Ok(())
    }

    /// Takes a member out, moving their reports (agents, people, and you) up to their manager. When
    /// they were the top of the company, the next one down your line takes the top instead.
    pub fn remove_member(&mut self, id: &str) {
        // Where their reports go, as a manager id: `None` is you.
        let heir = match self.up(Node::Member(id)) {
            Some(Node::You) => None,
            Some(Node::Member(m)) => Some(m.to_string()),
            None => {
                let line = self.line_above_you();
                match line.iter().position(|p| p == id) {
                    Some(i) if i > 0 => {
                        let next = line[i - 1].clone();
                        if let Some(p) = self.person_mut(&next) {
                            p.manager = PersonManager::Top;
                        }
                        Some(next)
                    }
                    _ => {
                        self.company.reports_to = None;
                        None
                    }
                }
            }
        };
        for e in self.employees.iter_mut().filter(|e| e.reports_to(id)) {
            e.manager_id = heir.clone();
        }
        for p in self.people.iter_mut().filter(|p| p.manager.member_id() == Some(id)) {
            p.manager = heir.clone().map_or(PersonManager::You, |m| PersonManager::Member { id: m });
        }
        if self.company.reports_to.as_deref() == Some(id) {
            self.company.reports_to = heir;
        }
        self.employees.retain(|e| e.id != id);
        self.people.retain(|p| p.id != id);
    }
}
