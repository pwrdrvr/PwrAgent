// Owns the run's directory of migrated `StateDb` templates (see
// `state-db-template.ts`): starts it empty and removes it when the run ends.
// Workers build the templates themselves, so no native code loads here, in
// the Vitest host.
import fs from "node:fs";
import type { TestProject } from "vitest/node";

export default function setup(project: TestProject): () => void {
  const dir = project.config.env?.PWRAGENT_TEST_STATE_DB_TEMPLATE_DIR;
  if (typeof dir !== "string" || dir === "") return () => {};
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return () => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
}
