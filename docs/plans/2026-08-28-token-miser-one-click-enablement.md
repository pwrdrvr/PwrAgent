# Token Miser one-click enablement plan

Status: PwrAgent implementation complete; custom Codex PR and first signed
release pending

## Decisions

- Reuse the managed-agent release safety model already proven by Managed Grok.
- Keep the Token Miser availability setting as the sole outer owner of managed
  Codex acquisition, update checks, runtime selection, and Token Miser tools.
- Select the managed runtime by policy while the gate is on instead of writing
  its versioned path into the operator's Codex path preference.
- Require the custom capability before activation and do not fall back to an
  arbitrary newer upstream Codex while the gate remains enabled.
- Apply runtime changes only after active Codex turns have settled.
- Remove the external hook-approval ceremony through a scoped Codex protocol
  capability, never a general hook-trust bypass.

## Work

1. Publish a fresh-main custom Codex follow-up with the scoped activation
   capability and signed release artifact contract.
2. Add a managed Codex release installer with checksum, signature, version,
   companion-binary, atomic activation, cached fallback, and pruning coverage.
3. Make desktop Codex resolution prefer the managed command whenever Token
   Miser availability is enabled.
4. Add gate-scoped update checks and safe process switching.
5. Surface installation and activation readiness in Experimental settings and
   remove manual binary and `/hooks` instructions.
6. Validate off-state network silence, selection precedence, failed-first-
   install rollback, cached offline startup, update activation, and disable
   behavior.

## Dependencies

- The exact capability and minimum eligible release tag come from the custom
  Codex follow-up PR.
- PwrAgent can land installer and selection code before the first compatible
  release is published, but the feature cannot pass end-to-end acceptance
  until that signed release exists.

## Progress

- PwrAgent now downloads, verifies, caches, and durably selects the managed
  Codex runtime only while the experimental availability gate is enabled.
- Release verification requires the last-uploaded completion marker, the
  closed update-manifest schema, matching checksums and sizes, a Sigstore v0.3
  SLSA statement, the exact tagged GitHub Actions workflow identity, source
  repository/commit/ref claims, certificate transparency, and Rekor inclusion.
- Native app-server negotiation activates Token Miser per thread and suppresses
  the legacy plugin path whenever the managed capability is present.
- Runtime updates switch only at an idle Codex boundary. Turning the gate off
  stops update checks and restores normal Codex selection.
- Settings reports installation and activation readiness without asking the
  operator to choose a binary or approve a hook.
- Focused unit/integration coverage, desktop typecheck, production build,
  dependency boundaries, and lint validation pass. The custom Codex follow-up
  has separately passed its native button-negotiation E2E; the cross-repository
  release acceptance remains pending publication of the first signed release.
