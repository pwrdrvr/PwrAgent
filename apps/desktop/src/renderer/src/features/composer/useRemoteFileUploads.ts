import { useCallback, useEffect, useRef, useState } from "react";
import type { FederationRemoteTarget } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * A file on its way to a remote thread's owner. Only unfinished uploads live
 * here; a finished one becomes an ordinary tray attachment that points at the
 * owner's copy, so drafts, queueing, and sending need nothing new.
 */
export type RemoteFileUpload = {
  id: string;
  label: string;
  sourcePath: string;
  status: "uploading" | "failed";
  sentBytes: number;
  /** Unknown until the owner accepts the transfer. */
  totalBytes?: number;
  error?: string;
};

type UploadedFile = { label: string; path: string };

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Electron prefixes errors that cross `ipcRenderer.invoke`.
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "")
    || "The file could not be copied.";
}

function newUploadId(): string {
  return `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Uploads belong to one composer scope. Switching to another thread cancels
 * the unfinished ones: their result would otherwise land in whichever draft
 * the composer shows when the copy finishes.
 */
export function useRemoteFileUploads(params: {
  desktopApi?: DesktopApi;
  target?: FederationRemoteTarget;
  scopeKey: string;
  onUploaded: (files: UploadedFile[]) => void;
}): {
  uploads: RemoteFileUpload[];
  start: (files: Array<{ label: string; sourcePath: string }>) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
} {
  const { desktopApi, target } = params;
  const [uploads, setUploads] = useState<RemoteFileUpload[]>([]);
  // Finished copies wait here for the next commit, so the composer adds them
  // from its latest attachment list. Two uploads finishing in one batch would
  // otherwise each extend the same stale list and drop one of them.
  const [finished, setFinished] = useState<UploadedFile[]>([]);
  const onUploadedRef = useRef(params.onUploaded);
  onUploadedRef.current = params.onUploaded;

  useEffect(() => {
    if (finished.length === 0) return;
    setFinished([]);
    onUploadedRef.current(finished);
  }, [finished]);
  // Uploads still owned by this scope. A cancelled or superseded upload's
  // late result is ignored by checking membership here.
  const liveIdsRef = useRef(new Set<string>());
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;

  useEffect(() => {
    return desktopApi?.onComposerFilePushProgress?.((progress) => {
      if (!liveIdsRef.current.has(progress.uploadId)) return;
      setUploads((current) =>
        current.map((upload) =>
          upload.id === progress.uploadId && upload.status === "uploading"
            ? { ...upload, sentBytes: progress.sentBytes, totalBytes: progress.totalBytes }
            : upload,
        ),
      );
    });
  }, [desktopApi]);

  const cancelAll = useCallback(() => {
    for (const upload of uploadsRef.current) {
      if (upload.status === "uploading") {
        void desktopApi?.cancelComposerFilePush?.({ uploadId: upload.id })
          .catch(() => undefined);
      }
    }
    liveIdsRef.current.clear();
    setUploads([]);
    setFinished([]);
  }, [desktopApi]);

  const targetKey = target ? target.instanceId : "";
  useEffect(() => cancelAll, [cancelAll, params.scopeKey, targetKey]);

  const run = useCallback(
    (upload: RemoteFileUpload) => {
      if (!target || !desktopApi?.pushComposerFile) {
        return;
      }
      liveIdsRef.current.add(upload.id);
      void desktopApi
        .pushComposerFile({
          uploadId: upload.id,
          target,
          sourcePath: upload.sourcePath,
        })
        .then((result) => {
          if (!liveIdsRef.current.delete(upload.id)) return;
          setUploads((current) => current.filter((entry) => entry.id !== upload.id));
          setFinished((current) => [...current, { label: upload.label, path: result.path }]);
        })
        .catch((error: unknown) => {
          if (!liveIdsRef.current.has(upload.id)) return;
          setUploads((current) =>
            current.map((entry) =>
              entry.id === upload.id
                ? { ...entry, status: "failed", error: errorMessage(error) }
                : entry,
            ),
          );
        });
    },
    [desktopApi, target],
  );

  const start = useCallback(
    (files: Array<{ label: string; sourcePath: string }>) => {
      const known = new Set(uploadsRef.current.map((upload) => upload.sourcePath));
      const next: RemoteFileUpload[] = [];
      for (const file of files) {
        if (!file.sourcePath || known.has(file.sourcePath)) continue;
        known.add(file.sourcePath);
        next.push({
          id: newUploadId(),
          label: file.label,
          sourcePath: file.sourcePath,
          status: "uploading",
          sentBytes: 0,
        });
      }
      if (next.length === 0) return;
      setUploads((current) => [...current, ...next]);
      next.forEach(run);
    },
    [run],
  );

  const retry = useCallback(
    (id: string) => {
      const failed = uploadsRef.current.find(
        (upload) => upload.id === id && upload.status === "failed",
      );
      if (!failed) return;
      const restarted: RemoteFileUpload = {
        ...failed,
        id: newUploadId(),
        status: "uploading",
        sentBytes: 0,
        totalBytes: undefined,
        error: undefined,
      };
      liveIdsRef.current.delete(id);
      setUploads((current) =>
        current.map((upload) => (upload.id === id ? restarted : upload)),
      );
      run(restarted);
    },
    [run],
  );

  const remove = useCallback(
    (id: string) => {
      const upload = uploadsRef.current.find((entry) => entry.id === id);
      if (upload?.status === "uploading") {
        void desktopApi?.cancelComposerFilePush?.({ uploadId: id })
          .catch(() => undefined);
      }
      liveIdsRef.current.delete(id);
      setUploads((current) => current.filter((entry) => entry.id !== id));
    },
    [desktopApi],
  );

  return { uploads, start, retry, remove };
}
