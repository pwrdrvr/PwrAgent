import { onTestFinished } from "vitest";
import { createOutpostDaemonStarter } from "./outpost-daemon";

export { OUTPOST_VIEWER_CAPABILITIES, type OutpostDaemon, type OutpostViewer } from "./outpost-daemon";

export const startOutpostDaemon = createOutpostDaemonStarter(onTestFinished);
