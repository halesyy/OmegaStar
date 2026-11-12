const WINDOWS = /^Win/.test(navigator.platform);

export const SHELL = WINDOWS ? "PowerShell" : "a terminal";

export const INSTALL_CLAUDE = WINDOWS ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash";

/** Sign in with the Claude Code the app found, by its full path: a new terminal may not have its folder on PATH yet. */
export function signInCommand(path: string | null): string {
  if (!path) return "claude auth login";
  if (WINDOWS) return /^[\w:\\.-]+$/.test(path) ? `${path} auth login` : `& '${path.replace(/'/g, "''")}' auth login`;
  return /^[\w@%+=:,./-]+$/.test(path) ? `${path} auth login` : `'${path.replace(/'/g, `'\\''`)}' auth login`;
}
