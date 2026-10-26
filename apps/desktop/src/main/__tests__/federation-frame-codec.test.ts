import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeFederationFramePayload,
  encodeFederationFramePayload,
  FEDERATION_COMPRESSION_PROBE_MIN_BYTES,
} from "../federation/federation-frame-codec";

describe("federation frame codec", () => {
  it("compresses repetitive protocol JSON and restores it exactly", () => {
    const json = Buffer.from(JSON.stringify({
      kind: "envelope",
      envelope: {
        kind: "response",
        result: {
          items: Array.from({ length: 100 }, (_, index) => ({
            id: `command-${index}`,
            output: "repeated command output\n".repeat(12),
            type: "commandExecution",
          })),
        },
      },
    }));

    const frame = encodeFederationFramePayload({
      json,
      compressionEnabled: true,
    });

    expect(frame.length).toBeLessThan(json.length);
    expect(frame.subarray(0, 4).toString("ascii")).toBe("PWB1");
    const decoded = decodeFederationFramePayload({
      frame,
      compressionEnabled: true,
    });
    expect(decoded.equals(json)).toBe(true);
  });

  it("leaves small and incompressible frames unwrapped", () => {
    const small = Buffer.from('{"kind":"envelope"}');
    const incompressible = randomBytes(16 * 1024);

    expect(encodeFederationFramePayload({
      json: small,
      compressionEnabled: true,
    })).toBe(small);
    expect(encodeFederationFramePayload({
      json: incompressible,
      compressionEnabled: true,
    })).toBe(incompressible);
  });

  it("probes a large frame's tail and skips compressing incompressible bytes", () => {
    const text = Buffer.from("export const value = compute(index, \"row\");\n".repeat(2_000));
    const random = randomBytes(FEDERATION_COMPRESSION_PROBE_MIN_BYTES);
    // A compressible head does not hide an incompressible tail, as in a
    // binary envelope frame: the probe sends the frame as it is.
    const tailRandom = Buffer.concat([text, random.subarray(0, 8 * 1024)]);
    expect(encodeFederationFramePayload({ json: tailRandom, compressionEnabled: true })).toBe(tailRandom);
    // An incompressible head before a compressible tail still compresses.
    const tailText = Buffer.concat([random.subarray(0, 8 * 1024), text]);
    const frame = encodeFederationFramePayload({ json: tailText, compressionEnabled: true });
    expect(frame.subarray(0, 4).toString("ascii")).toBe("PWB1");
    expect(decodeFederationFramePayload({ frame, compressionEnabled: true }).equals(tailText)).toBe(true);
  });

  it("rejects compressed frames unless the signed capability negotiated them", () => {
    const frame = encodeFederationFramePayload({
      json: Buffer.from("compressible payload ".repeat(1_000)),
      compressionEnabled: true,
      compressionThresholdBytes: 1,
    });

    expect(() => decodeFederationFramePayload({
      frame,
      compressionEnabled: false,
    })).toThrow("Federation frame compression was not negotiated");
  });

  it("enforces the logical limit before decompressing", () => {
    const frame = encodeFederationFramePayload({
      json: Buffer.from("bounded payload ".repeat(1_000)),
      compressionEnabled: true,
      compressionThresholdBytes: 1,
    });

    expect(() => decodeFederationFramePayload({
      frame,
      compressionEnabled: true,
      maxDecodedBytes: 1_024,
    })).toThrow("Federation decoded frame exceeds the configured limit");
  });

  it("rejects a forged declared length", () => {
    const frame = encodeFederationFramePayload({
      json: Buffer.from("length checked payload ".repeat(1_000)),
      compressionEnabled: true,
      compressionThresholdBytes: 1,
    });
    frame.writeUInt32BE(frame.readUInt32BE(4) - 1, 4);

    expect(() => decodeFederationFramePayload({
      frame,
      compressionEnabled: true,
    })).toThrow("Compressed federation frame length mismatch");
  });
});
