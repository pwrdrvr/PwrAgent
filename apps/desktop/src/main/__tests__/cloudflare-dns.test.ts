import { describe, expect, it } from "vitest";
import { isUnresolvedHost, unresolvedHostMessage } from "../federation/cloudflare-dns";

describe("unresolved Cloudflare host names", () => {
  it("recognizes a failed lookup however the request library wraps it", () => {
    expect(isUnresolvedHost(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }))).toBe(true);
    // fetch reports it as the cause of a generic TypeError.
    expect(isUnresolvedHost(Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } }))).toBe(true);
    expect(isUnresolvedHost(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(false);
    expect(isUnresolvedHost("ENOTFOUND")).toBe(false);
  });

  it("names the host and the negative-cache wait", () => {
    expect(unresolvedHostMessage("federation.example.com")).toMatch(/^federation\.example\.com does not resolve on this computer yet\..*30 minutes/);
  });
});
