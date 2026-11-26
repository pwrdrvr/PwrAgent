import { useState } from "react";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsField } from "./SettingsLayout";

export function OperatorAlertHistorySettings({ desktopApi }: { desktopApi?: DesktopApi }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const readHistory = desktopApi?.readOperatorAlertHistory;
  if (!readHistory) return null;

  return (
    <SettingsField
      label="Operator alert history"
      sub="Copy recent toast and desktop notification categories, timestamps, and outcomes."
      control={
        <div className="settings-hot-cpu-capture">
          <button
            type="button"
            className="button button--secondary"
            disabled={status === "copying"}
            onClick={() => {
              setStatus("copying");
              void readHistory()
                .then((history) => copyText(JSON.stringify(history, null, 2), desktopApi))
                .then(() => setStatus("copied"), () => setStatus("error"));
            }}
          >
            Copy Alert History
          </button>
          <span role="status" className="settings-hot-cpu-capture__status">
            {status === "copied" ? "Copied" : status === "error" ? "Could not copy alert history" : ""}
          </span>
        </div>
      }
    />
  );
}
