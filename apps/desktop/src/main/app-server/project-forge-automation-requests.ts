import {
  isAppServerBackendKind,
  type ResolveProjectHeldWakeupsRequest,
} from "@pwragent/shared";

/** A project path longer than this is not a key this instance wrote. */
const MAX_PROJECT_DIRECTORY_KEY_LENGTH = 4_096;
/** The resume dialog sends one batch; no project holds more. */
const MAX_HELD_WAKEUP_RESOLUTIONS = 500;

/**
 * The `directory:<path>` key of a Directories project, from a request this
 * instance answers as the owner: its own window's, or a peer's.
 */
export function readProjectForgeDirectoryKey(request: {
  directoryKey?: unknown;
}): string {
  const directoryKey = typeof request?.directoryKey === "string" ? request.directoryKey : "";
  if (
    !directoryKey.startsWith("directory:")
    || directoryKey.length <= "directory:".length
    || directoryKey.length > MAX_PROJECT_DIRECTORY_KEY_LENGTH
  ) {
    throw new Error("Forge Automation applies to a Directories project (directory:<path>).");
  }
  return directoryKey;
}

/** Throws unless every resolution names an entry, a thread and send or discard. */
export function assertProjectHeldWakeupResolutions(
  resolutions: unknown,
): asserts resolutions is ResolveProjectHeldWakeupsRequest["resolutions"] {
  if (!Array.isArray(resolutions) || resolutions.length > MAX_HELD_WAKEUP_RESOLUTIONS) {
    throw new Error(`Provide at most ${MAX_HELD_WAKEUP_RESOLUTIONS} held wake-up resolutions.`);
  }
  for (const resolution of resolutions as Array<Partial<ResolveProjectHeldWakeupsRequest["resolutions"][number]>>) {
    if (
      !resolution
      || typeof resolution.entryId !== "string"
      || typeof resolution.threadId !== "string"
      || typeof resolution.backend !== "string"
      || !isAppServerBackendKind(resolution.backend)
      || (resolution.action !== "send" && resolution.action !== "discard")
    ) {
      throw new Error("Each resolution needs entryId, backend, threadId and action send or discard.");
    }
  }
}
