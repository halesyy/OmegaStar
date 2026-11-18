import type { BuildChannel, SetupStatus } from "../../api/types";
import { Icon } from "../../components/Icon";
import { openWeb } from "../../components/conversation/CardLink";
import { relTime } from "../../lib/format";
import { checkForUpdate, useUpdateCheck } from "../../lib/update";
import { Row, Swap, sentence } from "./rows";
import supportQr from "./support-qr.svg";

export const CHANNELS: Record<BuildChannel, string> = { release: "Release", dogfood: "Test build", dev: "Developer build" };

/** Whether a newer version is out, and why not when the check failed, with a way to check now. */
export function UpdateRow({ channel }: { channel: BuildChannel }) {
  const { checking, version, error, at } = useUpdateCheck();
  const [key, desc] =
    channel === "dev" ? ["dev", "Developer builds don't update themselves."]
    : checking ? ["checking", "Checking…"]
    : error ? [`error${error}`, <span className="set-err">{sentence(error)}</span>]
    : version ? [`v${version}`, `OmegaStar ${version} is ready. Use Restart to update in the sidebar.`]
    : at ? [`at${at}`, `Up to date. Checked ${relTime(new Date(at).toISOString())}.`]
    : ["never", "Checks when OmegaStar opens, then every hour."];
  return (
    <Row title="Updates" desc={<Swap on={key}>{desc}</Swap>}>
      <button className="btn" disabled={checking || channel === "dev"} onClick={checkForUpdate}>Check now</button>
    </Row>
  );
}

/** This build's commit, then the Claude Code version and organisation the same status found, when known. */
export function aboutDesc(st: SetupStatus): string {
  const app = `Built from ${st.build.commit}.`;
  const version = st.claude.version;
  const org = st.account?.orgName ?? null;
  if (version && org) return `${app} Claude Code ${version}, signed in to ${org}.`;
  if (version) return `${app} Claude Code ${version}.`;
  if (org) return `${app} Signed in to ${org}.`;
  return app;
}

/** The page where people who like OmegaStar can buy its maker a coffee. */
const SUPPORT = new URL("https://buymeacoffee.com/futsy");

/** A card under About: a code to scan with your phone, and a button that opens the same page in your browser. */
export function SupportCard() {
  return (
    <div className="set-support">
      <img
        className="set-support-qr" src={supportQr} width={120} height={120}
        alt="QR code for OmegaStar's Buy Me a Coffee page, to donate from your phone. The Buy me a coffee button beside it opens the same page."
      />
      <div>
        <div className="set-title">Support OmegaStar</div>
        <p className="set-support-text">OmegaStar is free and open source. If it saves you time, scan the code with your phone or open the page to buy me a coffee.</p>
        <div className="set-support-act">
          <button type="button" className="btn" onClick={() => openWeb(SUPPORT)}><Icon name="external" size={13} />Buy me a coffee</button>
          <span className="set-support-url">{SUPPORT.host + SUPPORT.pathname}</span>
        </div>
      </div>
    </div>
  );
}
