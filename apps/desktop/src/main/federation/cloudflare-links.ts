import type { CloudflareSetupLink } from "@pwragent/shared";

/**
 * Fixed reference table for `open-link`.
 *
 * `:account`, `:zone`, and `:application` are the only interpolation, filled
 * from setup state, so an operator lands on their own dashboard page rather
 * than a generic one. Cloudflare One lives in the unified dashboard under
 * `dash.cloudflare.com/:account/one/…`; the older `one.dash…/?to=` deep links
 * now land on its overview. Each path mirrors the dashboard's own navigation
 * (Access controls → Service credentials, Networks → Connectors).
 */
export const CLOUDFLARE_LINKS: Record<CloudflareSetupLink, string> = {
  "mtls-docs":
    "https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/mutual-tls-authentication/",
  // The plan comparison, not the docs availability note: that note currently
  // reads "Enterprise and pay-as-you-go", which contradicts the summary of the
  // pull request that added it ("requires a Zero Trust contract plan") and the
  // plan table's own mTLS row. Send operators to the table.
  "mtls-plans": "https://www.cloudflare.com/sase/products/access/",
  "signature-algorithms":
    "https://developers.cloudflare.com/ssl/client-certificates/byo-ca/",
  "service-token-docs":
    "https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/",
  "oauth-docs":
    "https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/",
  "github-login-docs":
    "https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/",
  // Mutual TLS is a tab of the service credentials page.
  "dash-mtls": "https://dash.cloudflare.com/:account/one/access-controls/service-credentials",
  "dash-service-tokens": "https://dash.cloudflare.com/:account/one/access-controls/service-credentials",
  // The endpoint's own application; its policies are app-scoped, so they are
  // managed there rather than on the account's reusable Policies page.
  "dash-endpoint-application":
    "https://dash.cloudflare.com/:account/one/access-controls/apps/self-hosted/:application/edit?tab=basic-info",
  "dash-tunnels": "https://dash.cloudflare.com/:account/one/networks/connectors",
  "dash-login-methods": "https://dash.cloudflare.com/:account/one/integrations/identity-providers",
  "dash-zone-overview": "https://dash.cloudflare.com/:account/:zone",
  "cloudflared-update-docs":
    "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/update-cloudflared/",
};

/**
 * A link table entry with its placeholders filled, or the nearest page that
 * needs none of them. Only a well-formed id is interpolated: a draft is
 * unvalidated, and a deep link with a bad placeholder 404s, which is worse than
 * a list page.
 */
export function resolveCloudflareLink(
  template: string,
  ids: { accountId?: string; zoneId?: string; applicationId?: string },
): string {
  const hex = (value: string | undefined) => value && /^[a-f0-9]{32}$/.test(value) ? value : undefined;
  const account = hex(ids.accountId);
  const zone = hex(ids.zoneId);
  const application = ids.applicationId
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ids.applicationId)
    ? ids.applicationId
    : undefined;
  if (template.includes(":application") && !application) {
    template = "https://dash.cloudflare.com/:account/one/access-controls/apps";
  }
  if ((template.includes(":account") && !account) || (template.includes(":zone") && !zone)) {
    return "https://dash.cloudflare.com/";
  }
  return template
    .replace(":account", account ?? "")
    .replace(":zone", zone ?? "")
    .replace(":application", application ?? "");
}
