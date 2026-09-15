# Cloudflare mTLS federation setup

## Outcome

Settings guides an operator through a scoped Cloudflare API token, a dedicated
hostname, private CA and client certificate creation, protected tunnel
provisioning, and an origin-correlated admission test. Existing endpoint
credential entry remains available. Tailscale Funnel is evaluated separately.

## Decisions

- Use Cloudflare Access Service Auth with a mandatory valid certificate.
  Cloudflare documents self-generated CA certificates; no purchased CA is needed.
- Create only dedicated resources. Refuse conflicting DNS or Access applications;
  do not rewrite an operator's existing policy. Publish DNS after policy setup.
- Keep API credentials in memory for the setup session. Store CA/client keys and
  connector credentials using encrypted profile storage. Never send CA keys to
  Cloudflare or put connector tokens in command-line arguments.
- Audit read-back policy, CA hostname association, DNS, and tunnel ingress.
  Unknown policy shapes or competing paths cannot earn a passing audit.
- A security pass requires a credentialed positive control reaching the same
  gateway, credential-free HTTP and WebSocket-upgrade probes returning 403 at
  Cloudflare, and absence of those probe IDs at the gateway. No redirect following,
  cached result, timeout, or ordinary application rejection counts as success.
- Probes are bounded in-memory observations scoped to an explicit test. They
  introduce no streamed-event persistence or idle SQLite writes.
- Certificate issuance uses a cross-platform X.509 library with Node WebCrypto.
  Each exported client gets its own key and expiry; CA keys never leave the host.

## Sources

- https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/mutual-tls-authentication/
- https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/
- https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/certificates/methods/create/

## Progress

- Workspace refreshed to ab922ad5f; Tailscale research delegated.
- Cloudflare documents token template links, Access certificate uploads, and
  private CA issuance. Live account entitlement and rejection still need testing.
- Implemented guided Federation Settings, dedicated resource provisioning,
  strict policy read-back, encrypted profile CA/connector storage, and process-owned
  cloudflared lifecycle. Client bundles use scrypt + AES-256-GCM and contain only a
  leaf certificate/key, endpoint, and one-hour invite. Client certificates last
  90 days; validation renews its private test certificate near expiry.
- Validation covers HTTPS and WebSocket upgrade requests on the endpoint itself.
  If the positive response issues cookies, also test certificate-free cookie reuse.
  Probe observers exist only during explicit validation, before HTTP/WebSocket
  application authentication. They have no SQLite writes or idle timers: 0 MB/day
  idle write projection. Issuance/import reuse existing enrollment/secret writes;
  all new setup state uses one atomically replaced encrypted profile file.
- The final focused run passed 50 certificate/provisioning/security, real
  HTTP/upgrade transport, and onboarding UI tests, including issuance/revocation.
  An earlier regression run passed 143 existing federation tests. Workspace
  typecheck, ESLint (warnings only), boundary,
  license, and color checks passed. Desktop production build passed.
- Inspected headless component previews for initial setup and published gateway,
  including narrow light mode. No page errors or horizontal overflow.
- Not run: live Cloudflare API provisioning, account entitlement checks, real edge
  rejection, and a two-machine encrypted-client-bundle import. These require the
  operator's chosen domain and a scoped token entered into the new UI.

## Operational limits

- A domain active on Cloudflare and a configured Zero Trust account are required.
  The token link prefills documented permission keys; tunnel and mTLS permissions
  are listed for the operator to add explicitly. No paid plan is purchased.
- cloudflared installation is operator-managed through the linked official
  installation guide. The app owns its connector process, not a system service.
- API tokens last only for the current process session. Auditing and certificate
  issuance/revocation require reconnecting a token after restart.
- Only dedicated hostnames are provisioned. Competing wildcard/path-specific
  Access applications, additional policies, or existing DNS records fail closed.
- A partial provisioning attempt retains encrypted keys and known resource IDs
  for resumption. If an API mutation succeeds but its response is lost, Cloudflare
  may contain an unrecorded resource; conflict checks stop rather than adopt it.
  Inspect those resources in Cloudflare before retrying. Automatic deletion and
  adoption of preexisting tunnels are outside this implementation.
- Certificate revocation changes admission for new connections. Revoke the
  PwrAgent peer separately to terminate an already established federation session.
- A security result is an observation at its timestamp, not continuous assurance.
  It cannot guarantee behavior after external Cloudflare policy changes.
