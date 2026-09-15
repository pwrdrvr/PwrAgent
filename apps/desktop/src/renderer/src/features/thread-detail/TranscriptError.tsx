import type { DesktopApi } from "../../lib/desktop-api";
import { TranscriptCopyButton } from "./TranscriptCopyButton";

export function TranscriptError(props: {
  desktopApi?: Pick<DesktopApi, "copyText">;
  text: string;
}) {
  return (
    <div className="transcript-error">
      <span className="transcript-error__text">{props.text}</span>
      <TranscriptCopyButton
        className="transcript-copy-button--error"
        copiedLabel="Copied error"
        desktopApi={props.desktopApi}
        label="Copy error"
        text={props.text}
      />
    </div>
  );
}
