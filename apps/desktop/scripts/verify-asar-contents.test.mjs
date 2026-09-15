import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { requiredPackagedRuntimeFiles } from "./asar-entry-paths.mjs";

const asar = createRequire(import.meta.url)("@electron/asar");
const verifier = fileURLToPath(new URL("./verify-asar-contents.mjs", import.meta.url));

for (const scenario of ["local", "remote", "unreadable"]) {
  it(`verifies ${scenario} renderer HTML in a real ASAR on the host platform`, async () => {
    const temp = mkdtempSync(join(tmpdir(), "verify-asar-html-"));
    try {
      const input = join(temp, "input");
      const htmlPath = join("out", "renderer", "index.html");
      mkdirSync(dirname(join(input, htmlPath)), { recursive: true });
      writeFileSync(join(input, htmlPath), scenario === "remote"
        ? '<script src="https://example.com/remote.js"></script>'
        : '<script src="./assets/index.js"></script>');
      // Supply the required native-file layout on Windows; no binary executes.
      for (const { entry } of requiredPackagedRuntimeFiles(process.platform, process.arch)) {
        const target = join(input, ...entry.slice(1).split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, "fixture");
      }
      const archive = join(temp, "app.asar");
      await asar.createPackageWithOptions(input, archive, {
        unpack: scenario === "unreadable" ? "**/*.{node,dat,html}" : "**/*.{node,dat}",
      });
      if (scenario === "unreadable") {
        rmSync(join(`${archive}.unpacked`, htmlPath));
      }
      const result = spawnSync(process.execPath, [verifier, archive], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(scenario === "local" ? 0 : 1);
      if (scenario === "local") expect(result.stdout).toContain("no remote scripts");
      if (scenario === "remote") expect(result.stderr).toContain("packaged HTML file(s) load a remote script");
      if (scenario === "unreadable") expect(result.stderr).toContain("packaged HTML file(s) could not be read");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}
