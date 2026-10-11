const HELP_URL = "https://docs.claude.com/en/docs/claude-code/overview";

/** Opens the Claude Code docs in the default browser. */
export async function openHelp() {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(HELP_URL);
}
