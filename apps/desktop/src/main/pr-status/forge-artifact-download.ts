import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { FORGE_ARTIFACT_MAX_BYTES } from "./forge-read-limits";
import { ForgeReadError } from "./forge-tool-contract";

/** Stream an opaque ZIP into a private, unique directory. Never use names from the archive. */
export async function saveForgeArtifact(response: Response, root: string, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new ForgeReadError("invalid_response", "The artifact response has no body.");
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let directory: string | undefined;
  let complete = false;
  try {
    signal.throwIfAborted();
    if (Number(response.headers.get("content-length")) > FORGE_ARTIFACT_MAX_BYTES) {
      throw new ForgeReadError("response_too_large", "Artifact exceeds the 128 MiB download limit.");
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(path.join(root, "download-"));
    const partial = path.join(directory, "artifact.zip.partial");
    const archivePath = path.join(directory, "artifact.zip");
    const file = await open(partial, "wx", 0o600);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    let signature = Buffer.alloc(0);
    try {
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
    await rename(partial, archivePath);
    complete = true;
    return { archivePath, sizeBytes, sha256: hash.digest("hex"), format: "zip", extracted: false, pathOwner: "thread_owner" };
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ForgeReadError) throw error;
    throw new ForgeReadError("download_failed", "Artifact download failed. Check connectivity and available disk space on the thread owner.");
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    if (!complete && directory) await rm(directory, { recursive: true, force: true });
  }
}
