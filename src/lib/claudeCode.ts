const WINDOWS = /^Win/.test(navigator.platform);
const LINUX = /Linux/.test(navigator.platform);

export const SHELL = WINDOWS ? "PowerShell" : "a terminal";

/** Claude Code's own installer. Linux fetches it with wget: Ubuntu's desktop ships wget but not curl, and the script
 *  downloads with whichever it finds. */
export const INSTALL_CLAUDE = WINDOWS
  ? "irm https://claude.ai/install.ps1 | iex"
  : LINUX
    ? "wget -qO- https://claude.ai/install.sh | bash"
    : "curl -fsSL https://claude.ai/install.sh | bash";

/** Sign in with the Claude Code the app found, by its full path: a new terminal may not have its folder on PATH yet. */
export function signInCommand(path: string | null): string {
  if (!path) return "claude auth login";
  // PowerShell reads the curly quotes as single quotes too, so they are doubled like the straight one.
  if (WINDOWS) return /^[\w:\\.-]+$/.test(path) ? `${path} auth login` : `& '${path.replace(/['\u2018-\u201b]/g, "$&$&")}' auth login`;
  return /^[\w@%+=:,./-]+$/.test(path) ? `${path} auth login` : `'${path.replace(/'/g, `'\\''`)}' auth login`;
}
