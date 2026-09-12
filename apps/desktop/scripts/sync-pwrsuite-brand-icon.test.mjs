// The sync script's job is to make one mistake unmakeable: copying a sister
// app's mark from the padded macOS rendition instead of the full-bleed master.
// It runs by hand, months apart, against a checkout this repository does not
// control, so the refusal is the only thing standing between a padded source
// and an asset that paints at 80% of everything beside it.
//
// Driven as a subprocess rather than imported: the script is a CLI with a
// top-level `await main()`, and an import would run it on load with this
// file's own argv.
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createCanvas } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { opaqueBounds, readPixels } from "./lib/icon-pixels.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "sync-pwrsuite-brand-icon.mjs");

/**
 * A stand-in for a sister repository: a square canvas with an opaque plate
 * drawn `inset` pixels in from every edge. `inset: 0` is the full-bleed master
 * the script wants; 100-in-1024 is Apple's template, the one it must refuse.
 */
function fakeSisterRepo({ size, inset }) {
  const root = mkdtempSync(resolve(tmpdir(), "pwrsuite-icon-"));
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.fillStyle = "#e8712a";
  context.fillRect(inset, inset, size - inset * 2, size - inset * 2);
  const build = resolve(root, "apps/desktop/build");
  mkdirSync(build, { recursive: true });
  writeFileSync(resolve(build, "icon.png"), canvas.toBuffer("image/png"));
  return root;
}

/**
 * Runs the script against a fake sister repo. `--out` is always passed, so a
 * test can never overwrite this repository's committed assets. Resolves with
 * the process result either way, so a test can assert on a refusal.
 */
async function run(app, repo, out) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [script, "--app", app, "--repo", repo, "--out", out],
    );
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stderr: String(error.stderr ?? error.message) };
  }
}

describe("sync-pwrsuite-brand-icon", () => {
  let fullBleed;
  let padded;
  let out;

  beforeAll(() => {
    fullBleed = fakeSisterRepo({ size: 1024, inset: 0 });
    // 100-in-1024 is Apple's template, the margin every `.icns` member carries.
    padded = fakeSisterRepo({ size: 1024, inset: 100 });
    out = mkdtempSync(resolve(tmpdir(), "pwrsuite-icon-out-"));
  });

  // Each run makes three temp directories holding two 1024px PNGs. Nothing
  // else knows to collect them, so they would pile up in the OS temp dir on
  // every local run and on any CI runner with a persistent disk.
  afterAll(() => {
    for (const directory of [fullBleed, padded, out]) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("writes a full-bleed 256px copy from a full-bleed master", async () => {
    const written = resolve(out, "pwrgit-app-icon.png");
    const result = await run("pwrgit", fullBleed, written);
    expect(result.stderr ?? "", "script failed").toBe("");
    expect(result.ok).toBe(true);

    const pixels = await readPixels(written);
    expect({ width: pixels.width, height: pixels.height }).toEqual({ width: 256, height: 256 });
    // The whole point: the plate reaches every edge, so a surface can size the
    // mark to its box and stop there.
    expect(opaqueBounds(pixels)).toEqual({ x: 0, y: 0, width: 256, height: 256 });
  });

  it("refuses a padded source and names the artifact that fooled it", async () => {
    const result = await run("pwrgit", padded, resolve(out, "refused.png"));
    expect(result.ok, "a padded source was accepted").toBe(false);
    expect(result.stderr).toContain("0.8047");
    // The message has to point somewhere: a refusal that only says "wrong
    // size" leaves the next person re-deriving which artifact to reach for.
    expect(result.stderr).toContain("icon-macos.png");
  });

  it("refuses an app it has no destination for", async () => {
    const result = await run("pwrnope", fullBleed, resolve(out, "unused.png"));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("pwrgit, pwrsnap");
  });
});
