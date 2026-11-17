import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import fc from "fast-check";
import { expect, it } from "vitest";
import { headlessExternalSpecifier } from "./headless-external-specifier.mjs";

it.each(["win32", "linux", "darwin"])("external ESM paths round-trip on %s, including URL-sensitive characters", platform => {
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const root = windows ? "C:\\dependencies" : "/dependencies";
  fc.assert(fc.property(fc.array(fc.constantFrom("a", " ", "#", "%", "π"), { minLength: 1, maxLength: 24 }), characters => {
    const file = paths.join(root, characters.join(""), "index.mjs");
    const specifier = headlessExternalSpecifier(file, platform);
    expect(new URL(specifier).protocol).toBe("file:");
    expect(fileURLToPath(specifier, { windows })).toBe(file);
  }));
});

it("emits a Windows external as a loadable file URL instead of an unsupported drive-letter scheme", async () => {
  const result = await build({
    stdin: { contents: 'import { value } from "fixture"; console.log(value);' },
    bundle: true, platform: "node", format: "esm", write: false, metafile: true,
    plugins: [{ name: "windows-external", setup(builder) {
      builder.onResolve({ filter: /^fixture$/ }, () => ({
        path: headlessExternalSpecifier("C:\\dependencies\\space # π\\index.mjs", "win32"), external: true,
      }));
    } }],
  });
  const [output] = Object.values(result.metafile.outputs);
  expect(output.imports[0].path).toBe("file:///C:/dependencies/space%20%23%20%CF%80/index.mjs");
});

it.each(["node:fs", "fs", "file:///C:/dependencies/index.mjs"])("preserves an already valid module specifier: %s", specifier => {
  expect(headlessExternalSpecifier(specifier, "win32")).toBe(specifier);
});
