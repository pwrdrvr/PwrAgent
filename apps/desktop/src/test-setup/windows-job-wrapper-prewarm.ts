// Pay the Windows Job wrapper's machine-level cold start once per run, before
// any test file starts, exactly as the desktop app pays it once at startup.
//
// The wrapper owns `git worktree remove` on Windows (see
// `apps/desktop/src/main/windows-job-wrapper.ts`). Its first launch on a
// machine pages in the PowerShell host and compiles the C# Job runner, which
// hosted `windows-latest` runners have journaled at up to 16.7s and 7.1s
// respectively; every launch after it costs 0.7-2.1s. Whichever test reached
// the wrapper first was charged that difference, which put
// `backend-registry.test.ts`'s real-worktree archive at 10-21s against the
// 30-second Windows contract and intermittently over it.
//
// This warms the machine, not the assertion: every test still runs the real
// wrapper, with the same suspended launch, Job assignment, resume, and
// active-process drain. It adds no retry, no timeout headroom, and no
// serialization.
import { prewarmWindowsJobWrapper } from "../main/windows-job-wrapper";

export default async function setup(): Promise<void> {
  await prewarmWindowsJobWrapper();
}
