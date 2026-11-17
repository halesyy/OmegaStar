//! Skills: the catalog, imports, changes, health findings and revisions, and the company page.

use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    User,
    Synced,
    Plugin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: SkillSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
}

/// Where the skill catalog is read from, and what the scan could not read.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillSources {
    pub skills_dir: String,
    /// Catalog entries.
    pub found: usize,
    pub unreadable: usize,
    /// The first I/O error, with its path.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TidyReason {
    /// OmegaStar saw something to tidy.
    Auto,
    /// You asked for one.
    Manual,
    /// You approved the bigger changes an earlier tidy proposed; this one may make them.
    Approved,
}

/// A catalog skill copied into an employee's `imports/` folder: `id` is its catalog id, `name`
/// the folder it was copied into.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSkill {
    pub id: String,
    pub name: String,
}

/// An imported skill waiting in `imports/` to be organized.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StagedImport {
    pub name: String,
    pub description: String,
    pub files: Vec<String>,
}

/// One original behind an Organize run, as offered for removal from your Claude Code skills.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OriginalSkill {
    pub id: String,
    pub name: String,
    pub source: SkillSource,
    /// Still in your Claude Code skills.
    pub present: bool,
    /// OmegaStar can move it to the Recycle Bin (user skills only).
    pub removable: bool,
    /// Why removing it could hurt ("Also granted to Leo", "Called by `recurring-weekly`").
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Modified,
    Removed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillChange {
    pub skill: String,
    pub file: String,
    pub change: ChangeKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OwnSkill {
    pub name: String,
    pub description: String,
    pub role: bool,
    pub managed: bool,
    pub files: Vec<String>,
    pub updated_at: Ts,
}

/// What a health check can notice about an employee's skills and notes without a model. Ordered by
/// how much it matters: broken structure first, housekeeping last.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum HealthKind {
    /// A check the employee set for themselves is past its date and still open.
    OverdueCheck,
    /// A skill names another skill that does not exist.
    Dangling,
    /// No path from the role skill leads to this skill, so nobody will reach for it.
    Unreachable,
    /// Lines that read like an unfinished note ("TODO", "not yet verified", "revisit").
    LooseNotes,
    /// The same file was edited again and again within a day.
    Churn,
    /// A notes file repeats the same entry over and over.
    RepeatedEntries,
    /// A skill or reference file is long enough that it may be several things at once.
    TooLong,
    /// No run has used the skill for a month.
    Unused,
    /// Dated lines sit in a procedure, where they age unnoticed.
    DatedLines,
    /// All descriptions together are heavy, and every turn loads them all.
    DescriptionsHeavy,
    /// A description is missing or too long.
    Description,
    /// Generated or leftover files (`__pycache__`, `.bak`) inside a skill folder.
    Junk,
    /// The frontmatter name is not the folder name.
    NameMismatch,
}

impl HealthKind {
    pub fn label(self) -> &'static str {
        match self {
            HealthKind::OverdueCheck => "Check overdue",
            HealthKind::Dangling => "Broken pointer",
            HealthKind::Unreachable => "Not reachable",
            HealthKind::LooseNotes => "Unfinished notes",
            HealthKind::Churn => "Rewritten repeatedly",
            HealthKind::RepeatedEntries => "Diary building up",
            HealthKind::TooLong => "Getting long",
            HealthKind::Unused => "Not used lately",
            HealthKind::DatedLines => "Dated lines in a procedure",
            HealthKind::DescriptionsHeavy => "Descriptions are heavy",
            HealthKind::Description => "Description",
            HealthKind::Junk => "Leftover files",
            HealthKind::NameMismatch => "Name mismatch",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HealthFinding {
    pub kind: HealthKind,
    /// The skill it is about; none for the family as a whole or a notes file.
    pub skill: Option<String>,
    /// The file within the skill, or a notes file such as `workspace/state.md`.
    pub file: Option<String>,
    /// One sentence a person can act on.
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillHealth {
    pub findings: Vec<HealthFinding>,
}

/// The page every employee reads at the start of every run, with what is worth a look on it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyPage {
    pub text: String,
    pub findings: Vec<HealthFinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillRevision {
    #[serde(flatten)]
    pub change: SkillChange,
    pub id: String,
    pub run_id: Option<String>,
    pub at: Ts,
    pub before: Option<String>,
    pub after: Option<String>,
}
