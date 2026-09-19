import { describe, expect, it } from "vitest";
import { CLOUDFLARE_LINKS, cloudflareTokenTemplateUrl, resolveCloudflareLink } from "../federation/cloudflare-links";

const accountId = "0123456789abcdef0123456789abcdef";
const zoneId = "fedcba9876543210fedcba9876543210";
const applicationId = "80b03c0f-e0d2-437c-a3fa-79f649823d90";

describe("Cloudflare dashboard links", () => {
  it("opens pages in the unified dashboard for this account", () => {
    expect(resolveCloudflareLink(CLOUDFLARE_LINKS["dash-service-tokens"], { accountId }))
      .toBe(`https://dash.cloudflare.com/${accountId}/one/access-controls/service-credentials`);
    expect(resolveCloudflareLink(CLOUDFLARE_LINKS["dash-tunnels"], { accountId }))
      .toBe(`https://dash.cloudflare.com/${accountId}/one/networks/connectors`);
    expect(resolveCloudflareLink(CLOUDFLARE_LINKS["dash-zone-overview"], { accountId, zoneId }))
      .toBe(`https://dash.cloudflare.com/${accountId}/${zoneId}`);
    // The retired deep-link host drops its target path and lands on the overview.
    for (const template of Object.values(CLOUDFLARE_LINKS)) expect(template).not.toContain("one.dash.cloudflare.com");
  });

  it("opens the endpoint's own application, or the application list without one", () => {
    expect(resolveCloudflareLink(CLOUDFLARE_LINKS["dash-endpoint-application"], { accountId, applicationId }))
      .toBe(`https://dash.cloudflare.com/${accountId}/one/access-controls/apps/self-hosted/${applicationId}/edit?tab=basic-info`);
    expect(resolveCloudflareLink(CLOUDFLARE_LINKS["dash-endpoint-application"], { accountId }))
      .toBe(`https://dash.cloudflare.com/${accountId}/one/access-controls/apps`);
    expect(resolveCloudflareLink(CLOUDFLARE_LINKS["dash-endpoint-application"], { accountId, applicationId: "../../billing" }))
      .toBe(`https://dash.cloudflare.com/${accountId}/one/access-controls/apps`);
  });

  it("scopes the API token to the first well-formed account and zone it knows", () => {
    const scoped = new URL(cloudflareTokenTemplateUrl([undefined, "not-an-id", accountId], [zoneId]));
    expect(scoped.searchParams.get("accountId")).toBe(accountId);
    expect(scoped.searchParams.get("zoneId")).toBe(zoneId);
    expect(JSON.parse(scoped.searchParams.get("permissionGroupKeys")!)).toContainEqual({ key: "argotunnel", type: "edit" });
    const open = new URL(cloudflareTokenTemplateUrl(["", undefined], ["zone"]));
    expect(open.searchParams.get("accountId")).toBe("*");
    expect(open.searchParams.get("zoneId")).toBe("all");
  });

  it("falls back to the dashboard root rather than interpolating an unvalidated id", () => {
    expect(resolveCloudflareLink(CLOUDFLARE_LINKS["dash-tunnels"], { accountId: "not-an-account" })).toBe("https://dash.cloudflare.com/");
    expect(resolveCloudflareLink(CLOUDFLARE_LINKS["dash-zone-overview"], { accountId })).toBe("https://dash.cloudflare.com/");
    expect(resolveCloudflareLink(CLOUDFLARE_LINKS["cloudflared-update-docs"], {}))
      .toBe("https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/update-cloudflared/");
  });
});
