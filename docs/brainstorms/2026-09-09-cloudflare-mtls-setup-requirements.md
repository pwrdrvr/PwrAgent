# Guided Cloudflare federation admission

The operator wants an approachable Cloudflare Tunnel setup with client mTLS
admission before any request traverses the tunnel to the PwrAgent listener.

- Provide a browser entry point and precise scoped API-token instructions.
- Create dedicated tunnel, DNS, Access application, and certificate policy
  resources, with read-back auditing and deny-by-default publication order.
- Generate private CA and client certificates without purchasing a public CA
  certificate. Make client credential transfer and enrollment one workflow.
- Provide **Validate Endpoint Security**: credentialed positive control,
  certificate-free 403 checks, and evidence at the gateway showing the negative
  requests were never forwarded there. An origin-generated rejection is failure.
- Keep the setup integrated into Federation settings, with actionable progress,
  errors, certificate expiry, revocation, and connector lifecycle controls.
- Evaluate Tailscale Funnel separately against the same admission boundary.

Implementation decisions and validation evidence are recorded in
`docs/plans/2026-09-09-cloudflare-mtls-onboarding.md`.
