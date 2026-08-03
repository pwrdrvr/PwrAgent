import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ComposerPdfPreviewReference,
  InspectComposerPdfReferencesRequest,
  InspectComposerPdfReferencesResponse,
  RenderComposerPdfPreviewRequest,
  RenderComposerPdfPreviewResponse,
} from "@pwragent/shared";
import { renderComposerPdfPreview } from "./composer-pdf-preview";

const PDF_MAGIC = Buffer.from("%PDF-");
const MAX_COMPOSER_PDF_REFERENCE_PATHS = 20;
const MAX_COMPOSER_PDF_PREVIEW_FILE_BYTES = 64 * 1024 * 1024;

type ComposerPdfPreviewAuthorization = ComposerPdfPreviewReference;

type FileIdentityStats = {
  ctimeMs: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
};

function fileIdentity(stats: FileIdentityStats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
}

function normalizeScopeId(scopeId: string): string {
  const normalized = scopeId.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error("Composer preview scope is invalid.");
  }
  return normalized;
}

function explicitLocalPaths(paths: string[]): string[] {
  return [...new Set(
    paths
      .map((candidate) => candidate.trim())
      .filter((candidate) => candidate && path.isAbsolute(candidate)),
  )]
    .sort()
    .slice(0, MAX_COMPOSER_PDF_REFERENCE_PATHS);
}

function inspectPdfFile(filePath: string): { fileIdentity: string } | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "r");
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) {
      return undefined;
    }

    const header = Buffer.alloc(PDF_MAGIC.byteLength);
    const bytesRead = fs.readSync(descriptor, header, 0, header.byteLength, 0);
    if (bytesRead !== PDF_MAGIC.byteLength || !header.equals(PDF_MAGIC)) {
      return undefined;
    }
    return { fileIdentity: fileIdentity(stats) };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function readAuthorizedPdfFile(
  authorization: ComposerPdfPreviewAuthorization,
): { data: Buffer; fileIdentity: string } {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(authorization.path, "r");
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) {
      throw new Error("The selected PDF is no longer a regular file.");
    }
    if (before.size > MAX_COMPOSER_PDF_PREVIEW_FILE_BYTES) {
      throw new Error("This PDF is too large to preview locally.");
    }

    const header = Buffer.alloc(PDF_MAGIC.byteLength);
    const bytesRead = fs.readSync(descriptor, header, 0, header.byteLength, 0);
    if (bytesRead !== PDF_MAGIC.byteLength || !header.equals(PDF_MAGIC)) {
      throw new Error("The selected file is no longer a PDF.");
    }

    const currentFileIdentity = fileIdentity(before);
    if (currentFileIdentity !== authorization.fileIdentity) {
      throw new Error("The selected PDF changed. Use Preview again.");
    }

    // The header read uses an explicit offset, leaving this descriptor at zero.
    // Reading through it closes the path-level TOCTOU gap while pdfjs renders.
    const data = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      data.byteLength !== after.size
      || currentFileIdentity !== fileIdentity(after)
    ) {
      throw new Error("The selected PDF changed while its preview was loading.");
    }
    return { data, fileIdentity: currentFileIdentity };
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

/**
 * Keeps only in-memory capabilities for PDFs the Composer explicitly named.
 * Rendering accepts a capability, never a filesystem path, so a model-looking
 * string typed into the editor cannot become a local PDF read or render.
 */
export class ComposerPdfPreviewReferences {
  readonly #authorizationsByScope = new Map<
    string,
    Map<string, ComposerPdfPreviewAuthorization>
  >();

  inspect(
    request: InspectComposerPdfReferencesRequest,
  ): InspectComposerPdfReferencesResponse {
    const scopeId = normalizeScopeId(request.scopeId);
    const previous = this.#authorizationsByScope.get(scopeId);
    const next = new Map<string, ComposerPdfPreviewAuthorization>();
    const references: ComposerPdfPreviewReference[] = [];

    for (const filePath of explicitLocalPaths(request.paths)) {
      const inspected = inspectPdfFile(filePath);
      if (!inspected) {
        continue;
      }
      const reusable = [...(previous?.values() ?? [])].find(
        (authorization) =>
          authorization.path === filePath
          && authorization.fileIdentity === inspected.fileIdentity,
      );
      const authorization: ComposerPdfPreviewAuthorization = reusable ?? {
        fileIdentity: inspected.fileIdentity,
        path: filePath,
        previewId: randomUUID(),
      };
      next.set(authorization.previewId, authorization);
      references.push(authorization);
    }

    if (next.size > 0) {
      this.#authorizationsByScope.set(scopeId, next);
    } else {
      this.#authorizationsByScope.delete(scopeId);
    }
    return { references };
  }

  async render(
    request: RenderComposerPdfPreviewRequest,
  ): Promise<RenderComposerPdfPreviewResponse> {
    const scopeId = normalizeScopeId(request.scopeId);
    const authorization = this.#authorizationsByScope
      .get(scopeId)
      ?.get(request.previewId);
    if (!authorization) {
      throw new Error("This PDF is no longer an active Composer reference.");
    }

    const file = readAuthorizedPdfFile(authorization);
    if (request.knownFileIdentity === file.fileIdentity) {
      return { fileIdentity: file.fileIdentity, unchanged: true };
    }

    return {
      ...(await renderComposerPdfPreview({ data: file.data })),
      fileIdentity: file.fileIdentity,
      unchanged: false,
    };
  }

  clear(): void {
    this.#authorizationsByScope.clear();
  }
}
