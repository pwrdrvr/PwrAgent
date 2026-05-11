#!/usr/bin/env tsx

// Stitch a sequence of PNG frames into a looping GIF, optionally
// overlaying a numbered step indicator so viewers can tell at a
// glance which frame of a multi-step demo they're looking at.
//
// Designed for the README demo GIFs under
// `docs/assets/screenshots/`, but generic — any 2+ frame sequence
// works.
//
// Usage:
//   pnpm tsx apps/desktop/scripts/stitch-demo-gif.ts \
//     --output docs/assets/screenshots/screenshot-pairing.gif \
//     [--frame-duration-ms 1500] \
//     [--no-indicator] \
//     [--indicator-position top|bottom] \
//     docs/assets/screenshots/screenshot-pairing-frame-1.png \
//     docs/assets/screenshots/screenshot-pairing-frame-2.png \
//     docs/assets/screenshots/screenshot-pairing-frame-3.png
//
// The indicator is a numbered row (1  2  3 …) sitting on a
// translucent dark pill, centered horizontally over the captured
// window's title-bar zone. The current step is rendered large in
// PwrAgent's tangerine accent (#ff8a1f); steps already shown are
// white; steps still to come are dim gray.
//
// Implementation notes:
//   * Per-frame overlay rendering is delegated to a sibling Swift
//     script (`render-indicator-overlay.swift`) because the Homebrew
//     ffmpeg bottle ships without libfreetype, so `drawtext` fails
//     with "No such filter: 'drawtext'". Core Graphics + Core Text
//     give us system SF Pro for free, real rounded corners, and
//     antialiased text — no extra installs.
//   * Two-pass GIF encode (`palettegen` → `paletteuse=dither=sierra2_4a`).
//     Cleaner than the default 256-color reduction on the dark UI;
//     also more robust across ffmpeg versions than a single
//     `-filter_complex` graph.
//   * Frame duration is set via `-framerate 1/<seconds>` on the
//     input pattern. `-loop 0` makes the GIF loop forever.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const INDICATOR_RENDERER = path.join(scriptDir, "render-indicator-overlay.swift");

type CliArgs = {
  outputPath: string;
  framePaths: string[];
  frameDurationMs: number;
  drawIndicator: boolean;
  indicatorPosition: "top" | "bottom";
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    outputPath: "",
    framePaths: [],
    frameDurationMs: 1500,
    drawIndicator: true,
    indicatorPosition: "top",
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === "--output") {
      args.outputPath = argv[++i];
    } else if (raw === "--frame-duration-ms") {
      args.frameDurationMs = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(args.frameDurationMs) || args.frameDurationMs <= 0) {
        throw new Error("--frame-duration-ms must be a positive integer");
      }
    } else if (raw === "--no-indicator") {
      args.drawIndicator = false;
    } else if (raw === "--indicator-position") {
      const value = argv[++i];
      if (value !== "top" && value !== "bottom") {
        throw new Error("--indicator-position must be 'top' or 'bottom'");
      }
      args.indicatorPosition = value;
    } else if (raw === "--help" || raw === "-h") {
      printUsage();
      process.exit(0);
    } else if (raw.startsWith("--")) {
      throw new Error(`unknown flag: ${raw}`);
    } else {
      args.framePaths.push(raw);
    }
  }

  if (!args.outputPath) {
    throw new Error("--output is required");
  }
  if (args.framePaths.length < 2) {
    throw new Error(
      `at least two frame paths are required; got ${args.framePaths.length}`,
    );
  }
  for (const framePath of args.framePaths) {
    if (!existsSync(framePath)) {
      throw new Error(`frame not found: ${framePath}`);
    }
  }

  return args;
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage:",
      "  stitch-demo-gif.ts \\",
      "    --output <gif-path> \\",
      "    [--frame-duration-ms 1500] \\",
      "    [--no-indicator] \\",
      "    [--indicator-position top|bottom] \\",
      "    <frame-1.png> <frame-2.png> [<frame-3.png> …]",
      "",
    ].join("\n"),
  );
}

function annotateFrame(params: {
  inputPath: string;
  outputPath: string;
  frameIndex: number;
  totalFrames: number;
  indicatorPosition: "top" | "bottom";
}): void {
  execFileSync(
    INDICATOR_RENDERER,
    [
      params.inputPath,
      params.outputPath,
      String(params.frameIndex),
      String(params.totalFrames),
      `--position=${params.indicatorPosition}`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

/**
 * Two-pass GIF encode using palettegen → paletteuse=dither=sierra2_4a.
 * Frames must already be sequentially numbered in `framesDir` as
 * `frame_1.png`, `frame_2.png`, … `frame_N.png`.
 */
function encodeGif(params: {
  framesDir: string;
  outputPath: string;
  frameDurationMs: number;
}): void {
  const framerate = 1000 / params.frameDurationMs;
  const framePattern = path.join(params.framesDir, "frame_%d.png");
  const palettePath = path.join(params.framesDir, "palette.png");

  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      String(framerate),
      "-i",
      framePattern,
      "-vf",
      "palettegen=stats_mode=full",
      palettePath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      String(framerate),
      "-i",
      framePattern,
      "-i",
      palettePath,
      "-lavfi",
      "paletteuse=dither=sierra2_4a",
      "-loop",
      "0",
      params.outputPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const stagingDir = mkdtempSync(path.join(tmpdir(), "pwragent-demo-gif-"));
  try {
    for (let i = 0; i < args.framePaths.length; i++) {
      const staged = path.join(stagingDir, `frame_${i + 1}.png`);
      if (args.drawIndicator) {
        annotateFrame({
          inputPath: path.resolve(args.framePaths[i]),
          outputPath: staged,
          frameIndex: i,
          totalFrames: args.framePaths.length,
          indicatorPosition: args.indicatorPosition,
        });
      } else {
        // Symlink rather than copy when we're not annotating — saves
        // ~3 MB of unnecessary IO on a typical 3-frame demo.
        symlinkSync(path.resolve(args.framePaths[i]), staged);
      }
    }
    encodeGif({
      framesDir: stagingDir,
      outputPath: args.outputPath,
      frameDurationMs: args.frameDurationMs,
    });
    process.stdout.write(
      `wrote ${args.outputPath} (${args.framePaths.length} frames @ ${args.frameDurationMs}ms${args.drawIndicator ? "" : ", no indicator"})\n`,
    );
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
