import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ClearDesktopSettingsSecretRequest,
  DesktopChatReplyComposer,
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsSnapshot,
  ReplaceDesktopSettingsSecretRequest,
  WriteDesktopSettingsConfigRequest,
} from "@pwragnt/shared";
import type { DesktopApi } from "../../lib/desktop-api";

export type DesktopSettingsState = {
  composerImplementation: DesktopChatReplyComposer;
  error?: string;
  loading: boolean;
  saving: boolean;
  snapshot?: DesktopSettingsSnapshot;
  clearSecret: (secret: DesktopSettingsSecretName) => Promise<void>;
  refresh: () => Promise<void>;
  replaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<void>;
  writeConfig: (patch: DesktopSettingsConfigPatch) => Promise<void>;
};

export function useDesktopSettings(desktopApi?: DesktopApi): DesktopSettingsState {
  const [snapshot, setSnapshot] = useState<DesktopSettingsSnapshot>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async (): Promise<void> => {
    if (!desktopApi?.readSettings) {
      return;
    }

    setLoading(true);
    setError(undefined);
    try {
      const response = await desktopApi.readSettings({});
      setSnapshot(response.snapshot);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : String(readError));
    } finally {
      setLoading(false);
    }
  }, [desktopApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const writeConfig = useCallback(
    async (patch: DesktopSettingsConfigPatch): Promise<void> => {
      if (!desktopApi?.writeSettingsConfig) {
        setError("Settings are unavailable.");
        return;
      }

      setSaving(true);
      setError(undefined);
      try {
        const request: WriteDesktopSettingsConfigRequest = { patch };
        const response = await desktopApi.writeSettingsConfig(request);
        setSnapshot(response.snapshot);
      } catch (writeError) {
        setError(writeError instanceof Error ? writeError.message : String(writeError));
      } finally {
        setSaving(false);
      }
    },
    [desktopApi],
  );

  const replaceSecret = useCallback(
    async (secret: DesktopSettingsSecretName, value: string): Promise<void> => {
      if (!desktopApi?.replaceSettingsSecret) {
        setError("Settings are unavailable.");
        return;
      }

      setSaving(true);
      setError(undefined);
      try {
        const request: ReplaceDesktopSettingsSecretRequest = { secret, value };
        const response = await desktopApi.replaceSettingsSecret(request);
        setSnapshot(response.snapshot);
      } catch (writeError) {
        setError(writeError instanceof Error ? writeError.message : String(writeError));
      } finally {
        setSaving(false);
      }
    },
    [desktopApi],
  );

  const clearSecret = useCallback(
    async (secret: DesktopSettingsSecretName): Promise<void> => {
      if (!desktopApi?.clearSettingsSecret) {
        setError("Settings are unavailable.");
        return;
      }

      setSaving(true);
      setError(undefined);
      try {
        const request: ClearDesktopSettingsSecretRequest = { secret };
        const response = await desktopApi.clearSettingsSecret(request);
        setSnapshot(response.snapshot);
      } catch (writeError) {
        setError(writeError instanceof Error ? writeError.message : String(writeError));
      } finally {
        setSaving(false);
      }
    },
    [desktopApi],
  );

  return useMemo(
    () => ({
      clearSecret,
      composerImplementation:
        snapshot?.experimental.chatReplyComposer.value ?? "textarea",
      error,
      loading,
      refresh,
      replaceSecret,
      saving,
      snapshot,
      writeConfig,
    }),
    [
      clearSecret,
      error,
      loading,
      refresh,
      replaceSecret,
      saving,
      snapshot,
      writeConfig,
    ],
  );
}
