import { runGitCommand } from "../app-server/git-executable";

// All PR consumers share these slots, including Git ref reads and SSH config
// expansion. The command's own timeout starts only after it gets a slot.
const MAX_ACTIVE_PROCESSES = 8;
let active = 0;
const waiting: Array<() => void> = [];

export async function runPrMetadataProcess<T>(run: () => Promise<T>): Promise<T> {
  if (active === MAX_ACTIVE_PROCESSES) {
    await new Promise<void>((resolve) => { waiting.push(resolve); });
  } else {
    active++;
  }
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next(); // Transfer the slot without reopening admission.
    else active--;
  }
}

export function runPrMetadataGit(...args: Parameters<typeof runGitCommand>): ReturnType<typeof runGitCommand> {
  return runPrMetadataProcess(() => runGitCommand(...args));
}
