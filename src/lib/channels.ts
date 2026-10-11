// The ways an employee can reach a person on the org chart, as the channel editor offers them.
import type { ChannelKind } from "../api/types";

export const CHANNEL_KINDS: { kind: ChannelKind; label: string; placeholder: string; whenPlaceholder: string }[] = [
  { kind: "teams", label: "Teams", placeholder: "Name or email", whenPlaceholder: "Quick questions and anything that needs an answer today" },
  { kind: "slack", label: "Slack", placeholder: "@handle or #channel", whenPlaceholder: "Quick questions; mention them in the channel" },
  { kind: "email", label: "Email", placeholder: "name@company.com", whenPlaceholder: "Anything with attachments, or that can wait a day" },
  { kind: "jira", label: "Jira", placeholder: "Project key, e.g. OPS", whenPlaceholder: "Assigning work: create a ticket in this project" },
  { kind: "asana", label: "Asana", placeholder: "Project name or URL", whenPlaceholder: "Tasks with a due date: add them to this project" },
  { kind: "azureDevOps", label: "Azure DevOps", placeholder: "org/project", whenPlaceholder: "Engineering work items and pull request reviews" },
  { kind: "github", label: "GitHub", placeholder: "@username or org/repo", whenPlaceholder: "Code review: request them on the pull request" },
  { kind: "linear", label: "Linear", placeholder: "Team key, e.g. ENG", whenPlaceholder: "Assigning work: create an issue for this team" },
  { kind: "phone", label: "Phone", placeholder: "+1 555 010 0199", whenPlaceholder: "Only if something is down and they haven't answered" },
  { kind: "other", label: "Other", placeholder: "Where to reach them", whenPlaceholder: "When this is the right way to reach them" },
];
export const channelLabel = (k: ChannelKind) => CHANNEL_KINDS.find((c) => c.kind === k)?.label ?? k;
