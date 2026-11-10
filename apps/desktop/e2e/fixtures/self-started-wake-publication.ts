import path from "node:path";
import { rename, writeFile } from "node:fs/promises";

type Wake = { source: string; prompt: string };
type Files = {
  writeFile: (file: string, content: string) => Promise<void>;
  rename: (source: string, destination: string) => Promise<void>;
};

/** The actual SDK fixture's wake publisher, shared with its ownership oracle. */
export async function publishSelfStartedWakes(root: string, wakes: readonly Wake[], files: Files = { writeFile, rename }): Promise<void> {
  await files.writeFile(path.join(root, "wake-requests.tmp"), JSON.stringify(wakes));
  await files.rename(path.join(root, "wake-requests.tmp"), path.join(root, "wake-requests.json"));
}
