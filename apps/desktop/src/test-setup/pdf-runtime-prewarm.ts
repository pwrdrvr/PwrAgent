// Pay the PDF runtime's machine-level cold start once per run, before any test
// file starts, instead of billing it to whichever test renders a PDF first.
//
// `pdfjs-dist/legacy/build/pdf.mjs` is a single 1 MB ES module, and reading and
// parsing it the first time on a machine is expensive out of all proportion to
// the render that follows. Measured in fresh Node processes on a hosted
// `windows-latest` runner: that import costs 3,943 ms in the first process on
// the machine and 111 ms in every process after it. The rest of the path is
// noise by comparison -- 74 ms to open the document, 34 ms to rasterize a page,
// and 1.6 ms to import `@napi-rs/canvas`, cold and warm alike.
//
// Nothing in the suite owned that first read, so it landed on whichever test
// file Vitest happened to schedule first. In the run this was written for
// (#2170, run 35000696599), that was `app-server-ipc.test.ts`: its Composer PDF
// preview test timed out at 30,000 ms, while the four other PDF files ran three
// minutes later, warm, in 270-1,499 ms. The same test costs 358 ms on a warm
// machine under the same parallel load.
//
// The warm runs in a child process on purpose. Importing PDF.js also loads
// `@napi-rs/canvas` and its native Skia binding -- PDF.js requires it during
// module initialization -- and `vitest.workspace.ts` puts `desktop-main` on
// `pool: "forks"` precisely to keep native bindings out of the process Vitest
// itself runs in. A child pays the same page-cache and antivirus cost for the
// same files and exits, so every fork afterwards gets the 111 ms path while the
// Vitest host loads no native code at all.
//
// This warms the machine, not the assertion. Every test still imports the real
// PDF.js and renders through the real canvas, and `pdf-canvas-lazy-loading`
// still observes both modules load exactly once inside its own worker. It adds
// no retry, no timeout headroom, and no serialization.
import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);

export default async function setup(): Promise<void> {
  // Warming is an optimization, so every failure mode settles the same way. A
  // missing dependency or a child that cannot start must not fail the run the
  // warm exists to speed up; the tests then pay the cold read as they did
  // before.
  try {
    const entry = pathToFileURL(
      require.resolve("pdfjs-dist/legacy/build/pdf.mjs"),
    ).href;
    await execFile(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(entry)});`,
      ],
      { timeout: 120_000 },
    );
  } catch {
    return;
  }
}
