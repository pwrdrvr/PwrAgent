import { createHash } from "node:crypto";
import { lstat, realpath, unlink } from "node:fs/promises";
import { openForgeArtifactDestination, type ForgeArtifactDestination } from "./forge-artifact-destination";
import { FORGE_ARTIFACT_MAX_BYTES } from "./forge-read-limits";
import { ForgeReadError } from "./forge-tool-contract";

/** Stream into an exclusive project file. No profile cache or separate staging store. */
export async function saveForgeArtifact(response: Response, destination: ForgeArtifactDestination, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new ForgeReadError("invalid_response", "The artifact response has no body.");
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let created: { archivePath: string; dev: number; ino: number } | undefined;
  let complete = false;
  try {
    signal.throwIfAborted();
    if (Number(response.headers.get("content-length")) > FORGE_ARTIFACT_MAX_BYTES) {
      throw new ForgeReadError("response_too_large", "Artifact exceeds the 128 MiB download limit.");
    }
    const { file, archivePath } = await openForgeArtifactDestination(destination, signal);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    let signature = Buffer.alloc(0);
    try {
      const identity = await file.stat();
      created = { archivePath, dev: identity.dev, ino: identity.ino };
      if (await realpath(archivePath) !== archivePath) throw new ForgeReadError("forbidden", "The artifact destination changed while the file was opened.");
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        sizeBytes += part.value.byteLength;
        if (sizeBytes > FORGE_ARTIFACT_MAX_BYTES) {
          throw new ForgeReadError("response_too_large", "Artifact exceeds the 128 MiB download limit.");
        }
        if (signature.length < 4) signature = Buffer.concat([signature, part.value.subarray(0, 4 - signature.length)]);
        hash.update(part.value);
        // FileHandle.write can write fewer bytes than requested.
        let offset = 0;
        while (offset < part.value.byteLength) {
          signal.throwIfAborted();
          const { bytesWritten } = await file.write(part.value, offset, part.value.byteLength - offset);
          if (!bytesWritten) throw new ForgeReadError("download_failed", "Could not write the artifact archive.");
          offset += bytesWritten;
        }
      }
    } finally { await file.close(); }
    if (!signature.equals(Buffer.from("504b0304", "hex")) && !signature.equals(Buffer.from("504b0506", "hex"))) {
      throw new ForgeReadError("invalid_response", "The artifact response is not a ZIP archive.");
    }
    signal.throwIfAborted();
    const published = await lstat(archivePath);
    if (await realpath(archivePath) !== archivePath || published.dev !== created.dev || published.ino !== created.ino) {
      throw new ForgeReadError("forbidden", "The artifact destination changed during the download.");
    }
    complete = true;
    return { archivePath, sizeBytes, sha256: hash.digest("hex"), format: "zip", extracted: false, pathOwner: "thread_owner",
      storage: "project", projectDirectory: destination.directory, relativePath: destination.relativePath,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ForgeReadError) throw error;
    throw new ForgeReadError("download_failed", "Artifact download failed. Check connectivity and available disk space on the thread owner.");
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    if (!complete && created) {
      const info = await lstat(created.archivePath).catch(() => undefined);
      // Do not remove a replacement file installed by someone else.
      if (info?.isFile() && info.dev === created.dev && info.ino === created.ino) await unlink(created.archivePath);
    }
  }
}
