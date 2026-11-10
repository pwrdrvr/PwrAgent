import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import { TRANSCRIPT_IMAGE_PROTOCOL_SCHEME, decodeFederatedTranscriptImageProtocolRequest, decodeFederatedTranscriptImageResponse, resolveTranscriptImageProtocolRequest, transcriptImageResponse, type TranscriptImageProtocolInstallOptions } from "../transcript-images";
export * from "../transcript-images";
export function registerTranscriptImageProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: TRANSCRIPT_IMAGE_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

export function installTranscriptImageProtocol(
  options: TranscriptImageProtocolInstallOptions = {},
): void {
  protocol.handle(TRANSCRIPT_IMAGE_PROTOCOL_SCHEME, async (request) => {
    const federatedRequest = decodeFederatedTranscriptImageProtocolRequest(
      request.url,
    );
    if (federatedRequest) {
      if (!options.resolveFederatedImage) {
        return new Response("federated transcript image transport unavailable", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      try {
        const image = decodeFederatedTranscriptImageResponse(
          await options.resolveFederatedImage(federatedRequest),
        );
        if (!image) {
          return new Response("invalid federated transcript image response", {
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
        return transcriptImageResponse(image.bytes, image.mimeType);
      } catch (error) {
        return new Response(
          error instanceof Error ? error.message : String(error),
          {
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        );
      }
    }

    const resolution = await resolveTranscriptImageProtocolRequest(request.url);
    if (!resolution.ok) {
      return new Response(resolution.message, {
        status: resolution.status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const bytes = await readFile(resolution.path);
    return transcriptImageResponse(bytes, resolution.mimeType);
  });
}
