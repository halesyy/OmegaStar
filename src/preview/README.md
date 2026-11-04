# Browser preview

Every screen of Omega Star in a plain browser, without Tauri, so it can be seen and screenshotted. Dev only.

`npm run dev`, then open `http://localhost:1420/`. Outside Tauri, `src/api/client.ts` loads `transport.ts` here instead
of the desktop bridge. That branch sits behind `import.meta.env.DEV`, so `npm run build` drops it, and inside Tauri
(`npm run tauri dev` or a real build) nothing changes.

The office is invented: Fernbrook, a small company that makes booking software for fitness studios, run by Maren Holt
with six AI employees and three real people. Every name, figure and address is made up. Times are relative to when
the page loads.

## The URL

```
http://localhost:1420/?preview=<state>&theme=<theme>[&sidebar=collapsed][&toasts=1]#<route>
```

| Parameter | Values | Default |
|---|---|---|
| `preview` | a state below | `full` |
| `theme` | `light`, `dark`, `system` (saved, like the app's own setting) | unchanged |
| `sidebar` | `collapsed`, `expanded` (saved) | unchanged |
| `toasts` | `1`: three toasts show once the office loads (they leave after 4 seconds) | off |

### States

| State | What it shows |
|---|---|
| `full` | A busy office: two employees working (one streaming), one waiting to start, two needing a look, a full Inbox, an update available |
| `empty` | A company with nobody hired yet |
| `first-run` | No company: onboarding, with Claude Code found and signed in |
| `first-run-no-claude` | Onboarding, Claude Code not found |
| `first-run-signed-out` | Onboarding, Claude Code found but signed out |
| `loading` | The office opens, then nothing else ever answers: every screen's loading state |
| `loading-boot` | Nothing answers: the startup screen |
| `error` | The office opens, then every call fails: every screen's error state |
| `error-boot` | The office can't open |
| `update-failed` | `full`, and Restart to update fails |
| `usage-limit` | `full` at the 5-hour limit: work waits for the reset |
| `api-key` | `full` on an API-key account: the sidebar counts runs instead of usage |

### Routes

The app's own hash routes (`src/lib/router.ts`), with these ids:

- Employees: `juniper` (Chief of Staff), `otto` (Cloud Engineer, reports to Juniper), `rafi` (QA, reports to Otto),
  `mae` (Support Lead), `theo` (Growth Marketer), `ines` (Bookkeeper). People: `harriet`, `kofi`, `lena`. You: `you`.
- Panels: `#/org/<id>` with `/chat`, `/work`, `/skills` or `/profile`. Skills files and changes:
  `#/org/juniper/skills/file~price-changes~SKILL.md`, `#/org/juniper/skills/rev~rev-weekly`.
- Conversations: `#/chat/<employee>/thread~<root run>`, or `#/chat/<employee>` for a new one. Runs: `#/run/<run>`.

| Thread or run | What it is |
|---|---|
| `plan-1` (Juniper) | Conversation; its reply `plan-2` streams live with tools, a hand-off to Otto, a sub-agent and a page |
| `billing-1` (Otto) | The hand-off, running |
| `slow-1` (Otto) | Conversation he answered: a reply waiting on you |
| `refund-1` (Mae) | Conversation with a card proposing a company-page line |
| `pg-1` (Otto) | Report with a choice card and a link |
| `flaky-1` (Rafi) | Report with a list card |
| `news-1` (Theo) | Report with two cards, a draft file and images |
| `triage-1`, `summary-1` (Mae) | A question card; news |
| `stats-1` (Theo), `close-1` (Ines) | A chore (sign in); a task only you can do |
| `mail-1` (Theo) | Blocked on a tool |
| `tidy-1` (Juniper) | A tidy proposing bigger changes |
| `recon-3` (Ines) | A routine failing three times in a row |
| `board-1` (Juniper) | Snoozed until tomorrow |
| `welcome-1` (Mae) | Archived |
| `widget-2` (Rafi) | Waiting to start |

Sheets, the command menu and Inbox tabs open the way they do in the app (a click, or Ctrl+K).

What you do mostly works: replies, new conversations and Run now answer with a short streamed reply, cards are
answered, threads archive, approvals and settings save. It all resets on reload.

## Screenshots

```
node scripts/preview-shots.mjs [--out <dir>] [--only <text>] [--url <dev server>]
```

Every screen in the list at the top of the script, in light and dark, at 980 x 640 and 1600 x 1000, at 2x, named
`<area>--<screen>-<state>--<theme>--<w>x<h>.png`, with a `manifest.json` giving each shot's URL. `--only` reshoots the
shots whose file name contains the text and updates just those in the manifest. The browser clock is held at
Thursday 5 November 2026, 2:30 pm Sydney time (en-AU), so two runs pair up as before and after.

It reuses a dev server already serving this folder on port 1420, or starts one. It needs Google Chrome and
`playwright-core` from the Stageshow skill (`cd ~/.claude/skills/stageshow && npm install`), or `PLAYWRIGHT_CORE` set to
a `playwright-core` folder. Nothing is added to this project's dependencies.
