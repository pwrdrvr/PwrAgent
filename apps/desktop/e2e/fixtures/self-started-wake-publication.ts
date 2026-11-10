import path from "node:path";
import { rename, writeFile } from "node:fs/promises";

type Wake = { source: string; prompt: string };
type Files = {
  writeFile: (file: string, content: string) => Promise<void>;
  rename: (source: string, destination: string) => Promise<void>;
};

/** Publish the next wake from the caller's ordered prefix without replacing a peer-owned file. */
export async function publishSelfStartedWakes(root: string, wakes: readonly Wake[], files: Files = { writeFile, rename }): Promise<void> {
  const wake = wakes.at(-1);
  if (!wake) throw new Error("A wake publication requires one pending wake");
  const stem = path.join(root, `wake-request-${wakes.length - 1}`);
  await files.writeFile(`${stem}.tmp`, JSON.stringify(wake));
  await files.rename(`${stem}.tmp`, `${stem}.json`);
}
