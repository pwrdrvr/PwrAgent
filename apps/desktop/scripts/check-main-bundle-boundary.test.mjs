import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const verifier = fileURLToPath(new URL("./check-main-bundle-boundary.mjs", import.meta.url));

async function verify(files) {
  const root = await mkdtemp(join(tmpdir(), "main-bundle-boundary-"));
  try {
    const entries = {
      "package.json": '{"type":"module"}',
      "out/main/index.js": "export {};",
      "out/preload/index.cjs": 'require("electron");',
      ...files,
    };
    for (const [name, contents] of Object.entries(entries)) {
      const file = join(root, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    return spawnSync(process.execPath, [verifier, root], { encoding: "utf8" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it("accepts valid nested ESM chunks and self-contained CommonJS preloads", async () => {
  const result = await verify({ "out/main/chunks/helper.js": "export const helper = 1;" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("2 files");
});

it("rejects duplicate declarations emitted by a minifier", async () => {
  const result = await verify({ "out/main/index.js": "const require = 1; var require = 2;" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("invalid JavaScript: SyntaxError:");
});

it("rejects forbidden external dependencies in nested chunks", async () => {
  const result = await verify({ "out/main/chunks/provider.js": "const socket = require(`ws`);" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("externalized ws runtime import");
});

it("rejects workspace dependency imports emitted as template literals", async () => {
  const result = await verify({ "out/main/index.js": "require(`@pwragent/messaging-provider-discord`);" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("externalized workspace bundled-dependency import");
});

it.each(["agent-tools/pwragent-messaging-codex-tools", "federation/git-instance-handoff"])(
  "rejects externalized workspace source subpath %s", async (specifier) => {
    const result = await verify({ "out/main/index.js": `import "@pwragent/${specifier}";` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("externalized workspace bundled-dependency import");
  },
);

it("rejects sandboxed preloads requiring a shared chunk", async () => {
  const result = await verify({ "out/preload/index.cjs": "require(`./chunks/shared.cjs`);" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('sandboxed preload requires "./chunks/shared.cjs"');
});
