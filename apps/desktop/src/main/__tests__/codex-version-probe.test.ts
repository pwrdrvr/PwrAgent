import { describe, expect, it } from "vitest";
import {
  CODEX_VERSION_PATTERN,
  classifyProbeFailure,
  probeCodexVersion,
} from "../codex-version-probe";

describe("CODEX_VERSION_PATTERN", () => {
  it("reads the version off Codex's own banner", () => {
    for (const [output, expected] of [
      ["codex-cli 0.146.0\n", "0.146.0"],
      ["codex 0.130.0\n", "0.130.0"],
      ["codex-cli 0.128.0-alpha.1\n", "0.128.0-alpha.1"],
      ["codex/1.2.3\n", "1.2.3"],
    ] as const) {
      expect(output.match(CODEX_VERSION_PATTERN)?.[1]).toBe(expected);
    }
  });

  it("still finds a banner printed behind a warning line", () => {
    // node/npm deprecation notices routinely land on stdout before the banner,
    // so the line anchor must not be a whole-output anchor.
    const output = "(node:1) DeprecationWarning: fs.R_OK is deprecated\ncodex-cli 0.146.0\n";
    expect(output.match(CODEX_VERSION_PATTERN)?.[1]).toBe("0.146.0");
  });

  it("refuses a version that is only part of a filesystem path", () => {
    // `/` is in the separator class so `codex/1.2.3` works, which without the
    // line anchor also accepted the Homebrew Cellar layout out of any error
    // message — the recovery path marks a candidate launchable on that value,
    // and automatic candidates are ranked by version descending, so a
    // fabricated version can outrank a genuine install.
    for (const output of [
      "Error: cannot find module /opt/homebrew/Cellar/codex/0.146.0/lib/x",
      "  at /usr/lib/node_modules/@openai/codex/0.9.0/bin/x.js:1:1",
    ]) {
      expect(output.match(CODEX_VERSION_PATTERN)).toBeNull();
    }
  });
});

describe("probeCodexVersion", () => {
  it("reports the version its runner printed", async () => {
    await expect(
      probeCodexVersion({
        command: "/fake/codex",
        env: {},
        runner: async () => ({ stdout: "codex-cli 0.146.0\n" }),
      }),
    ).resolves.toEqual({ version: "0.146.0" });
  });

  it("reports version_not_reported when the command answered unparseably", async () => {
    await expect(
      probeCodexVersion({
        command: "/fake/codex",
        env: {},
        runner: async () => ({ stdout: "some other tool 1.2.3\n" }),
      }),
    ).resolves.toEqual({ failureReason: "version_not_reported" });
  });

  it("never throws, so one bad candidate cannot poison a batch", async () => {
    await expect(
      probeCodexVersion({
        command: "/fake/codex",
        env: {},
        runner: async () => {
          throw Object.assign(new Error("boom"), { code: "ENOENT" });
        },
      }),
    ).resolves.toEqual({ failureReason: "not_found" });
  });
});

describe("classifyProbeFailure", () => {
  it("separates a killed probe from a missing command", () => {
    expect(
      classifyProbeFailure(
        Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }),
      ),
    ).toBe("version_probe_timed_out");
    expect(
      classifyProbeFailure(Object.assign(new Error("nope"), { code: "ENOENT" })),
    ).toBe("not_found");
    expect(classifyProbeFailure(new Error("exit 49"))).toBe("exit 49");
  });
});
