import { useLayoutEffect, useRef } from "react";
import { call, errorMessage } from "../../api/client";
import { useQuery } from "../../lib/hooks";
import { toast } from "../../lib/toasts";
import { Icon } from "../Icon";
import { Skeleton } from "../ui";
import { FileText } from "./CardView";
import "./Chat.css";

/** A notes file read beside its conversation (`lib/reader.ts`): its name, Open in its app and close, then its text,
 *  read again whenever a run changes so a file the employee reworked shows the new version. Where the thread is too
 *  narrow for both, it covers the conversation; in the Inbox it takes its place. */
export function ReaderPane({ path, onClose }: { path: string; onClose: () => void }) {
  const file = useQuery(() => call("report_file", { path }), [path], ["run:updated"]);
  const name = path.split(/[\\/]/).pop();
  const open = () => call("open_report_path", { path }).catch((err) => toast(errorMessage(err), "err"));
  // In a page that scrolls as one (the Inbox), a file opened from far down starts at its top.
  const top = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => { top.current!.scrollIntoView({ block: "nearest" }); }, [path]);
  return (
    <aside className="reader" aria-label={name}>
      <span ref={top} />
      <div className="reader-head">
        <Icon name="file" size={13} />
        <span className="reader-name" title={path}>{name}</span>
        <span className="grow" />
        <button className="btn btn-ghost btn-sm" title="Open in its app" onClick={() => void open()}><Icon name="external" size={12} /> Open</button>
        <button className="btn btn-ghost btn-icon btn-sm" aria-label="Close" data-tip="Close" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
      <div className="reader-body">
        {file.error ? <p className="reader-note">{file.error}</p>
          : file.data === undefined ? (
            <div className="stack" style={{ gap: 10 }} aria-busy="true">
              <Skeleton h={18} w="56%" /><Skeleton h={13} w="94%" /><Skeleton h={13} w="88%" /><Skeleton h={13} w="40%" />
            </div>
          ) : <FileText path={path} text={file.data} />}
      </div>
    </aside>
  );
}
