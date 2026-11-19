import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("observes real dependency inspection without changing results or retaining wrappers after failure", () => {
  const root = mkdtempSync(join(tmpdir(), "native-profile-oracle-"));
  const log = join(root, "profile.jsonl");
  try {
    // A separate process owns instrumentation; no Vitest worker globals or
    // production environment are modified. The OS inspector is the oracle.
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import childProcess from "node:child_process";
      import fs from "node:fs";
      import { profileNativeBuild } from ${JSON.stringify(new URL("./native-relay-oracle-profile.mjs", import.meta.url).href)};
      const originalSpawn = childProcess.spawnSync;
      const originalStat = fs.statSync;
      const command = process.platform === "darwin" ? "/usr/bin/otool" : process.platform === "linux" ? "ldd" : process.execPath;
      const args = process.platform === "darwin" ? ["-L", process.execPath] : process.platform === "linux" ? [process.execPath] : ["--version"];
      const expected = originalSpawn(command, args, { encoding: "utf8" });
      const actual = profileNativeBuild("real-inspector", () => [
        childProcess.spawnSync(command, args, { encoding: "utf8" }),
        childProcess.spawnSync(command, args, { encoding: "utf8" }),
      ]);
      const marker = new Error("owned failure");
      let sameError = false;
      try { profileNativeBuild("failure", () => { throw marker; }); }
      catch (error) { sameError = error === marker; }
      console.log(JSON.stringify({ expected, actual, sameError,
        restored: childProcess.spawnSync === originalSpawn && fs.statSync === originalStat }));
    `], { encoding: "utf8", env: { ...process.env, PWRAGENT_NATIVE_ORACLE_PROFILE: log } }));
    expect(result.expected.status).toBe(0);
    // ldd includes process-specific ASLR addresses; dependency names and all
    // other output must agree with the uninstrumented OS invocation.
    const normalize = (text) => process.platform === "linux" ? text.replace(/0x[0-9a-f]+/g, "<address>") : text;
    for (const actual of result.actual) {
      expect(actual.status).toBe(result.expected.status);
      expect(normalize(actual.stdout)).toBe(normalize(result.expected.stdout));
      expect(actual.stderr).toBe(result.expected.stderr);
    }
    expect(result.sameError).toBe(true);
    expect(result.restored).toBe(true);
    const records = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    const inspections = records[0].inspections;
    expect(inspections).toHaveLength(process.platform === "win32" ? 0 : 2);
    for (const [index, inspection] of inspections.entries()) {
      expect(inspection.before).toEqual(inspection.after);
      expect(inspection.before.real).toBeTruthy();
      expect(inspection.before.error).toBeUndefined();
      expect(inspection.stdoutSha256).toBe(createHash("sha256").update(result.actual[index].stdout).digest("hex"));
      expect(inspection.status).toBe(0);
      expect(inspection.ms).toBeGreaterThanOrEqual(0);
    }
    if (inspections.length) expect(inspections[0].before).toEqual(inspections[1].before);
    expect(records[0].inspectionsOmitted).toBe(0);
    expect(records[1].inspections).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
