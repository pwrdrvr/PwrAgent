import fc from "fast-check";
import { expect, it, vi } from "vitest";
import {
  isLegacyPwrSnapMediaUrl,
  transcriptImageUnavailableReason,
} from "../transcript-image-sources";

// Shared has no DOM or Node types. Use the runtime's WHATWG parser as the oracle.
declare const URL: new (value: string) => {
  origin: string;
  pathname: string;
  protocol: string;
  host: string;
  username: string;
  password: string;
};

const legacyUrls = fc.tuple(
  fc.constantFrom("http://", "HTTPS://", "hTt\tP:\\\\", "http:"),
  fc.constantFrom("127.0.0.1", "127.1", "0x7f.1", "2130706433", "%31%32%37.0.0.1", "localhost"),
  fc.constantFrom(":51729", ":051729", ":51728", ""),
  fc.constantFrom("/media", "/tmp/%2e%2e/media", "\\tmp\\..\\media", "/%6dedia", "/media/"),
  fc.string(),
).map(([scheme, host, port, path, query]) =>
  ` \u0000${scheme}${host}${port}${path}?${encodeURIComponent(query)}#fragment\n`);

const imageUrls = fc.oneof(
  legacyUrls,
  fc.tuple(fc.constantFrom("data:", " DATA:", "da\tta:", "pwrsnap://capture/", "mcp-resource:"), fc.string())
    .map(([prefix, suffix]) => `${prefix}${suffix}`),
  fc.constantFrom(
    "data://127.0.0.1:51729/media",
    "data:image/png;base64,",
    "blob:http://127.0.0.1:51729/media",
    "javascript:alert(1)",
    "pwragent-image://file/image",
    "file:///tmp/image.png",
    "https://example.org/image.png",
    " PW\tRSNAP://capture/image ",
    "pwrsnap://user:password@capture/image",
    "http://[invalid]/media",
  ),
  fc.string(),
);

it("agrees with WHATWG URL classification for transcript image fallbacks", () => {
  fc.assert(fc.property(imageUrls, fc.constantFrom(undefined, "", "Owner could not read the image."), (url, reason) => {
    let parsed: InstanceType<typeof URL> | undefined;
    try { parsed = new URL(url); } catch { /* Invalid inputs have no URL classification. */ }
    const legacy = parsed?.origin === "http://127.0.0.1:51729" && parsed.pathname === "/media";
    const resource = url.length <= 2048 && parsed?.protocol === "pwrsnap:"
      && Boolean(parsed.host) && !parsed.username && !parsed.password;

    expect(isLegacyPwrSnapMediaUrl(url)).toBe(legacy);
    expect(transcriptImageUnavailableReason({ url, unavailableReason: reason }))
      .toBe(reason || (legacy || resource ? "PwrSnap image unavailable." : undefined));
  }));
});

it.each([
  [2047, "PwrSnap image unavailable."],
  [2048, "PwrSnap image unavailable."],
  [2049, undefined],
])("applies the fallback length limit to a %i-character PwrSnap resource URL", (length, reason) => {
  const prefix = "pwrsnap://capture/";
  const url = prefix + "a".repeat(length - prefix.length);
  expect(transcriptImageUnavailableReason({ url })).toBe(reason);
});

it("keeps the older-peer fallback for normalized loopback URLs with long signatures", () => {
  const url = ` \u0000Ht\tTP:\\\\0x7f.1:051729\\tmp\\%2E%2e\\media?signature=${"a".repeat(2048)}#fragment `;
  expect(transcriptImageUnavailableReason({ url })).toBe("PwrSnap image unavailable.");
});

it("does not parse a large inline data URL to decide PwrSnap availability", () => {
  const url = `data:image/png;base64,${"A".repeat(2048)}`;
  let parses = 0;
  vi.stubGlobal("URL", new Proxy(URL, {
    construct(target, args, newTarget) {
      parses += 1;
      return Reflect.construct(target, args, newTarget);
    },
  }));
  try {
    expect(transcriptImageUnavailableReason({ url })).toBeUndefined();
    expect(parses).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
