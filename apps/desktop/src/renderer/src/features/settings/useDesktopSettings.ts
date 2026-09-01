import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ClearDesktopSettingsSecretRequest,
  DesktopChatReplyComposer,
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsSnapshot,
  ReplaceDesktopSettingsSecretRequest,
  WriteDesktopSettingsConfigRequest,
} from "@pwragent/shared";
import { DESKTOP_CHAT_REPLY_COMPOSER_DEFAULT } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  applyConfigUpdateToSettingsSnapshot,
  applySecretUpdateToSettingsSnapshot,
} from "../../lib/settings-snapshot-updates";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";
import {
  readDesktopSettingsCoalesced,
  rememberDesktopSettingsSnapshot,
} from "../../lib/settings-read-coordinator";

export type DesktopSettingsState = {
  composerImplementation: DesktopChatReplyComposer;
  error?: string;
  loading: boolean;
  saving: boolean;
  snapshot?: DesktopSettingsSnapshot;
  /** Adopt a snapshot returned by a specialized refresh IPC without issuing
   *  a second read that can race or obscure the result. */
  applySnapshot?: (snapshot: DesktopSettingsSnapshot) => void;
  clearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
  refresh: () => Promise<void>;
  replaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
  writeConfig: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
};

export function useDesktopSettings(desktopApi?: DesktopApi): DesktopSettingsState {
  const [snapshot, setSnapshot] = useState<DesktopSettingsSnapshot>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const read = useCallback(async (force = false): Promise<void> => {
    if (!desktopApi?.readSettings) {
      return;
    }

    setLoading(true);
    setError(undefined);
    try {
      const response = await readDesktopSettingsCoalesced(desktopApi, { force });
      setSnapshot(response.snapshot);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : String(readError));
    } finally {
      setLoading(false);
    }
  }, [desktopApi]);

  const refresh = useCallback(async (): Promise<void> => {
    await read(true);
  }, [read]);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    return desktopApi?.onSettingsRuntimeChanged?.(() => {
      void read(true);
    });
  }, [desktopApi, read]);

  const writeConfig = useCallback(
    async (patch: DesktopSettingsConfigPatch): Promise<boolean> => {
      if (!desktopApi?.writeSettingsConfig) {
        setError("Settings are unavailable.");
        return false;
      }

      setSaving(true);
      setError(undefined);
      try {
        const request: WriteDesktopSettingsConfigRequest = { patch };
        const response = await desktopApi.writeSettingsConfig(request);
        setSnapshot((current) => {
          if (!current) return current;
          const next = applyConfigUpdateToSettingsSnapshot(
            current,
            response.update.normalizedPatch,
          );
          rememberDesktopSettingsSnapshot(desktopApi, { snapshot: next });
          return next;
        });
        if (
          patch.models?.codex?.path !== undefined
          || patch.acpAgents !== undefined
        ) {
          window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
        }
        return true;
      } catch (writeError) {
        setError(writeError instanceof Error ? writeError.message : String(writeError));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [desktopApi],
  );

  const replaceSecret = useCallback(
    async (secret: DesktopSettingsSecretName, value: string): Promise<boolean> => {
      if (!desktopApi?.replaceSettingsSecret) {
        setError("Settings are unavailable.");
        return false;
      }

      setSaving(true);
      setError(undefined);
      try {
        const request: ReplaceDesktopSettingsSecretRequest = { secret, value };
        const response = await desktopApi.replaceSettingsSecret(request);
        setSnapshot((current) => {
          if (!current) return current;
          const next = applySecretUpdateToSettingsSnapshot(
            current,
            response.secret,
            response.state,
          );
          rememberDesktopSettingsSnapshot(desktopApi, { snapshot: next });
          return next;
        });
        return true;
      } catch (writeError) {
        setError(writeError instanceof Error ? writeError.message : String(writeError));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [desktopApi],
  );

  const clearSecret = useCallback(
    async (secret: DesktopSettingsSecretName): Promise<boolean> => {
      if (!desktopApi?.clearSettingsSecret) {
        setError("Settings are unavailable.");
        return false;
      }

      setSaving(true);
      setError(undefined);
      try {
        const request: ClearDesktopSettingsSecretRequest = { secret };
        const response = await desktopApi.clearSettingsSecret(request);
        setSnapshot((current) => {
          if (!current) return current;
          const next = applySecretUpdateToSettingsSnapshot(
            current,
            response.secret,
            response.state,
          );
          rememberDesktopSettingsSnapshot(desktopApi, { snapshot: next });
          return next;
        });
        return true;
      } catch (writeError) {
        setError(writeError instanceof Error ? writeError.message : String(writeError));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [desktopApi],
  );

  const applySnapshot = useCallback(
    (nextSnapshot: DesktopSettingsSnapshot): void => {
      setSnapshot(nextSnapshot);
      rememberDesktopSettingsSnapshot(desktopApi, { snapshot: nextSnapshot });
    },
    [desktopApi],
  );

  return useMemo(
    () => ({
      applySnapshot,
      clearSecret,
      composerImplementation: DESKTOP_CHAT_REPLY_COMPOSER_DEFAULT,
      error,
      loading,
      refresh,
      replaceSecret,
      saving,
      snapshot,
      writeConfig,
    }),
    [
      applySnapshot,
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
