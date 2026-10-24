import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib";

/**
 * Signed session capability for application-layer Brotli frames. Compression
 * must happen before optional Noise encryption; WebSocket compression sees
 * only the resulting AES-GCM ciphertext in Noise mode.
 */
export const FEDERATION_BROTLI_CAPABILITY = "transport_brotli" as const;

/** Small streamed notifications cost more CPU than bandwidth when compressed. */
export const FEDERATION_COMPRESSION_THRESHOLD_BYTES = 4 * 1024;

/**
 * Logical-message ceiling after decompression. This is deliberately separate
 * from ws maxPayload, which limits the compressed/encrypted wire message.
 */
export const FEDERATION_MAX_DECODED_FRAME_BYTES = 64 * 1024 * 1024;

// "PWB1" identifies PwrAgent's first Brotli application-frame encoding. The
// following uint32 is the authenticated plaintext length, allowing rejection
// before decompression allocates attacker-controlled output.
const FEDERATION_BROTLI_HEADER = Buffer.from("PWB1", "ascii");
const FEDERATION_BROTLI_HEADER_BYTES = 8;

export function encodeFederationFramePayload(params: {
  json: Buffer;
  compressionEnabled: boolean;
  compressionThresholdBytes?: number;
}): Buffer {
  if (
    !params.compressionEnabled
    || params.json.length <
      (params.compressionThresholdBytes
        ?? FEDERATION_COMPRESSION_THRESHOLD_BYTES)
  ) {
    return params.json;
  }

  const compressed = brotliCompressSync(params.json, {
    params: {
      // Quality 1 is the low-latency mode. Federation compresses discrete
      // messages, not one context-carrying stream, so every frame remains
      // independently decodable and small notifications stay uncompressed.
      [zlibConstants.BROTLI_PARAM_QUALITY]: 1,
    },
  });
  if (compressed.length + FEDERATION_BROTLI_HEADER_BYTES >= params.json.length) {
    return params.json;
  }

  const header = Buffer.allocUnsafe(FEDERATION_BROTLI_HEADER_BYTES);
  FEDERATION_BROTLI_HEADER.copy(header);
  header.writeUInt32BE(params.json.length, FEDERATION_BROTLI_HEADER.length);
  return Buffer.concat([header, compressed]);
}

export function decodeFederationFramePayload(params: {
  frame: Buffer;
  compressionEnabled: boolean;
  maxDecodedBytes?: number;
}): Buffer {
  const maxDecodedBytes =
    params.maxDecodedBytes ?? FEDERATION_MAX_DECODED_FRAME_BYTES;
  const compressed =
    params.frame.length >= FEDERATION_BROTLI_HEADER_BYTES
    && params.frame.subarray(0, FEDERATION_BROTLI_HEADER.length).equals(
      FEDERATION_BROTLI_HEADER,
    );
  if (!compressed) {
    assertDecodedSize(params.frame.length, maxDecodedBytes);
    return params.frame;
  }
  if (!params.compressionEnabled) {
    throw new FederationFrameCompressionError(
      "Federation frame compression was not negotiated",
    );
  }

  const declaredBytes = params.frame.readUInt32BE(
    FEDERATION_BROTLI_HEADER.length,
  );
  assertDecodedSize(declaredBytes, maxDecodedBytes);
  let decoded: Buffer;
  try {
    decoded = brotliDecompressSync(
      params.frame.subarray(FEDERATION_BROTLI_HEADER_BYTES),
      { maxOutputLength: maxDecodedBytes },
    );
  } catch {
    throw new FederationFrameCompressionError(
      "Invalid compressed federation frame",
    );
  }
  if (decoded.length !== declaredBytes) {
    throw new FederationFrameCompressionError(
      "Compressed federation frame length mismatch",
    );
  }
  return decoded;
}

function assertDecodedSize(size: number, maxDecodedBytes: number): void {
  if (size > maxDecodedBytes) {
    throw new FederationFrameCompressionError(
      "Federation decoded frame exceeds the configured limit",
    );
  }
}

export class FederationFrameCompressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FederationFrameCompressionError";
  }
}
