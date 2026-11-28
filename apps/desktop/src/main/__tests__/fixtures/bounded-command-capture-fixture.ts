import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BoundedCommandCaller, BoundedCommandCapture } from "../../token-miser/bounded-command";

const output = "first line\nsecond line 💡\n";

export async function prepareCapture(capture: BoundedCommandCapture, caller: BoundedCommandCaller) {
  const ticket = await capture.prepare(caller, "git diff");
  // Model the native provider writing the capture and reporting the generated receipt.
  // The existing shell oracle checks this wire shape against a POSIX execution.
  const log = ticket.command.match(/pwragent-capture-[\w-]+\.log/u)![0];
  const receipt = ticket.command.match(/echo (pwragent-[a-f\d-]+):/u)![1];
  const filename = path.join(tmpdir(), log);
  await writeFile(filename, output);
  return { ...ticket, filename, receipt: receipt + ":0" };
}
