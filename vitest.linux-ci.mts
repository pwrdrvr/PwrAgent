import { mergeConfig } from "vitest/config";
import workspace from "./vitest.workspace.mts";
import LinuxUnitSequencer from "./scripts/ci/linux-unit-sequencer.mjs";

export default mergeConfig(workspace, {
  test: { sequence: { sequencer: LinuxUnitSequencer } },
});
