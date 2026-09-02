import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  applySecretUpdateToSettingsSnapshot,
} from "../../lib/settings-snapshot-updates";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";

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
  const readGenerationRef = useRef(0);
  const configWriteInFlightRef = useRef(false);
  const pendingRuntimeRefreshVersionRef = useRef<number | null | undefined>(
    undefined,
  );

  const read = useCallback(async (): Promise<void> => {
    if (!desktopApi?.readSettings) {
      return;
    }

    const generation = ++readGenerationRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const response = await desktopApi.readSettings({});
      if (readGenerationRef.current === generation) {
        setSnapshot(response.snapshot);
      }
    } catch (readError) {
      if (readGenerationRef.current === generation) {
        setError(
          readError instanceof Error ? readError.message : String(readError),
        );
      }
    } finally {
      if (readGenerationRef.current === generation) {
        setLoading(false);
      }
    }
  }, [desktopApi]);

  const refresh = useCallback(async (): Promise<void> => {
    await read();
  }, [read]);

  useEffect(() => {
    void read();
    return () => {
      readGenerationRef.current += 1;
    };
  }, [read]);

  useEffect(() => {
    return desktopApi?.onSettingsRuntimeChanged?.((event) => {
      if (configWriteInFlightRef.current) {
        const pending = pendingRuntimeRefreshVersionRef.current;
        pendingRuntimeRefreshVersionRef.current = event
          ? pending === null
            ? null
            : Math.max(pending ?? 0, event.version)
          : null;
        return;
      }
      void read();
    });
  }, [desktopApi, read]);

  const writeConfig = useCallback(
    async (patch: DesktopSettingsConfigPatch): Promise<boolean> => {
      if (!desktopApi?.writeSettingsConfig) {
        setError("Settings are unavailable.");
        return false;
      }

      readGenerationRef.current += 1;
      setLoading(false);
      setSaving(true);
      configWriteInFlightRef.current = true;
      setError(undefined);
      let appliedVersion: number | undefined;
      try {
        const request: WriteDesktopSettingsConfigRequest = { patch };
        const response = await desktopApi.writeSettingsConfig(request);
        appliedVersion = response.update.version;
        // The write response is authoritative over any cache read that began
        // before it completed. A queued newer config event starts a fresh read
        // below after this snapshot is adopted.
        readGenerationRef.current += 1;
        setLoading(false);
        setSnapshot(response.snapshot);
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
        configWriteInFlightRef.current = false;
        setSaving(false);
        const pendingVersion = pendingRuntimeRefreshVersionRef.current;
        pendingRuntimeRefreshVersionRef.current = undefined;
        if (
          pendingVersion !== undefined
          && (
            pendingVersion === null
            || appliedVersion === undefined
            || pendingVersion > appliedVersion
          )
        ) {
          void read();
        }
      }
    },
    [desktopApi, read],
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
          return applySecretUpdateToSettingsSnapshot(
            current,
            response.secret,
            response.state,
          );
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
          return applySecretUpdateToSettingsSnapshot(
            current,
            response.secret,
            response.state,
          );
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
      readGenerationRef.current += 1;
      setLoading(false);
      setSnapshot(nextSnapshot);
    },
    [],
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
