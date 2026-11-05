import { useState } from "react";
import { Icon } from "./Icon";
import { Roll } from "./ui";
import "./CopyCommand.css";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className="copycmd">
      <code className="mono">{command}</code>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()} aria-label={`Copy ${command}`}>
        <Icon name={copied ? "check" : "copy"} size={12} /> <Roll value={copied ? "Copied" : "Copy"} />
      </button>
    </span>
  );
}
