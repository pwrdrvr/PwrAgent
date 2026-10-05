import { useEffect, useState } from "react";
import type {
  ReadWorktreeImageRequest,
  ReadWorktreeImageResponse,
  WorktreeImageRevision,
} from "@pwragent/shared";
import type { Extent, ImageDiffEntry, ImageSideKey, SideResolution } from "./image-diff-model";

export type ImageSideState =
  | { kind: "loading" }
  | { kind: "image"; url: string; blob: Blob; bytes: number; extent?: Extent }
  | { kind: "missing" }
  | { kind: "tooLarge"; sizeBytes: number }
  | { kind: "lfsPointer" }
  | { kind: "unavailable" };

export type ReadWorktreeImage = (
  request: ReadWorktreeImageRequest,
) => Promise<ReadWorktreeImageResponse>;

/**
 * Every side the Edits rail has read, for the life of the panel.
 *
 * Shared by the inline thumbnails and the lightbox, so opening a picture that
 * is already on screen does not blank it while IPC repeats the work, and the
 * lightbox can read a file the walk reached that no row ever showed. Each
 * side becomes an object URL once, and every URL is revoked on dispose —
 * a blob URL is a reference the page holds until it says otherwise.
 */
export type ImagePreviewStore = {
  peek: (entry: ImageDiffEntry, side: ImageSideKey) => ImageSideState | undefined;
  load: (entry: ImageDiffEntry, side: ImageSideKey) => Promise<ImageSideState>;
  /** Forget the working tree and HEAD, which a turn can change. Commit
   *  blobs are addressed by sha and never do. */
  invalidateMutable: () => void;
  dispose: () => void;
};

function revisionOf(entry: ImageDiffEntry, side: ImageSideKey): WorktreeImageRevision {
  return side === "before" ? entry.before : entry.after;
}

function revisionKey(revision: WorktreeImageRevision): string {
  return revision.kind === "commit" || revision.kind === "commitParent"
    ? `${revision.kind}:${revision.sha}`
    : revision.kind;
}

function isMutable(revision: WorktreeImageRevision): boolean {
  return revision.kind === "worktree" || revision.kind === "head";
}

/** Natural size, read once here so the thumbnails, the lightbox and the diff
 *  plan all agree before any of them has painted. Absent where the runtime
 *  cannot decode (jsdom); the lightbox then measures its own `<img>`. */
async function measure(url: string): Promise<Extent | undefined> {
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image.naturalWidth > 0 && image.naturalHeight > 0
      ? { w: image.naturalWidth, h: image.naturalHeight }
      : undefined;
  } catch {
    return undefined;
  }
}

export function createImagePreviewStore(read: ReadWorktreeImage): ImagePreviewStore {
  type Slot = { revision: WorktreeImageRevision; state?: ImageSideState; pending: Promise<ImageSideState> };
  const slots = new Map<string, Slot>();
  let disposed = false;

  const release = (slot: Slot) => {
    if (slot.state?.kind === "image") {
      URL.revokeObjectURL(slot.state.url);
    }
  };
  const keyOf = (entry: ImageDiffEntry, side: ImageSideKey) =>
    `${entry.worktreePath}\u0000${entry.path}\u0000${revisionKey(revisionOf(entry, side))}`;

  return {
    peek: (entry, side) => slots.get(keyOf(entry, side))?.state,
    load: (entry, side) => {
      const key = keyOf(entry, side);
      const existing = slots.get(key);
      if (existing) {
        return existing.pending;
      }
      const revision = revisionOf(entry, side);
      const slot: Slot = { revision, pending: Promise.resolve({ kind: "loading" }) };
      slot.pending = (async (): Promise<ImageSideState> => {
        let state: ImageSideState;
        try {
          const response = await read({ worktreePath: entry.worktreePath, path: entry.path, revision });
          if (response.kind === "image") {
            const blob = new Blob([response.bytes as Uint8Array<ArrayBuffer>], { type: response.mediaType });
            const url = URL.createObjectURL(blob);
            state = { kind: "image", url, blob, bytes: blob.size, extent: await measure(url) };
          } else if (response.kind === "tooLarge") {
            state = { kind: "tooLarge", sizeBytes: response.sizeBytes };
          } else if (response.kind === "missing" || response.kind === "lfsPointer") {
            state = { kind: response.kind };
          } else {
            state = { kind: "unavailable" };
          }
        } catch {
          state = { kind: "unavailable" };
        }
        // Disposed or invalidated while the read was in flight: nobody will
        // revoke this URL later, so it goes now.
        if (disposed || slots.get(key) !== slot) {
          if (state.kind === "image") URL.revokeObjectURL(state.url);
          return state;
        }
        slot.state = state;
        return state;
      })();
      slots.set(key, slot);
      return slot.pending;
    },
    invalidateMutable: () => {
      for (const [key, slot] of slots) {
        if (isMutable(slot.revision)) {
          release(slot);
          slots.delete(key);
        }
      }
    },
    dispose: () => {
      disposed = true;
      for (const slot of slots.values()) release(slot);
      slots.clear();
    },
  };
}

export function sideResolution(state: ImageSideState | undefined): SideResolution {
  if (!state || state.kind === "loading") return "pending";
  return state.kind === "missing" ? "missing" : "present";
}

/**
 * One side as React state. `generation` changes when the store is
 * invalidated, so a working-tree picture re-reads after a turn rewrites it.
 * Starts from the store's answer when it already has one, so a remount (the
 * lightbox walking back to a file) paints the picture on the first frame.
 */
export function useImageSide(params: {
  store: ImagePreviewStore | undefined;
  entry: ImageDiffEntry | undefined;
  side: ImageSideKey;
  enabled: boolean;
  generation: number;
}): ImageSideState {
  const { store, entry, side, enabled, generation } = params;
  const peeked = store && entry ? store.peek(entry, side) : undefined;
  const [state, setState] = useState<{ key: string; value: ImageSideState }>();
  const key = entry ? `${entry.key}\u0000${side}\u0000${generation}` : "";

  useEffect(() => {
    if (!store || !entry || !enabled) {
      return;
    }
    let active = true;
    void store.load(entry, side).then((value) => {
      if (active) setState({ key, value });
    });
    return () => {
      active = false;
    };
    // `entry` is identified by `key`; the object is rebuilt with every list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key, enabled]);

  if (state?.key === key) {
    return state.value;
  }
  return peeked ?? { kind: "loading" };
}
