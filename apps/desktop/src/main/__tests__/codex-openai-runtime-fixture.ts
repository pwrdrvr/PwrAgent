import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { create } from "tar";
import { vi } from "vitest";
import {
  OPENAI_CODEX_CHECKSUMS_NAME,
  OPENAI_CODEX_LATEST_URL,
  OPENAI_CODEX_RELEASE_BASE_URL,
} from "../codex-openai-runtime";
import type { ManagedRuntimeProgressReporter } from "../managed-runtime-progress";

export const appleSilicon = { platform: "darwin", arch: "arm64" } as const;
export const appleSiliconTarget = "aarch64-apple-darwin";

export async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openai-codex-runtime-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export type PackageFault = "manifest-version" | "missing-rg" | "symlink";

/** A `codex-package-<target>.tar.gz` in OpenAI's layout. */
export async function makeOpenAiCodexPackage(
  scratch: string,
  version: string,
  fault?: PackageFault,
): Promise<Buffer> {
  const stage = await mkdtemp(path.join(scratch, `package-${version}-`));
  await mkdir(path.join(stage, "bin"));
  await mkdir(path.join(stage, "codex-path"));
  await writeFile(path.join(stage, "codex-package.json"), JSON.stringify({
    layoutVersion: 1,
    version: fault === "manifest-version" ? "0.1.0" : version,
    target: appleSiliconTarget,
    variant: "codex",
    entrypoint: "bin/codex",
  }));
  await writeFile(path.join(stage, "bin", "codex"), `codex ${version}\n`);
  await chmod(path.join(stage, "bin", "codex"), 0o755);
  if (fault !== "missing-rg") {
    await writeFile(path.join(stage, "codex-path", "rg"), "rg\n");
    await chmod(path.join(stage, "codex-path", "rg"), 0o755);
  }
  const entries = ["codex-package.json", "bin", "codex-path"];
  if (fault === "symlink") {
    await symlink("/etc/passwd", path.join(stage, "escape"));
    entries.push("escape");
  }
  const archive = path.join(scratch, `codex-${version}-${fault ?? "ok"}.tar.gz`);
  await create({ cwd: stage, gzip: true, file: archive, portable: true }, entries);
  return await readFile(archive);
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * npm, the release checksums, and the archive, as OpenAI serves them. The
 * latest version is read on every request so a test can move it.
 */
export function openAiReleaseFetch(params: {
  latest: () => string;
  archives: ReadonlyMap<string, Buffer>;
  /** Publish a wrong checksum for this version. */
  corruptChecksumFor?: string;
}) {
  return vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    if (url === OPENAI_CODEX_LATEST_URL) {
      return Response.json({ name: "@openai/codex", version: params.latest() });
    }
    const prefix = `${OPENAI_CODEX_RELEASE_BASE_URL}/rust-v`;
    if (!url.startsWith(prefix)) return new Response(null, { status: 404 });
    const [version, asset] = url.slice(prefix.length).split("/");
    const archive = version ? params.archives.get(version) : undefined;
    if (!archive) return new Response(null, { status: 404 });
    const archiveName = `codex-package-${appleSiliconTarget}.tar.gz`;
    if (asset === OPENAI_CODEX_CHECKSUMS_NAME) {
      const digest = version === params.corruptChecksumFor ? "0".repeat(64) : sha256(archive);
      return new Response(
        `${"1".repeat(64)}  codex-app-server-package-${appleSiliconTarget}.tar.gz\n`
        + `${digest}  ${archiveName}\n`,
      );
    }
    if (asset === archiveName) {
      return new Response(new Uint8Array(archive), {
        headers: { "content-length": String(archive.length) },
      });
    }
    return new Response(null, { status: 404 });
  });
}

/** `codex --version` without launching anything: the fixture's file names its version. */
export async function probeFixtureVersion(command: string): Promise<string> {
  const [, version] = (await readFile(command, "utf8")).trim().split(" ");
  return `codex-cli ${version}\n`;
}

export function recordingProgress(): ManagedRuntimeProgressReporter & { phases: string[] } {
  const phases: string[] = [];
  return {
    phases,
    checking: () => { phases.push("checking"); },
    downloading: () => {
      phases.push("downloading");
      return () => undefined;
    },
    verifying: () => { phases.push("verifying"); },
    unpacking: () => { phases.push("unpacking"); },
    activating: () => { phases.push("activating"); },
    ready: () => { phases.push("ready"); },
    idle: () => { phases.push("idle"); },
    failed: () => { phases.push("failed"); },
  };
}
