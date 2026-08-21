# Slack one-click install — research and recommendation

**Date:** 2026-08-14
**Status:** research / product recommendation (not an implementation plan being executed)
**Scope:** make the existing PwrAgent ↔ Slack connection substantially easier to install, ideally a safe one-click Slack app/bot install.
**Constraints honored:** inspect and recommend only. No production Slack app was created, no Slack configuration was changed, no PR opened.

This note is the handoff artifact for a follow-on build thread.

---

## 1. Verdict

PwrAgent cannot honestly ship a local-first, privacy-preserving **one-click "Add to Slack"** the way Slack Marketplace apps do, unless PwrAgent LLC is willing to run a cloud event relay and give up Socket Mode.

The right product is:

1. **Default (Phase 1):** a **customer-owned Slack app** created from a **PwrAgent-maintained manifest**, with a Settings/onboarding wizard that opens Slack's create-from-manifest URL and then collects the two tokens Socket Mode still requires (`xoxb-` bot token + `xapp-` app-level token).
2. **Phase 2:** optional **App Configuration Token** automation (`apps.manifest.create` + local OAuth) so the operator pastes one short-lived tooling token instead of clicking through Slack app settings. The `xapp-` token is still a Slack UI step until Slack exposes an API for it.
3. **Do not** ship one shared PwrAgent Slack app as the primary path. Offer it later only as an explicit **cloud-relay** product, with HTTP Events API (Marketplace requires HTTP; Socket Mode is banned there).

That is "two clicks and two pastes" for most operators, not literal one-click. It is the safest large reduction in friction that preserves "your coding agent runs on your computer."

---

## 2. Current PwrAgent Slack integration

### 2.1 What exists

| Layer | Location | Role |
|---|---|---|
| Adapter | `packages/messaging/providers/slack/` | Socket Mode inbound + Web API outbound |
| Config type | `slack-config.ts` | bot token, app token, optional signing secret, inbound mode, authz |
| Desktop config | `apps/desktop/src/main/settings/desktop-config.ts` | `messaging.slack.*` TOML |
| Secrets | `slackBotToken`, `slackAppToken`, `slackSigningSecret` | Electron `safeStorage` + sqlite ciphertext |
| Env overrides | `PWRAGENT_MESSAGING_SLACK_*` | bot/app/signing tokens, inbound mode, slash prefix |
| Settings UI | `MessagingSettings.tsx` Slack section | paste tokens, pairing, authz, inbound mode |
| Onboarding | `OnboardingWizard.tsx` `slack` platform | same secrets + Events API radio |
| Operator docs | https://docs.pwragent.ai/providers/slack/ | Socket Mode walkthrough (separate repo) |
| Contributor docs | `docs/messaging-architecture.md` | Socket Mode, no public callback URL for v1 |

The adapter is real and feature-rich: Block Kit actions, Slack mrkdwn, App Home, slash-command *dispatch*, file download/upload, live Working Updates via `chat.startStream` / `appendStream` / `stopStream`, directory search via `users.list`, pairing, team/channel/DM gates.

### 2.2 Transport and webhook assumptions

- **Working inbound path: Socket Mode only.** `SlackAdapter.start()` throws if `inboundMode === "events"`: `"Slack Events API mode is not implemented yet; use Socket Mode"`.
- Socket Mode uses `@slack/socket-mode` and requires an **app-level token** (`xapp-…` with `connections:write`). The constructor skips creating a socket client in Events API mode.
- Signing secret is **not** required for Socket Mode. Settings copy says it is "Optional for Socket Mode button validation. Required for future Events API mode." The adapter currently uses the signing secret, else the app token, else the bot token, else a random local HMAC key, to sign opaque button `value`s. That is PwrAgent's own callback-handle HMAC, not Slack request signing.
- Connection test (`validateCredentials`) calls only `auth.test` with the **bot token**. It does not prove Socket Mode can connect.
- Runtime enablement in `messaging-config.ts` requires **both** bot token and app token. A bot token alone does not start Slack.

Events API in the UI is leftover. Settings coerce `events` back to `socket`. Onboarding still presents Socket Mode vs Events API as if both work.

### 2.3 Secrets and storage

| Secret | Prefix | Required today | Store |
|---|---|---|---|
| Bot User OAuth Token | `xoxb-` | yes | keychain (`slackBotToken`) |
| App-Level Token | `xapp-` | yes (Socket Mode) | keychain (`slackAppToken`) |
| Signing secret | (hex) | no | keychain (`slackSigningSecret`) |

There is no OAuth client id/secret storage, no refresh token, no token rotation, no `app_id` / `team_id` persistence beyond `auth.test` at start.

`PWRAGENT_DEV_DISABLE_SECRET_STORAGE=1` silently drops wizard secrets in unsigned dev builds.

### 2.4 Install / auth UX today

Operator path:

1. Create a Slack app by hand at https://api.slack.com/apps
2. Choose Socket Mode vs Events API (docs say Socket Mode)
3. Invent scopes, event subscriptions, interactivity, Home tab, slash commands
4. Generate an app-level token with `connections:write`
5. Install the app to the workspace
6. Copy Bot User OAuth Token
7. Paste bot token + app token (+ optional signing secret + workspace URL) into Settings or the wizard
8. Test (`auth.test` only)
9. Pair a conversation with a pairing token and approve user/channel/team

PwrAgent never talks to Slack OAuth. Tokens are operator-copied long-lived credentials.

### 2.5 Scopes implied by the current adapter

Inferred from methods actually called (not from a checked-in manifest — **there is no official PwrAgent Slack manifest today**).

**Bot scopes the adapter exercises**

| Scope | Why |
|---|---|
| `chat:write` | `chat.postMessage`, `chat.update`, `chat.delete`, `chat.getPermalink` |
| `app_mentions:read` | `app_mention` events |
| `channels:history` / `channels:read` | public channel history + `conversations.info` |
| `groups:history` / `groups:read` | private channels |
| `im:history` / `im:read` | 1:1 DMs |
| `mpim:history` / `mpim:read` | group DMs |
| `users:read` | `users.info`, `users.list` (directory / pairing lookup). Self-disables on `missing_scope`. |
| `files:read` | `files.info` + private download |
| `files:write` | `files.uploadV2` outbound attachments |
| `commands` | slash-command *delivery* (Slack still requires the commands to exist on the app) |
| `assistant:write` | optional; Assistant thread status + live Working Updates. Self-disables on `missing_scope`. |

**App-level scope**

| Scope | Why |
|---|---|
| `connections:write` | Socket Mode `apps.connections.open` |

**Events the adapter actually handles**

- `message` (`message.channels` / `message.groups` / `message.im` / `message.mpim`)
- `app_mention`
- `app_home_opened` (refreshes Home tab)

It also listens for Socket Mode `interactive` (Block Kit) and `slash_commands`.

It does **not** currently consume `app_uninstalled`, `tokens_revoked`, reactions, pins, or channel membership events. Do not request those scopes/events in v1.

**Slash commands** are *parsed* but **not registered**. Default prefix is `pwragent_`:

`/pwragent_resume`, `/pwragent_agent`, `/pwragent_new`, `/pwragent_status`, `/pwragent_detach`, `/pwragent_monitor`, `/pwragent_schedule`, `/pwragent_scheduled`, `/pwragent_help`

The operator (or the shipped manifest) must create those commands. Slack has no adapter-side command catalog API equivalent to Discord's.

App Home is published for authorized users on start, even if `app_home_opened` is not subscribed — comment in `start()` says existing apps may have Home enabled without the event.

### 2.6 Multi-workspace, federation, revoke

- One Slack adapter per desktop profile. One bot token. `auth.test` stores a single `workspaceId`.
- Team allowlists exist (`authorizedTeamIds`, Slack Connect / shared-channel gating). That is not multi-workspace install.
- Enterprise Grid org-wide install is not a first-class mode. An org token would likely start, then mis-route workspace-qualified ids. Treat org-wide as out of Phase 1.
- Federation does not carry Slack credentials. Messaging adapters are local to the instance. Do not federate `xoxb` / `xapp`.
- No in-app reconnect, reinstall, or revoke. Clearing the two secrets + turning Slack off is the only disconnect. Slack-side uninstall is invisible (`app_uninstalled` unused).

### 2.7 Precise friction points

1. **No official manifest.** Operators must reconstruct scopes, events, Home, interactivity, and nine slash commands from docs and folklore.
2. **Two different tokens, two different Slack screens**, plus Install App. Telegram needs one bot token. Slack needs a small admin project.
3. **Onboarding lies about Events API.** It offers a mode that throws at start.
4. **Connection test is incomplete.** `auth.test` can pass while Socket Mode fails (bad/missing `xapp`, Socket Mode off, no `connections:write`).
5. **Slash commands are a second manual project** after the bot already "works."
6. **Admin-locked workspaces** need an owner to create/install an unpublished app. PwrAgent has no copy-paste request text for that admin.
7. **No reconnect/reinstall** when scopes change or the installer leaves the workspace (Slack auto-uninstalls apps that use more than a tiny scope set if the installer leaves).
8. **No least-privilege story in the UI.** Operators either under-scope (silent `missing_scope` degradation) or over-scope (admin rejection).
9. **Workspace URL is decorative.** Operators treat it as a credential.
10. **Pairing is a second ritual** after tokens. Correct, but the first ritual is already too long.

---

## 3. What Slack actually supports in 2026

Sources checked 2026-08-14. Dated limitations are called out inline.

### 3.1 OAuth v2 + Add to Slack

- Slack apps install with OAuth 2.0 v2: `https://slack.com/oauth/v2/authorize` → code → `oauth.v2.access` with `client_id` + `client_secret`.
- Docs: https://docs.slack.dev/authentication/installing-with-oauth/
- Redirect URLs are normally **HTTPS**. `redirect_uri` must match or be a subdirectory of a configured Redirect URL.
- The "Add to Slack" button is just that authorize URL plus `client_id` and scopes.
- `state` is recommended. Codes expire in **10 minutes**.
- Scopes on a token are **additive** across reinstalls. There is no way to drop a scope without revoking the token.

### 3.2 PKCE and desktop redirects — the hard stop

Docs: https://docs.slack.dev/authentication/using-pkce/

As of this writing:

- Enabling PKCE is **one-way** without Slack support.
- **Desktop redirects cannot request bot scopes.**
- Custom URI schemes (`pwragent://…`) are always desktop redirects and **require** PKCE.
- `http://localhost:…` is a desktop redirect **if the app has ever enabled PKCE**; otherwise it is treated as a server redirect.
- Desktop-issued tokens refresh without `client_secret` and force rotation (refresh tokens expire in 30 days).

PwrAgent already uses `pwragent://thread/…` as **in-app markdown**, not as an OS-registered OAuth protocol. Using it as a Slack redirect would still not yield a bot token.

**Implication:** a true desktop-native OAuth flow (`pwragent://` or loopback + PKCE) cannot install the PwrAgent *bot*. Bot install must look like a **confidential server** to Slack: HTTPS redirect (or non-PKCE localhost, which Slack's own OAuth guide still documents as HTTPS-required) and a `client_secret`.

PwrSnap's loopback OAuth (`127.0.0.1:<ephemeral>/oauth/callback`) is a good local pattern for *PwrSnap*, not a drop-in for Slack bot install.

### 3.3 App manifests — the real one-click-adjacent primitive

Docs: https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/

- Create-from-manifest UI: https://api.slack.com/apps?new_app=1
- **Shareable create URL:**
  - `https://api.slack.com/apps?new_app=1&manifest_yaml=<urlencoded>`
  - `https://api.slack.com/apps?new_app=1&manifest_json=<urlencoded>`
- Manifest APIs (`apps.manifest.create` / `update` / `export` / `validate` / `delete`) use an **App Configuration Token** from the user's api.slack.com/apps page. Config tokens expire in **12 hours** and rotate via `tooling.tokens.rotate`.
- `apps.manifest.create` returns `app_id`, `client_id`, `client_secret`, `verification_token`, `signing_secret`, and `oauth_authorize_url`. **It does not return an `xapp-` token.**
- There is a `failed_generating_app_token` error, which implies Slack may mint an app-level token internally when Socket Mode is on, but the documented response does not expose it.

**App-level tokens have no public create API.** Independent confirmation: [Stack Overflow 73493653](https://stackoverflow.com/questions/73493653/programmatically-get-app-level-token-for-slack-app-with-socketmode-enabled), Salesforce Trailblazer 2022-08-25. Still true in Slack's current Socket Mode docs (manual "Generate Token and Scopes" under Basic Information).

### 3.4 Workspace vs org install vs admin approval

- Default app is **undistributed**: one-click "Install to Workspace" on the app's own workspace, token shown in the UI. That is how operators get `xoxb-` today.
- **Public distribution** (unlisted) unlocks a shareable Add to Slack URL. Requires HTTPS for OAuth / Events / interactivity URLs. Disabling public distribution **uninstalls the app from every foreign workspace**.
- **Enterprise org-wide** (`org_deploy_enabled: true`) needs Org Admin/Owner approval and workspace selection. Reinstall required after enabling.
- Workspaces can require **admin approval**. Unpublished apps often show "this app isn't listed in the Slack Marketplace, so only workspace owners can install it." Customer-owned *internal* apps created in that workspace are the usual escape hatch.
- Some orgs allow **Marketplace-listed apps only**. A customer-owned internal app still works; a PwrAgent-owned unlisted public app may be blocked.

### 3.5 Slack Marketplace

- Commercial-scale distribution is supposed to go through Marketplace review (Developer Policy update 2024-12-10).
- Review needs a public landing page, privacy policy, support page, security questionnaire, feature-complete hosted app.
- **Socket Mode apps are not allowed in the public Slack Marketplace.** Slack says use HTTP, and use Socket Mode for local/dev or firewall-bound private apps.
  - https://docs.slack.dev/apis/events-api/using-socket-mode
  - https://docs.slack.dev/apis/events-api/comparing-http-socket-mode
- Listed apps freeze configuration: scope/event changes need another review.
- Slack's 2026 "Add to Slack" agent push (Vercel / Lovable) is a **hosted-platform partnership** with automated OAuth + manifest + environment. It is not a generic API PwrAgent can call from Electron. https://slack.com/blog/news/slack-is-where-agents-work

### 3.6 Token rotation

- Optional, **one-way on**. Access tokens expire every **12 hours**. Refresh needs `client_id` + `client_secret` (except PKCE desktop user tokens).
- Refresh tokens are single-use. Two-active-token limit if you refresh early.
- Turning this on for a desktop-held bot token means the laptop must refresh on a timer or Slack dies overnight. **Do not enable for Phase 1.**
- Long-lived `xoxb-` + `xapp-` in the keychain matches today's model and Slack's private/internal Socket Mode apps.

### 3.7 Private/internal vs public

| App kind | Who owns it | Socket Mode | Marketplace | Operator trust |
|---|---|---|---|---|
| Internal, customer-created | customer | yes | n/a | events never leave the laptop |
| Unlisted public, PwrAgent-owned | PwrAgent LLC | yes, but `xapp-` is PwrAgent's | no | PwrAgent can see every workspace's events if it holds `xapp-` |
| Marketplace listed | PwrAgent LLC | **no** | yes | Events API to PwrAgent HTTPS; same custody problem |

A shared public app's `xapp-` token is **app-global**. Shipping it inside the desktop binary lets any customer open Socket Mode for **all** workspaces the app is installed in. Hosting Socket Mode in PwrAgent cloud means PwrAgent sees every inbound Slack event. Both violate the Home-tab copy: *"Your coding agent runs on your computer."*

---

## 4. UX and architecture proposal

### 4.1 Product shape

**Ship a maintained Slack *manifest*, not a maintained Slack *app*, as the default.**

Keep the current "I already have tokens" paste path as Advanced.

### 4.2 Phase 1 operator story (recommended first ship)

Settings → Messaging → Slack, and the onboarding Slack step, become:

1. **Connect Slack** (primary)
2. Operator clicks **Create Slack app**. Desktop opens the browser to
   `https://api.slack.com/apps?new_app=1&manifest_json=<urlencoded official manifest>`.
3. Slack UI: pick workspace → review summary → Create.
4. Desktop shows a short checklist:
   1. In the new app: **Install to Workspace** → Allow.
   2. Copy **Bot User OAuth Token** (`xoxb-`).
   3. **Basic Information → App-Level Tokens → Generate** with `connections:write`. Copy `xapp-`.
5. Paste both into PwrAgent. **Test** runs `auth.test` **and** a Socket Mode handshake (`apps.connections.open` or a start/stop of the adapter).
6. Existing **Pair from Slack** flow is unchanged.

If the workspace requires admin approval, the checklist says so in plain language: "Ask a Workspace Owner to create this internal app from the manifest, or approve your request. PwrAgent never needs their Slack password."

**Advanced** remains: paste existing tokens, optional signing secret, workspace URL.

Remove the Events API radio from onboarding. Keep inbound mode in Advanced as "Socket Mode (only implemented path)."

### 4.3 Phase 2 (still customer-owned, fewer clicks)

Optional **Create with configuration token**:

1. Operator generates an App Configuration Token on api.slack.com/apps (Slack Tooling Tokens Vendor).
2. Pastes it once. PwrAgent does **not** persist it after the session (12-hour expiry).
3. Desktop calls `apps.manifest.create` with the official manifest (`socket_mode_enabled: true`, no request URLs).
4. Stores `client_id`, `client_secret`, `signing_secret`, `app_id` in the keychain (new secret names).
5. Starts a **confidential** OAuth install:
   - Prefer a **loopback HTTPS** or a short-lived Cloudflare Tunnel / Tailscale Funnel in front of `127.0.0.1` (same tunnel pattern as Mattermost/LINE), with `redirect_uri` written into the manifest.
   - Do **not** enable PKCE. Do **not** use `pwragent://`.
   - CSRF `state` (and optionally PKCE-less state binding to the loopback port).
   - Exchange code with `oauth.v2.access` using the **just-created** `client_secret` (never a PwrAgent-global secret).
6. Store `xoxb-`. Prompt only for the `xapp-` generate step, or deep-link the operator to that Slack settings page.

If Slack later returns or exposes an app-level token from manifest create, drop the last paste.

Reuse the PwrSnap callback-server shape (`createOAuthCallback` in `pwrsnap-connection-service.ts`): ephemeral `127.0.0.1` listener, HTML success/failure page,  timeout, `state` check. Slack-specific work is HTTPS + no PKCE + bot scopes.

### 4.4 What not to build in v1

- PwrAgent-hosted shared Slack app
- Slack Marketplace listing
- Token rotation
- PKCE
- Events API inbound (unless someone is building the cloud relay)
- Org-wide install as a first-class mode
- Federating Slack tokens
- Registering `pwragent://` as an OS OAuth handler for Slack

### 4.5 Prerequisites (operator)

- Slack workspace membership
- Permission to create an internal app **or** a Workspace Owner who will
- Desktop can reach `wss://wss-primary.slack.com` outbound (Socket Mode)
- Keychain / `safeStorage` available (or operator accepts env-var tokens)

### 4.6 Token storage, reconnect, revoke

Keep `xoxb-` / `xapp-` in the existing secret store.

New optional secrets for Phase 2 only: `slackClientId`, `slackClientSecret`, `slackAppId`. Still no refresh token until rotation is an explicit later project.

**Reconnect:** button re-runs the install checklist / Phase 2 OAuth with the same `client_id`. Needed after scope additions (`apps.manifest.update` returns `requires_refresh: true` / reinstall flag) or installer departure.

**Revoke / disconnect:**

1. Delete local secrets.
2. Stop the adapter.
3. Best-effort `apps.uninstall` if `client_id` + `client_secret` + bot token are present.
4. Tell the operator they can also Remove App in Slack.

Subscribe to `app_uninstalled` / `tokens_revoked` in the *manifest* even before rich handling exists, then Phase 1.1: on those events, mark Slack disconnected and surface a Settings error instead of retrying forever.

### 4.7 Multi-workspace and federation

- Phase 1: **one workspace per profile**, as today.
- A second workspace is a second customer-owned app (or a later org-wide project).
- Do not share one `xapp-` across PwrAgent instances. Socket Mode is "one connection per app per host"; two laptops on one customer app will fight or duplicate events.
- Federation: Slack stays on the instance that holds the tokens. Remote peers see threads through PwrAgent federation, not through Slack.

### 4.8 Error messages (operator-facing)

| Failure | Message intent |
|---|---|
| Missing bot token | "Paste the Bot User OAuth Token from Slack → Install App. It starts with xoxb-." |
| Missing app token | "Socket Mode needs an App-Level Token (xapp-) with connections:write, generated under Basic Information." |
| `auth.test` invalid_auth | "Slack rejected the bot token. Reinstall the app and paste the new xoxb- token." |
| Socket Mode start failed | "The bot token is valid, but PwrAgent could not open Slack Socket Mode. Check that Socket Mode is enabled and the xapp- token has connections:write." |
| `missing_scope` | Name the scope (adapter already does this internally) and offer **Reinstall with updated manifest**. |
| Admin approval | "This workspace only allows owners to install unpublished apps. Send them the Create Slack app link, or ask them to approve your request." |
| Installer left workspace | "Slack uninstalled the app because the installing member left. A current member needs to reinstall." |
| Events API selected | Do not offer it. If an old config has it, "Events API is not implemented. PwrAgent will use Socket Mode." |

### 4.9 Least-privilege official manifest (draft)

**Required bot scopes**

- `chat:write`
- `app_mentions:read`
- `commands`
- `im:history`, `im:read`
- `channels:history`, `channels:read`
- `groups:history`, `groups:read`
- `mpim:history`, `mpim:read`
- `users:read`
- `files:read`, `files:write`

**Optional bot scopes** (manifest `bot_optional` if we want the Slack installer to uncheck them)

- `assistant:write` — live Working Updates / Assistant status

Do **not** request `users:read.email`, reactions, pins, emoji, usergroups, or `chat:write.public` until the adapter needs them.

**Settings**

- `socket_mode_enabled: true`
- `token_rotation_enabled: false`
- `pkce_enabled: false`
- `org_deploy_enabled: false`
- interactivity enabled (no request URL; Socket Mode)
- event subscriptions: `message.channels`, `message.groups`, `message.im`, `message.mpim`, `app_mention`, `app_home_opened`, plus `app_uninstalled` / `tokens_revoked` when we handle them
- App Home: home tab on, messages tab on
- Bot display name: `PwrAgent`
- Slash commands: the nine `pwragent_*` verbs (no request URL)

Do not enable Slack's new `agent_view` in v1 unless product wants Agent DM chrome. Slack's June 2026 changelog says new apps should use `agent_view` and `assistant_view` will be deprecated later. Treat that as a **follow-up product decision**, not a silent add: it changes Slack UX and may imply `assistant:write`.

---

## 5. One maintained app vs customer-owned vs both

### Recommendation

| Phase | What PwrAgent ships | Who owns the Slack app |
|---|---|---|
| **1 (now)** | Official manifest + Create-app button + checklist + better test | Customer |
| **2** | Config-token create + local OAuth for `xoxb-` | Customer |
| **3 (optional, separate product)** | Hosted "Add to Slack" + HTTP Events API relay to the desktop | PwrAgent LLC |

**Opinion:** ship **customer-owned only** until someone explicitly funds a hosted relay. "Both" is correct later, never as the first PR.

Reasons to refuse a shared public app as default:

1. Socket Mode `xapp-` is app-global. Distribute it or terminate it in the cloud — both are bad.
2. Marketplace requires HTTP, so the shared app cannot stay on Socket Mode.
3. A hosted Events API endpoint sees every customer message. That is a privacy, retention, and incident-response product, not a Settings convenience.
4. Admin-locked enterprises often *prefer* an internal app they created. A public PwrAgent app can be harder to approve than a 20-line internal manifest.
5. Slack policy (2024-12-10) pushes commercial-scale distribution through Marketplace. A widely shared unlisted app is the worse of both worlds.

OpenClaw, the closest OSS analogue, made the same choice: paste-a-manifest, Socket Mode default, optional HTTP, optional trusted relay. They did not ship one shared Slack app. https://docs.openclaw.ai/channels/slack

---

## 6. Sources (primary Slack + relevant OSS)

### Slack (canonical)

| Topic | URL | Dated limitation |
|---|---|---|
| OAuth v2 | https://docs.slack.dev/authentication/installing-with-oauth/ | HTTPS redirect; 10-minute codes; additive scopes |
| PKCE | https://docs.slack.dev/authentication/using-pkce/ | One-way; desktop redirects **cannot request bot scopes** |
| Token rotation | https://docs.slack.dev/authentication/using-token-rotation/ | One-way; 12-hour access tokens; needs client secret |
| Manifests | https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/ | Shareable `new_app=1&manifest_*` URLs |
| `apps.manifest.create` | https://docs.slack.dev/reference/methods/apps.manifest.create/ | Returns client credentials, **not** `xapp-` |
| Distribution | https://docs.slack.dev/app-management/distribution/ | Public distro needs HTTPS; disable uninstalls others |
| Socket Mode | https://docs.slack.dev/apis/events-api/using-socket-mode | **Not allowed in Marketplace**; `xapp-` minted in UI |
| HTTP vs Socket | https://docs.slack.dev/apis/events-api/comparing-http-socket-mode | Socket = local/firewall; HTTP = Marketplace |
| Marketplace guidelines | https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements | Privacy policy, landing, support, review |
| Developer policy | https://docs.slack.dev/developer-policy | Commercial-scale → Marketplace (2024-12-10) |
| Admin approval | https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace | Owners can require pre-approved apps |
| Agent Add to Slack (2026) | https://slack.com/blog/news/slack-is-where-agents-work | Hosted-platform partnership, not a generic API |
| Agent view changelog | https://docs.slack.dev/changelog (2026-06-30) | New apps: `agent_view`; `assistant_view` to be deprecated |

### PwrAgent

| Topic | URL / path |
|---|---|
| Operator Slack setup | https://docs.pwragent.ai/providers/slack/ |
| Architecture | `docs/messaging-architecture.md` |
| Adapter contract | `docs/messaging-adapter-contract.md` |
| Adding a provider / slash commands | `docs/messaging-adding-a-provider.md` |
| Slack adapter | `packages/messaging/providers/slack/` |

### OSS / analogues

| Example | URL | Takeaway |
|---|---|---|
| OpenClaw Slack | https://docs.openclaw.ai/channels/slack | Manifest-first, Socket Mode default, optional HTTP, optional relay; still paste `xoxb`+`xapp` |
| OpenClaw OAuth issue | https://github.com/openclaw/openclaw/issues/31340 | Same wish; stale as of 2026 |
| Bolt OAuth | Slack Bolt JS/Python | Fine for hosted apps; not for desktop bot + Socket Mode |
| PwrSnap OAuth | `apps/desktop/src/main/mcp-connections/pwrsnap-connection-service.ts` | Local loopback callback to reuse for Phase 2 *shape* |

### Risks that may change

- Slack could expose app-level token creation on the Manifest API. Re-check `apps.manifest.create` before building Phase 2.
- Slack could relax "desktop redirects cannot request bot scopes." Re-check PKCE docs before inventing `pwragent://` Slack OAuth.
- Slack could allow Socket Mode in Marketplace. Unlikely; HTTP vs Socket doc is explicit.
- `agent_view` may become mandatory for new apps. Confirm against the live manifest schema when implementing.

---

## 7. Implementation plan for a follow-on build thread

Do **not** treat this section as an in-flight plan file. It is the recommended first build.

### Phase 1 — Manifest wizard (no Slack app owned by PwrAgent)

**Work**

1. Add a versioned official manifest module (JSON + YAML) next to the Slack provider, with unit tests against a fixture. Include scopes, events, Home, interactivity, Socket Mode, and the nine `pwragent_*` slash commands.
2. Desktop helper: build the urlencoded `https://api.slack.com/apps?new_app=1&manifest_json=…` URL. Open it with the existing external-open path (not a webview that could intercept Slack login).
3. Settings + onboarding: **Connect Slack** primary path with the checklist; Advanced keeps raw token paste.
4. Expand connection test: bot `auth.test` + Socket Mode open (or adapter start in a probe). Surface distinct errors.
5. Hide unimplemented Events API from onboarding. Coerce leftover `events` configs with a clear notice.
6. Copy for admin-approval workspaces.
7. Operator docs in **pwrdrvr/docs.pwragent.ai** (`providers/slack`): rewrite around the manifest button; keep a "manual app" appendix.
8. Do not change production Slack configuration. The manifest is a file in git, not an app at api.slack.com.

**Out of Phase 1:** OAuth, config tokens, Marketplace, Events API, token rotation, org-wide, cloud relay.

### Phase 2 — Config-token create + local OAuth (still customer-owned)

Only after Phase 1 is shipped and a spike confirms:

- `apps.manifest.create` still does not return `xapp-`
- non-PKCE loopback or tunnel HTTPS is accepted as `redirect_uri` for a brand-new internal app

Then implement the config-token flow in §4.3. Store new secrets. Never log them. Never persist the 12-hour config token.

### Phase 3 — Hosted Add to Slack (product decision required)

Separate design. Requires:

- PwrAgent-owned Slack app, public distribution
- HTTPS OAuth callback + Events API (not Socket Mode)
- Event relay to a paired desktop (new security boundary)
- Privacy policy, retention, Marketplace if commercially scaled
- Explicit operator consent: "Slack events pass through PwrAgent servers"

Do not start this without that product yes.

### Suggested first PR slices

1. Manifest module + tests (no UI)
2. Settings/onboarding wizard + connection-test hardening
3. docs.pwragent.ai Slack page (docs repo)

### Acceptance criteria (Phase 1)

- [ ] A new operator can create a correctly scoped Slack app from PwrAgent without reading a scope list.
- [ ] After pasting `xoxb-` + `xapp-`, Test reports bot identity **and** Socket Mode connectivity separately.
- [ ] Onboarding no longer offers Events API as a working mode.
- [ ] Existing token-paste setups keep working (no forced migration).
- [ ] Slash commands in the manifest match `MESSAGING_COMMAND_CATALOG` + `pwragent_` prefix.
- [ ] Manifest does not enable PKCE, token rotation, or org deploy.
- [ ] No PwrAgent client secret is embedded in the desktop binary.
- [ ] No production Slack app is created by the PR.
- [ ] Pairing, authz gates, and Home tab still work with a manifest-created app (manual or fixture-backed).
- [ ] ESLint clean on touched files; no Prettier; boundaries intact (`desktop` may import the slack provider only through the existing loader).

### End-to-end test strategy

**Must be hermetic in CI (no live Slack):**

- Manifest schema snapshot: scopes, events, slash commands, `socket_mode_enabled`, flags that must stay false.
- URL builder: encode/decode round-trip; rejects oversize query if we hit Slack URL limits (fallback: copy-manifest + open bare `new_app=1`).
- Settings/onboarding: Connect Slack CTA opens the expected external URL; Advanced paste path unchanged; Events API radio gone.
- Credential tester: distinct results for unset / bad bot token / good bot + bad app token / both good (injected fakes).
- Adapter start still throws on `inboundMode: "events"` until Events API exists; leftover configs coerced in the desktop mapper.
- Existing Slack adapter unit suite stays green.

**Live / lab (not CI, optional):**

- One manual recipe: create from manifest on a throwaway workspace, paste tokens, pair a DM, send `/pwragent_help`, click a Block Kit button, confirm Home tab.
- Do not automate against api.slack.com with a shared app.

**Docs:**

- Screenshot of the new Connect Slack card via the existing desktop screenshot pipeline only if the README/docs site needs it.

### Implementation notes for the build thread

- Reuse Settings tokens from `app.css` (no new chrome colors).
- Match surrounding hand-format (double quotes, 2-space, leading operators).
- New sqlite writes: none expected in Phase 1 (secrets already exist). Phase 2 secrets reuse `secret-store-sqlite`. If anything per-event is proposed, stop and measure.
- Keep the Slack adapter in `packages/messaging/providers/slack`. Desktop orchestrates the browser + secret write. Do not put OAuth HTTP servers in the provider package.
- Do not loosen dependency-cruiser rules.

---

## 8. Open questions to resolve before Phase 2 / 3

1. Will PwrAgent LLC ever accept Slack event custody? If no, never build Phase 3.
2. Confirm live `apps.manifest.create` response for a `socket_mode_enabled` app (does an undocumented `xapp` ever appear?).
3. Confirm whether Slack accepts `http://127.0.0.1:<port>/slack/oauth` as a Redirect URL on a brand-new **internal** app that has never enabled PKCE. If no, Phase 2 needs a tunnel or a tiny HTTPS helper that only forwards `code`+`state` to the desktop (no token exchange in the cloud).
4. Product call on Slack `agent_view` vs today's App Home + channel threads.
5. Whether a second workspace in one profile is a real request. If yes, that is a multi-account adapter project, not a button.

---

## 9. What this research did not do

- Did not create or modify any Slack app
- Did not change production config or secrets
- Did not open a PR
- Did not implement the wizard
