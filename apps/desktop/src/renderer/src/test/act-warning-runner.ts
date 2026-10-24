import { TestRunner } from "vitest";
import type { RunnerTask, RunnerTaskResultPack, RunnerTaskEventPack, RunnerTestFile, RunnerTestSuite } from "vitest";
import { getActWarningGuard } from "./act-warning-guard";

/** Finalize after afterEach, onTestFinished, fixture cleanup, and afterAll. */
export default class ActWarningRunner extends TestRunner {
  // Vitest installs this callback on the runner to publish task results.
  declare onTaskUpdate: (results: RunnerTaskResultPack[], events: RunnerTaskEventPack[]) => Promise<void>;

  override async onAfterRunTask(task: RunnerTask): Promise<void> {
    super.onAfterRunTask(task);
    const updates = getActWarningGuard().report(task.file);
    if (updates.length > 0) await this.onTaskUpdate(updates, []);
  }

  override async onAfterRunSuite(suite: RunnerTestSuite): Promise<void> {
    await super.onAfterRunSuite(suite);
    const updates = getActWarningGuard().report(suite);
    if (updates.length > 0) await this.onTaskUpdate(updates, []);
  }

  override async onAfterRunFiles(files: RunnerTestFile[]): Promise<void> {
    super.onAfterRunFiles(files);
    const lastFile = files.at(-1);
    if (!lastFile) return;
    const updates = getActWarningGuard().report(lastFile);
    if (updates.length > 0) await this.onTaskUpdate(updates, []);
  }
}
