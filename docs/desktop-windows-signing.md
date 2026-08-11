# Windows Code Signing (Azure Artifact Signing)

PwrAgent signs the Windows NSIS installer with **Azure Artifact Signing** —
Microsoft's cloud signing service, originally released as **Trusted Signing**.
Both names refer to the same product, and the tooling has not caught up with the
rename: the Azure portal now says "Artifact Signing Account" and the RBAC roles
are named `Artifact Signing *`, while electron-builder's option is still
`win.azureSignOptions` and the PowerShell module it installs is still
`TrustedSigning`. Expect to search for **both** names in docs and the portal.

It needs no hardware token, works on GitHub-hosted runners, removes SmartScreen
"unknown publisher" warnings, and is the cheapest option (~$9.99/mo for up to
5,000 signatures).

Release signing is **fail closed**: the protected release job passes
`--require-signing`, so missing or partial configuration stops the release
instead of producing an unsigned installer. Label-gated PR installer builds
(`ci:windows-package`) are intentionally left **unsigned**. They exercise the
same build and NSIS packaging path without exposing credentials or consuming
signature quota. There is no PR label that requests signing credentials.

## Current configuration (PwrDrvr LLC)

Provisioned in the `PwrDrvr Azure` subscription, resource group
`rg-pwrdrvr-signing`, region **East US**. None of these are secret — the
publisher name and certificate subject are embedded in every signed installer.

> Transcribed 2026-08; the Azure portal is the source of truth. Re-check here
> after any renewal, since a renewed profile can change the values below.

| GitHub **variable** | Value |
|---|---|
| `WIN_AZURE_SIGN_ACCOUNT` | `pwrdrvrsigning` |
| `WIN_AZURE_SIGN_ENDPOINT` | `https://eus.codesigning.azure.net/` |
| `WIN_AZURE_SIGN_PUBLISHER_NAME` | `PwrDrvr LLC` |
| `WIN_AZURE_SIGN_PROFILE` | `pwrdrvr-public-trust` |

Certificate subject: `CN=PwrDrvr LLC, O=PwrDrvr LLC, L=Aberdeen, S=New Jersey, C=US`.
`WIN_AZURE_SIGN_PUBLISHER_NAME` must equal the **CN** exactly.

The three `AZURE_*` GitHub **secrets** come from the Entra app registration
(`pwragent-release-signing`) — see step 3.

## How the pieces connect

- `apps/desktop/electron-builder.yml` — `win` target (NSIS x64). No signing
  config lives here; it's injected per-build so unsigned builds keep working.
- `apps/desktop/scripts/release.mjs` (`--win`) — `resolveWindowsAzureSigning()`
  reads the env below and, when complete, passes
  `--config.win.azureSignOptions.*` to electron-builder. electron-builder 26
  then auto-installs the `TrustedSigning` PowerShell module on the runner and
  invokes `Invoke-TrustedSigning`.
- `.github/workflows/release.yml` (`windows-prepare` and `windows-sign` jobs,
  release tags only) — prepares the complete Windows stage and resolved
  electron-builder toolchain without credentials, records its SHA-256 digest,
  and uploads it as an artifact. The protected job downloads and verifies that
  exact artifact, installs `TrustedSigning`, and performs signing-aware NSIS
  packaging without checking out source or installing project dependencies.
- `scripts/release/install-trusted-signing.ps1` — installs the same module
  electron-builder expects in PowerShell 7 and verifies that
  `Invoke-TrustedSigning` resolves in a fresh `pwsh -NoProfile -NonInteractive`
  process before signing starts. This is a post-install assertion inside the
  protected release job, not a separate PR preflight.

Windows cannot safely defer only the final `.exe` signature: electron-builder
signs the application executables, generated uninstaller, and final installer
during NSIS packaging. The prepared-stage boundary therefore keeps compilation,
dependency resolution, and lifecycle scripts outside the protected environment,
while the protected job retains only the irreducible packaging work that invokes
the signing service.

## One-time setup

### 1. Eligibility + subscription
Azure Artifact Signing requires a **paid** Azure subscription (no free/trial)
and one of: a **US/Canada org with 3+ years** verifiable history, an
**individual developer in the US/Canada**, or an **org in the EU/UK**.
PwrDrvr LLC validated on the US org path.

### 2. Create the signing resources (Azure portal)
1. Create an **Artifact Signing account**. Its region determines the
   **endpoint** (`https://<region>.codesigning.azure.net/`), shown as
   **Account URI** on the account overview — use it verbatim, trailing slash
   included.
2. Complete **Identity Validation** on the account. This is asynchronous (days,
   possibly with document requests) and gates everything after it. The approved
   **CommonName** becomes `publisherName` and is the publisher users see in the
   SmartScreen prompt.
3. Create a **Certificate profile** under the account, selecting the completed
   identity validation.

   > **Pick profile type `Public Trust`.** The adjacent `Public Trust Test`
   > option signs successfully and `signtool` reports a valid signature, but it
   > chains to a *test* root nobody trusts — so every user still gets the
   > SmartScreen warning. Easy to select by accident and not notice until a user
   > reports it.

   Whatever you name the profile is `WIN_AZURE_SIGN_PROFILE` verbatim.

### 3. Create a service principal for CI
1. Microsoft Entra ID → **App registrations** → New registration.
   - **Name**: free-form, maps to no config (we use `pwragent-release-signing`).
   - **Supported account types**: single tenant.
   - **Redirect URI**: leave blank — this uses the non-interactive
     client-credentials flow.
   - **API permissions**: none. Access comes solely from the RBAC role in the
     next step; the API permissions blade is a dead end here.
2. **Certificates & secrets** → New client secret. Copy the **`Value`** column
   (not `Secret ID`) — it is displayed **once**, and is unrecoverable after you
   navigate away. Max expiry is 24 months; the dropdown often defaults to 180
   days.
3. On the signing account → **Access control (IAM)** → Add role assignment →
   **`Artifact Signing Certificate Profile Signer`** (search `Artifact Signing`;
   this role was `Trusted Signing Certificate Profile Signer` before the
   rename) → assign to the app registration.
   - On the **Members** step choose **User, group, or service principal**, not
     Managed identity — app registrations surface as service principals.
   - The `Artifact Signing Identity Verifier` role, which the account owner uses
     to complete identity validation, does **not** grant signing. This is a
     separate grant, and skipping it is the most common setup failure: every
     value looks correct and signing fails with a 403.

### 4. Add the GitHub configuration
These live in the **`windows-signing` environment** (GitHub → repo **Settings →
Environments → `windows-signing`**), not at repo scope. Only the `windows-sign`
job declares `environment: windows-signing`, and it injects the credential
values only into the signing-aware packaging step. Dropping the environment or
any value fails because that step uses `--require-signing`.

Scoping to an environment (rather than repo-wide secrets) keeps the signing
credentials out of every other workflow and job. Consider adding a deployment
protection rule limiting the environment to the release tag pattern.

**Variables** — the four `WIN_AZURE_SIGN_*` values in the table above.

**Secrets** (service-principal credentials):
| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_CLIENT_SECRET` | Client secret **Value** |

Once all seven are set, the next release tag produces a **signed** installer.

## Failure modes

`resolveWindowsAzureSigning()` checks only that the variables are *present*, not
that they are valid, which splits behavior three ways:

`resolveWindowsAzureSigning()` treats "none configured" as an intentional
unsigned build and anything short of fully configured as an error, so a release
can never quietly ship unsigned:

| Condition | Result |
|---|---|
| None of the seven set | **Unsigned** — intended for local, sandbox, and label-gated PR builds that omit `--require-signing` |
| Some but not all `WIN_AZURE_SIGN_*` set | **Build fails** — a subset is always a typo, never intent |
| All four config vars set, any `AZURE_*` missing | **Build fails** — signing was requested, credentials absent |
| Protected release build where nothing resolved (job missing `environment: windows-signing`) | **Build fails** — `--require-signing` |
| All seven set, credential expired/invalid or RBAC role missing | **Build fails** at the signing call |

The fourth row is why the release workflow passes `--require-signing`: a job
outside the environment reads every value as empty, which is otherwise
indistinguishable from an intentional unsigned build. Local and PR builds omit
the flag and stay unsigned.

## Certificate lifetime and renewal

**The certificate profile's *Expiry date* is always a couple of days out, and
that is not a problem.** Artifact Signing issues short-lived certificates and
reissues them on a rolling basis; the near-term date in the portal is the
current certificate, not a deadline. No action is needed, and no calendar entry
belongs on it.

Signatures outlive those certificates because they are **timestamped**.
electron-builder defaults to `http://timestamp.acs.microsoft.com` with SHA256
(see `TimestampRfc3161` / `TimestampDigest` in `app-builder-lib`'s
`windowsSignAzureManager.js`) and we do not override either, so an installer
signed today still verifies long after its signing certificate has expired.

Two things genuinely do lapse and will break signing — put *these* on a
calendar:

| Item | Expires | Renew via |
|---|---|---|
| Client secret (`AZURE_CLIENT_SECRET`) | ≤24 mo from creation | Entra app registration → Certificates & secrets, then update the GitHub secret |
| Identity validation | 2028-09-29 | Azure portal → Identity validation → **Renew** |

## Verifying a signed build
On Windows: right-click the `.exe` → **Properties → Digital Signatures**, or:

```powershell
signtool verify /pa /v PwrAgent-<version>-windows-x64-setup.exe
```

The signature should chain to a Microsoft public CA with the subject matching
`CN=PwrDrvr LLC`. A signature that verifies locally but still triggers
SmartScreen for users is the `Public Trust Test` profile-type mistake above.

## Notes
- `publisherName` MUST equal the validated identity CommonName, or signing
  fails verification.
- Local/sandbox builds (`pnpm --filter @pwragent/desktop package:win`) stay
  unsigned unless you export the same env vars — that's expected.
- Publishing the signed installer to the GitHub Release (today it's only a
  workflow artifact) is a separate follow-up.
