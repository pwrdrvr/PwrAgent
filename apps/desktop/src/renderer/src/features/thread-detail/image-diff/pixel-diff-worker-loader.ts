import PixelDiffWorker from "./pixel-diff.worker?worker&inline";

// Keep this module lazy, but statically import Vite's generated blob-worker
// wrapper into it. Dynamically importing the wrapper directly emits a chunk
// with an empty source map, which cannot enter the release debug artifact.
export function createPixelDiffWorker(): Worker {
  return new PixelDiffWorker();
}
