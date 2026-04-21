import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ipcMain, nativeImage } from "electron";
import { getMainLogger } from "../log";
import type {
  ImageUploadFallbackRequest,
  ImageUploadFallbackResponse,
  ImageUploadNormalizationLogRequest,
} from "../../shared/image-normalization";
import {
  IMAGE_UPLOAD_FALLBACK_CHANNEL,
  IMAGE_UPLOAD_NORMALIZATION_LOG_CHANNEL,
} from "../../shared/ipc";

const execFile = promisify(execFileCallback);
const SIPS_PATH = "/usr/bin/sips";
const imageUploadLog = getMainLogger("pwragnt:image-upload");

type ImageFallbackDependencies = {
  createImageFromBuffer: (buffer: Buffer) => Electron.NativeImage;
  execFile: ExecFileLike;
  platform: NodeJS.Platform;
};

type ExecFileLike = (
  file: string,
  args: readonly string[],
) => Promise<{ stderr: string; stdout: string }>;

const defaultDependencies: ImageFallbackDependencies = {
  createImageFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer),
  execFile,
  platform: process.platform,
};

export function registerImageNormalizationIpcHandlers(): void {
  ipcMain.removeHandler(IMAGE_UPLOAD_FALLBACK_CHANNEL);
  ipcMain.removeHandler(IMAGE_UPLOAD_NORMALIZATION_LOG_CHANNEL);
  ipcMain.handle(
    IMAGE_UPLOAD_FALLBACK_CHANNEL,
    async (_event, request: ImageUploadFallbackRequest) =>
      await convertImageUploadFallback(request),
  );
  ipcMain.handle(
    IMAGE_UPLOAD_NORMALIZATION_LOG_CHANNEL,
    (_event, request: ImageUploadNormalizationLogRequest) => {
      imageUploadLog.info("normalized pasted image", request);
    },
  );
}

export function disposeImageNormalizationIpcHandlers(): void {
  ipcMain.removeHandler(IMAGE_UPLOAD_FALLBACK_CHANNEL);
  ipcMain.removeHandler(IMAGE_UPLOAD_NORMALIZATION_LOG_CHANNEL);
}

export async function convertImageUploadFallback(
  request: ImageUploadFallbackRequest,
  dependencies: ImageFallbackDependencies = defaultDependencies,
): Promise<ImageUploadFallbackResponse> {
  if (!isHeicMimeType(request.mimeType)) {
    throw new Error("Image upload fallback only supports HEIC/HEIF inputs.");
  }

  const inputBuffer = Buffer.from(request.data);
  const electronResult = tryConvertWithElectron(inputBuffer, dependencies);
  if (electronResult) {
    imageUploadLog.info("converted HEIC/HEIF image with Electron nativeImage", {
      fileName: request.fileName,
      inputBytes: inputBuffer.byteLength,
      mimeType: request.mimeType,
      outputBytes: electronResult.size,
      outputMimeType: electronResult.mimeType,
    });
    return electronResult;
  }

  if (dependencies.platform !== "darwin") {
    throw new Error("HEIC/HEIF conversion is only available on macOS.");
  }

  const sipsResult = await convertWithSips({
    inputBuffer,
    fileName: request.fileName,
    execFile: dependencies.execFile,
  });
  imageUploadLog.info("converted HEIC/HEIF image with sips", {
    fileName: request.fileName,
    inputBytes: inputBuffer.byteLength,
    mimeType: request.mimeType,
    outputBytes: sipsResult.size,
    outputMimeType: sipsResult.mimeType,
  });
  return sipsResult;
}

function tryConvertWithElectron(
  inputBuffer: Buffer,
  dependencies: ImageFallbackDependencies,
): ImageUploadFallbackResponse | undefined {
  let image: Electron.NativeImage;
  try {
    image = dependencies.createImageFromBuffer(inputBuffer);
  } catch {
    return undefined;
  }
  if (image.isEmpty()) {
    return undefined;
  }
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) {
    return undefined;
  }

  const output = image.toPNG();
  return {
    dataUrl: bufferToDataUrl(output, "image/png"),
    mimeType: "image/png",
    size: output.byteLength,
  };
}

async function convertWithSips(params: {
  execFile: ExecFileLike;
  fileName?: string;
  inputBuffer: Buffer;
}): Promise<ImageUploadFallbackResponse> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-image-"));
  const extension = extensionForFileName(params.fileName) ?? ".heic";
  const inputPath = path.join(tempDir, `input${extension}`);
  const outputPath = path.join(tempDir, "output.png");
  try {
    await writeFile(inputPath, params.inputBuffer);
    await params.execFile(SIPS_PATH, [
      "-s",
      "format",
      "png",
      inputPath,
      "--out",
      outputPath,
    ]);
    const output = await readFile(outputPath);
    return {
      dataUrl: bufferToDataUrl(output, "image/png"),
      mimeType: "image/png",
      size: output.byteLength,
    };
  } catch (error) {
    throw new Error(
      `HEIC/HEIF conversion failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function bufferToDataUrl(buffer: Buffer, mimeType: "image/png" | "image/jpeg"): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function extensionForFileName(fileName: string | undefined): ".heic" | ".heif" | undefined {
  const extension = path.extname(fileName ?? "").toLowerCase();
  return extension === ".heic" || extension === ".heif" ? extension : undefined;
}

function isHeicMimeType(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  return normalized === "image/heic" || normalized === "image/heif";
}
