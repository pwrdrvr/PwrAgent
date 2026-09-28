import { useRef, useState } from "react";
import type { DesktopSettingsConfigPatch, DesktopSettingsSnapshot } from "@pwragent/shared";
import { SettingsField, SettingsSection, ToggleField } from "./SettingsLayout";
import { useSettingsDraft } from "./useSettingsDraft";

export function FederationCapabilities(props: {
  federation: DesktopSettingsSnapshot["federation"];
  saving: boolean;
  onWriteConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
}) {
  const { federation } = props;
  const directory = useSettingsDraft({ value: federation.filePushDirectory.value });
  const writing = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const save = async (patch: NonNullable<DesktopSettingsConfigPatch["federation"]>): Promise<boolean> => {
    if (writing.current) return false;
    writing.current = true;
    setPending(true);
    setError(undefined);
    try {
      if (!await props.onWriteConfig({ federation: patch })) {
        setError("Capability change could not be saved. Try again.");
        return false;
      }
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      writing.current = false;
      setPending(false);
    }
  };

  return (
    <SettingsSection
      sectionId="capabilities"
      eyebrow="Permissions"
      title="Capabilities"
      description="Choose what enrolled peers can do on this machine. Changes save automatically and reconnect Federation, closing existing remote terminals."
    >
      <div className="settings-fields">
        <ToggleField
          label="Allow remote shells"
          sub="Let enrolled peers open terminals on this machine."
          checked={federation.allowRemoteShells.value}
          disabled={props.saving || pending}
          onChange={(allowRemoteShells) => save({ allowRemoteShells })}
        />
        <ToggleField
          label="Allow incoming files"
          sub="Let enrolled peers push files to this machine. Existing files are never overwritten. Files are not opened automatically."
          checked={federation.allowFilePush.value}
          disabled={props.saving || pending}
          onChange={(allowFilePush) => save({ allowFilePush })}
        />
        <SettingsField
          label="Incoming files folder"
          sub="Leave blank to use this machine’s Downloads folder. Use an absolute path for a different folder. Saves when you leave this field."
          control={
            <input
              className="settings-input"
              aria-label="Incoming files folder"
              value={directory.values.value}
              disabled={props.saving || pending}
              placeholder="Downloads (default)"
              onChange={(event) => directory.set("value", event.target.value)}
              onBlur={() => {
                if (directory.dirty) {
                  void save({ filePushDirectory: directory.values.value }).then((saved) => {
                    if (saved) directory.discard();
                  });
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          }
        />
        {error ? <p role="alert" className="settings-row__error">{error}</p> : null}
      </div>
    </SettingsSection>
  );
}
