//! Domain types shared with the frontend (camelCase JSON).
//!
//! Stored types are read back by older and newer builds: every field added after a release needs
//! #[serde(default)], and new data goes into the JSON, never a new column. An older build that saves a
//! row drops the fields it does not know, so a build of an unreleased branch runs on its own copy of
//! the office (OMEGASTAR_DATA_DIR).

use chrono::{DateTime, Utc};

mod card;
mod org;
mod requests;
mod runs;
mod schedules;
mod settings;
mod skills;

pub use card::*;
pub use org::*;
pub use requests::*;
pub use runs::*;
pub use schedules::*;
pub use settings::*;
pub use skills::*;

pub type Ts = DateTime<Utc>;
// Re-exported so `model::*` also brings the error every command returns.
pub use crate::error::{AppError, Result};

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;
    use serde_json::json;

    #[test]
    fn state_strings_match_serde() {
        fn check<T: Serialize + Copy>(all: &[T], as_str: fn(T) -> &'static str) {
            for &v in all {
                assert_eq!(serde_json::to_value(v).unwrap(), json!(as_str(v)));
            }
        }
        check(&[Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh, Effort::Max], Effort::as_str);
        check(&[RequestState::Open, RequestState::Answered, RequestState::Done, RequestState::Cancelled], RequestState::as_str);
        check(&[ProposalState::Open, ProposalState::Approved, ProposalState::Declined, ProposalState::Withdrawn], ProposalState::as_str);
        check(&[Lane::Work, Lane::Chat], Lane::as_str);
        check(&[RunState::Queued, RunState::Running, RunState::Succeeded, RunState::Failed, RunState::Cancelled, RunState::Lost], RunState::as_str);
        check(&[CheckState::Open, CheckState::Done, CheckState::Dropped], CheckState::as_str);
    }
}
