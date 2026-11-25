import { mergeConfig } from "vitest/config";
import workspace from "./vitest.workspace.mts";
import WindowsMainUnitSequencer from "./scripts/ci/windows-main-unit-sequencer.mjs";

export default mergeConfig(workspace, {
  test: { sequence: { sequencer: WindowsMainUnitSequencer } },
});
