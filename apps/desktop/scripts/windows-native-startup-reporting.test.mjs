import fc from "fast-check";
import { expect, it } from "vitest";
import { nativeDebuggerStatus, nativeProbeFailure } from "./windows-native-stack.mjs";

it("reports emitted startup milestones while discarding the debugger transcript", () => {
  // CDB's emitted messages are the oracle. Prefixes model a debugger that
  // stops making progress at any startup milestone, before frames arrive.
  const milestones = [
    "Microsoft (R) Windows Debugger Version 10.0",
    "Preparing the environment for Debugger Extensions Gallery repositories",
    "Waiting for Debugger Extensions Gallery to Initialize completed, duration 0.125 seconds",
    "0:000> ",
    "pwragent-noninvasive-ready",
  ];
  fc.assert(fc.property(
    fc.integer({ min: 0, max: milestones.length }),
    fc.array(fc.string({ maxLength: 40 }), { minLength: 6, maxLength: 6 }),
    (count, noise) => {
      const privateLines = noise.map((value) => "C:\\private\\secret-" + Buffer.from(value).toString("hex"));
      const transcript = milestones.slice(0, count)
        .flatMap((line, index) => [privateLines[index], line])
        .concat(privateLines[count]).join("\n");
      const expected = {
        detachUnsupported: false,
        networkPathDisallowed: false,
        bannerObserved: count >= 1,
        extensionInitializationStarted: count >= 2,
        extensionInitializationCompleted: count >= 3,
        commandPromptObserved: count >= 4,
        readinessMarkerObserved: count >= 5,
        outputBytes: Buffer.byteLength(transcript),
      };
      expect(nativeDebuggerStatus(transcript)).toEqual(expected);
      const error = new Error(count === milestones.length
        ? "Noninvasive debugger did not produce native frames"
        : "Noninvasive debugger readiness was not observed");
      error.nativeDebugger = { ...nativeDebuggerStatus(transcript), rawOutput: transcript };
      const failure = nativeProbeFailure(error);
      expect(failure).toEqual({
        reason: count === milestones.length ? "debugger-no-native-frames" : "debugger-readiness-timeout",
        debugger: { exitCode: undefined, ...expected },
      });
      expect(JSON.stringify(failure)).not.toMatch(/private|secret|rawOutput/);
    },
  ));
});
