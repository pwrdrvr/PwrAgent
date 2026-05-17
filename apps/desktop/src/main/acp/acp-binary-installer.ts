import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildBinaryLaunchDescriptor,
  type AcpLaunchDescriptor,
} from "./acp-launch-descriptor.js";
import type {
  AcpBinaryPlatformDistribution,
  AcpRegistryAgent,
} from "./acp-registry-types.js";

const execFile = promisify(execFileCallback);

export type AcpArchiveDownloader = (params: {
  archiveUrl: string;
  destinationPath: string;
}) => Promise<void>;

export type AcpArchiveExtractor = (params: {
  archivePath: string;
  destinationDir: string;
}) => Promise<void>;

export type AcpBinaryInstallResult =
  | {
      ok: true;
      installPath: string;
      launchDescriptor: AcpLaunchDescriptor;
    }
  | {
      ok: false;
      unavailableReason: string;
    };

export async function installAcpBinary(params: {
  agent: AcpRegistryAgent;
  distribution: AcpBinaryPlatformDistribution;
  installRoot: string;
  downloader?: AcpArchiveDownloader;
  extractor?: AcpArchiveExtractor;
}): Promise<AcpBinaryInstallResult> {
  const installName = sanitizeInstallName(params.agent.id);
  const stagingDir = path.join(params.installRoot, ".staging", `${installName}-${randomUUID()}`);
  const installDir = path.join(params.installRoot, installName);
  const archivePath = path.join(stagingDir, archiveFileName(params.distribution.archiveUrl));
  const downloader = params.downloader ?? defaultDownloader;
  const extractor = params.extractor ?? defaultExtractor;

  try {
    await mkdir(stagingDir, { recursive: true });
    await downloader({
      archiveUrl: params.distribution.archiveUrl,
      destinationPath: archivePath,
    });
    await extractor({ archivePath, destinationDir: stagingDir });
    const command = resolveCommandPath(stagingDir, params.distribution.command);
    await access(command, fsConstants.F_OK);

    await rm(installDir, { recursive: true, force: true });
    await mkdir(path.dirname(installDir), { recursive: true });
    await rename(stagingDir, installDir);

    return {
      ok: true,
      installPath: installDir,
      launchDescriptor: buildBinaryLaunchDescriptor({
        backendId: params.agent.backendId,
        registryId: params.agent.id,
        command: path.join(installDir, path.relative(stagingDir, command)),
        args: params.distribution.args,
        env: params.distribution.env,
        installPath: installDir,
      }),
    };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    return {
      ok: false,
      unavailableReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveCommandPath(stagingDir: string, command: string): string {
  const relativeCommand = command.replace(/^\.?[\\/]/, "");
  const resolved = path.resolve(stagingDir, relativeCommand);
  const relative = path.relative(stagingDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("binary command escapes install directory");
  }
  return resolved;
}

function archiveFileName(archiveUrl: string): string {
  try {
    return path.basename(new URL(archiveUrl).pathname) || "agent-archive";
  } catch {
    return "agent-archive";
  }
}

function sanitizeInstallName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

async function defaultDownloader(params: {
  archiveUrl: string;
  destinationPath: string;
}): Promise<void> {
  const response = await globalThis.fetch(params.archiveUrl);
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(params.destinationPath, buffer);
}

async function defaultExtractor(params: {
  archivePath: string;
  destinationDir: string;
}): Promise<void> {
  if (params.archivePath.endsWith(".tar.gz") || params.archivePath.endsWith(".tgz")) {
    await execFile("tar", ["-xzf", params.archivePath, "-C", params.destinationDir]);
    return;
  }
  if (params.archivePath.endsWith(".zip")) {
    await execFile("unzip", ["-q", params.archivePath, "-d", params.destinationDir]);
    return;
  }
  throw new Error("unsupported archive format");
}
