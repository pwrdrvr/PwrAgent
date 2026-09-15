// Pins the PDF runtime prewarm in `vitest.workspace.ts`.
//
// The prewarm pays PDF.js's machine-cold first read once per run so it is not
// billed to whichever test file renders a PDF first -- measured on a Windows
// runner as 4,616ms against a 325ms warm baseline, inside a 30s budget. It is
// deliberately best-effort: `pdf-runtime-prewarm.ts` catches everything, so
// neither of the two ways it can stop working fails anything on its own.
//
// Both halves are needed. The declared config value proves the warm is still
// registered for `desktop-main`, because a one-line edit to the `globalSetup`
// array would otherwise remove it silently. The resolve proves the specifier
// it warms still names a real file, because a `pdfjs-dist` upgrade that moved
// `legacy/build/pdf.mjs` would warm nothing and report nothing.
//
// Neither asserts the warm's *effect*. That is a property of the machine's
// page cache, not of this process, and a test that measured it would be
// measuring the runner.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import workspaceConfig from "../../../../../vitest.workspace";

const PREWARM_ENTRY = "apps/desktop/src/test-setup/pdf-runtime-prewarm.ts";
const PDFJS_SPECIFIER = "pdfjs-dist/legacy/build/pdf.mjs";

type ConfiguredProject = {
  test?: { globalSetup?: string[]; name?: string };
};

describe("PDF runtime prewarm", () => {
  it("stays registered as a desktop-main global setup", () => {
    const project = findProject("desktop-main");

    expect(project?.test?.globalSetup).toContain(PREWARM_ENTRY);
  });

  // The prewarm resolves this specifier itself, behind the catch. Without this
  // assertion a `pdfjs-dist` layout change turns the warm into a no-op that
  // still reports success.
  it("warms a specifier that still resolves", () => {
    const require = createRequire(import.meta.url);

    expect(() => require.resolve(PDFJS_SPECIFIER)).not.toThrow();
  });

  // The modules under test import this same specifier, so a drift that broke
  // only the prewarm's copy would leave the warm pointing at the wrong file.
  it("warms the specifier the PDF renderers actually import", async () => {
    const [renderer, preview] = await Promise.all([
      readSource("../pdf/pdf-page-renderer.ts"),
      readSource("../pdf/composer-pdf-preview.ts"),
    ]);

    expect(renderer).toContain(`import("${PDFJS_SPECIFIER}")`);
    expect(preview).toContain(`import("${PDFJS_SPECIFIER}")`);
  });
});

function findProject(name: string): ConfiguredProject | undefined {
  const projects = (workspaceConfig.test?.projects ?? []) as unknown[];
  return projects.find(
    (project): project is ConfiguredProject =>
      typeof project === "object"
      && project !== null
      && (project as ConfiguredProject).test?.name === name,
  );
}

async function readSource(relativePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}
