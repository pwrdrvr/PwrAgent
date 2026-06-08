# Windows Code Signing (Azure Trusted Signing)

PwrAgent signs the Windows NSIS installer with **Azure Trusted Signing**
(a.k.a. Azure Artifact Signing) — Microsoft's cloud signing service. It needs
no hardware token, works on GitHub-hosted runners, removes SmartScreen
"unknown publisher" warnings, and is the cheapest option (~$9.99/mo for up to
5,000 signatures).

Signing is **opt-in and degrades gracefully**: the release job builds an
**unsigned** installer until the signing config + credentials below are present,
then signs automatically. Label-gated PR installer builds (`ci:windows-package`)
are intentionally left **unsigned** (secrets are not exposed to PR validation,
and signatures count against quota).

## How the pieces connect

- `apps/desktop/electron-builder.yml` — `win` target (NSIS x64). No signing
  config lives here; it's injected per-build so unsigned builds keep working.
- `apps/desktop/scripts/release.mjs` (`--win`) — `resolveWindowsAzureSigning()`
  reads the env below and, when complete, passes
  `--config.win.azureSignOptions.*` to electron-builder. electron-builder 26
  then auto-installs the `TrustedSigning` PowerShell module on the runner and
  invokes `Invoke-TrustedSigning`.
- `.github/workflows/release.yml` (`windows-package` job, release tags only) —
  supplies the env from repo variables + secrets.

## One-time setup

### 1. Eligibility + subscription
Azure Trusted Signing requires a **paid** Azure subscription (no free/trial)
and one of: a **US/Canada org with 3+ years** verifiable history, an
**individual developer in the US/Canada**, or an **org in the EU/UK**. Confirm
PwrDrvr LLC qualifies before procuring.

### 2. Create the Trusted Signing resources (Azure portal)
1. Create a **Trusted Signing account**. Note its **region** → the **endpoint**
   is `https://<region>.codesigning.azure.net` (shown on the account overview).
2. Complete **Identity Validation** for the account. The approved
   **CommonName** becomes the `publisherName` — it must match exactly.
3. Create a **Public Trust Certificate Profile** under the account. Note its
   **name**.

### 3. Create a service principal for CI
1. In Microsoft Entra ID, create an **App registration**; add a **client
   secret**. Record the **Directory (tenant) ID**, **Application (client) ID**,
   and the **secret value**.
2. On the Trusted Signing account (or the specific certificate profile), assign
   the **"Trusted Signing Certificate Profile Signer"** role to that app
   registration.

### 4. Add the repo configuration
GitHub → repo **Settings → Secrets and variables → Actions**.

**Variables** (not secret — identifiers):
| Variable | Value |
|---|---|
| `WIN_AZURE_SIGN_PUBLISHER_NAME` | Validated CommonName, e.g. `PwrDrvr LLC` |
| `WIN_AZURE_SIGN_ENDPOINT` | `https://<region>.codesigning.azure.net` |
| `WIN_AZURE_SIGN_ACCOUNT` | Trusted Signing account name |
| `WIN_AZURE_SIGN_PROFILE` | Certificate profile name |

**Secrets** (service-principal credentials):
| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_CLIENT_SECRET` | Client secret value |

Once all eight are set, the next release tag produces a **signed** installer.

## Verifying a signed build
On Windows: right-click the `.exe` → **Properties → Digital Signatures**, or:

```powershell
signtool verify /pa /v PwrAgent-<version>-windows-x64-setup.exe
```

The signature should chain to a Microsoft Trusted Signing CA with the subject
matching the validated publisher name.

## Notes
- `publisherName` MUST equal the validated identity CommonName, or signing
  fails verification.
- Local/sandbox builds (`pnpm --filter @pwragent/desktop package:win`) stay
  unsigned unless you export the same env vars — that's expected.
- Publishing the signed installer to the GitHub Release (today it's only a
  workflow artifact) is a separate follow-up.
