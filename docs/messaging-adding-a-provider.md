# Adding a Messaging Provider

A hands-on, opinionated walkthrough for adding a new messaging platform adapter (Slack, Signal, Mattermost, Feishu/Lark, Matrix, …) to PwrAgent.

> **Reference implementation:** the most recent end-to-end addition is the Mattermost provider in [PR #199](https://github.com/pwrdrvr/PwrAgent/pull/199). It covers every step in this guide — capability profile, callback delivery model (HTTP-callback with HMAC), slash commands, settings UI with Keychain-backed secrets, connection-test wiring, env-var fallbacks, and tests. When this guide says "see how X is done," PR #199 is usually the answer. Read this guide for the *why* and the linked PR for the *how*.

This is the **how-to** companion to:

- [`docs/messaging-architecture.md`](messaging-architecture.md) — *what is the system* (read this first for context)
- [`docs/messaging-adapter-contract.md`](messaging-adapter-contract.md) — *what must my adapter satisfy* (the formal rules)
- [`docs/messaging-platform-integration.md`](messaging-platform-integration.md) — *how does an operator set it up*
- [`packages/messaging/AGENTS.md`](../packages/messaging/AGENTS.md) — *boundary enforcement*

If you have done this before, the [Living Examples](#living-examples) section at the bottom indexes the concrete code in Discord, Telegram, and Mattermost. Read alongside this guide.

> **First-time evaluator?** If you are following this guide for the first time and finding gaps, jump to the [Evaluation Rubric](#evaluation-rubric) at the end and fill in a "Lessons from \<your platform\>" entry. The rubric is the test we apply to this guide; the lessons section is how the guide stays honest.

## Prerequisites

You should be able to:

- [ ] Read the [architecture overview](messaging-architecture.md) to ground yourself in the layering: `interface` (generic types) → `providers/*` (per-platform adapters) → `apps/desktop/src/main/messaging` (workflow orchestration).
- [ ] Get a bot account on your target platform with the permissions to: send messages, read channel messages, list channels, upload/download files, edit messages, and (if applicable) update channel topic.
- [ ] Identify the platform's **callback delivery model** — the most architecturally consequential question. There are two:
  - **Inline-stream:** button clicks come back over the same long-poll/gateway/WebSocket the bot is already listening to (Telegram, Discord). Simpler.
  - **Out-of-band HTTP:** button clicks come back as an HTTP POST to a URL you supply (Mattermost, Slack). Your adapter must run an HTTP listener and the deployment must expose it.
- [ ] If the platform uses out-of-band HTTP callbacks, decide on a tunnel (Cloudflare Tunnel, Tailscale Funnel, ngrok, etc.). See [the operator guide](messaging-platform-integration.md) for our recommended setup.

You'll be writing TypeScript, working with `pnpm`, and running `pnpm typecheck` / `pnpm test` / `pnpm lint:boundaries` after each meaningful chunk.

## Anatomy of an adapter package

Every provider package looks like this:

```
packages/messaging/providers/<channel>/
├── package.json            # @pwragent/messaging-provider-<channel>, depends on
│                           # @pwragent/messaging-interface + the platform SDK
├── tsconfig.json           # extends ../../../../tsconfig.base.json
└── src/
    ├── index.ts                  # public re-exports for the desktop loader
    ├── <channel>-config.ts       # the <Channel>MessagingConfig type
    ├── <channel>-adapter.ts      # the main adapter class; the bulk of the LOC
    ├── <channel>-formatting.ts   # pure formatters: intents → platform messages
    ├── <channel>-callback-server.ts  # ONLY if your platform uses out-of-band
    │                                  # HTTP callbacks; otherwise omit
    └── __tests__/
        ├── <channel>-adapter.test.ts
        └── <channel>-formatting.test.ts
```

For reference sizes (informs how much code you're writing):

| Adapter | `*-adapter.ts` | `*-formatting.ts` | Total |
|---|---:|---:|---:|
| Discord | ~1800 LOC | ~225 LOC | ~2025 LOC |
| Telegram | ~2100 LOC | ~255 LOC | ~2350 LOC |
| Mattermost | _(you tell us)_ | _(you tell us)_ | _(you tell us)_ |

Most of the volume is in `*-adapter.ts` — connection lifecycle, the giant `deliver()` switch over intent kinds, callback-handle round-trip, attachment upload, edit/dismiss/pin handling. Don't be alarmed; it's mostly small focused methods.

## Step 1 — Create the package

```bash
mkdir -p packages/messaging/providers/<channel>/src/__tests__
```

Write `packages/messaging/providers/<channel>/package.json`:

```json
{
  "name": "@pwragent/messaging-provider-<channel>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@pwragent/messaging-interface": "workspace:*",
    "<platform-sdk>": "<version>"
  },
  "devDependencies": {
    "vitest": "^4.1.4"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Write `packages/messaging/providers/<channel>/tsconfig.json`:

```json
{
  "extends": "../../../../tsconfig.base.json",
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "lib": ["ES2023", "DOM"],
    "rootDir": "src",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts"]
}
```

`pnpm install` to add the package to the workspace.

> **Boundary:** your provider package **may import `@pwragent/messaging-interface` and your platform's SDK only**. It must not import desktop code, agent-core, the shared package, or other provider packages. `pnpm lint:boundaries` enforces this — if you accidentally cross a line, the lint job fails. See [`packages/messaging/AGENTS.md`](../packages/messaging/AGENTS.md) for the exact rules.

## Step 2 — Declare the capability profile

Your adapter declares a `MessagingCapabilityProfile` literal at the top of the adapter class. **This is the most important thing you write** — every producer adapts content based on this profile, so the numbers must be right.

The profile has four sections (`actions`, `text`, `inboundAttachments`, `outboundAttachments`). The shape lives in `packages/messaging/interface/src/index.ts`. Open it and look at the type before you start filling in.

### Capability profile workshop

For each field, do the work in this order:

1. **Find the platform's documented hard limit.** Read the platform's developer docs page-by-page. Note the URL and section name in a code comment near the value. Cite chapter and verse.
2. **If the docs are silent** (this *will* happen — Mattermost's `maxActions` per attachment is the canonical example), pick a conservative number you've actually verified empirically against a dev server. Mark the assumption explicitly:
   ```ts
   // ASSUMED — docs silent. Verified empirically against Mattermost 9.7
   // self-hosted on 2026-MM-DD; raise/lower with caution.
   maxActions: 25,
   ```
3. **For boolean capability flags** (`supportsStyles`, `supportsDisabled`, `supportsLayoutHints`, `supportsMessageEdit`), flip them based on what the platform's API actually exposes — not what would be nice. If `disabled` is unsupported, set `supportsDisabled: false` so producers can plan accordingly; otherwise the framework lets buggy producers ship `disabled: true` actions that get silently ignored.

Reference profiles are at the top of each existing adapter — read them and the surrounding rationale before declaring yours:

- Discord: `packages/messaging/providers/discord/src/discord-adapter.ts` (Discord component limits, 5×5 grid, 80-char labels).
- Telegram: `packages/messaging/providers/telegram/src/telegram-adapter.ts` (inline keyboard limits, 100 actions, 64-char labels, HTML dialect).
- Mattermost: `packages/messaging/providers/mattermost/src/mattermost-adapter.ts` (interactive attachment buttons, no row layout, undocumented action ceiling).

### Field-by-field cheat sheet

| Field | What it actually means | Where to look |
|---|---|---|
| `actions.maxActions` | Total interactive buttons per single message. | Platform's component / interactive-message reference. |
| `actions.maxActionsPerRow` | Buttons per row when the platform supports row grouping. Advisory only on platforms that auto-flow. | Same. |
| `actions.maxRows` | Max rows of buttons. `undefined` = unlimited. | Same. |
| `actions.maxLabelLength` | Button label cap. Producers truncate to this; the adapter clips again as a safety net. | Same. Watch for "visually clamped" vs "server-rejected" — pick the latter as the cap if you can find it. |
| `actions.supportsStyles` | Can buttons render with primary/secondary/danger/navigation distinction? `false` if platform only has one button style. | Component schema. |
| `actions.supportsDisabled` | Can a button be rendered as visibly inert? | Component schema. Some platforms simply don't have this — set `false`. |
| `actions.supportsLayoutHints` | Does the platform honor explicit `row`/`column`/`width: full` placement? `false` for auto-flow platforms. | Layout / component reference. |
| `actions.maxCallbackPayloadBytes` | How much data can ride along with a button click. Telegram is tiny (~64 bytes), Discord moderate (~100), Mattermost generous (~16 KB but capped by total post payload). | Component schema or interactive-message reference. |
| `text.maxLength` | Message body length limit. | Limits / API reference. |
| `text.encoding` | How `maxLength` is measured: UTF-8 bytes, UTF-16 code units, or characters. **Get this right** — a 4096-char Telegram message can be ~6 KB UTF-8; a 16,383-char Mattermost message is multi-byte-aware characters. | Limits page. |
| `text.markdownDialect` | What markdown does the platform render natively? `plain`, `html`, `slack-mrkdwn`, `discord-markdown`, `markdown` (CommonMark/GFM). |  Formatting reference. |
| `text.supports*` flags | Which formatting features actually render. | Formatting reference. |
| `text.supportsMessageEdit` | Can the bot edit its own messages? | API reference for posts. |
| `inboundAttachments` / `outboundAttachments` | Attachment caps for user uploads (in) and bot file delivery (out). | File / upload API reference. |

If you find a capability the framework can't express, **stop and extend [`packages/messaging/interface/src/index.ts`](../packages/messaging/interface/src/index.ts) first**. Don't paper over the gap with provider-specific logic.

## Step 3 — Implement the adapter shape

Write `<channel>-adapter.ts`. The class implements `MessagingAdapter` (defined in `apps/desktop/src/main/messaging/core/messaging-adapter.ts`) plus the desktop's wider `DesktopMessagingAdapter` shape (defined in `apps/desktop/src/main/messaging/messaging-runtime.ts`):

```ts
export type DesktopMessagingAdapter = {
  authorizedActorIds: readonly string[];
  capabilityProfile: MessagingCapabilityProfile;
  channel: MessagingChannelKind;
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  downloadAttachment?: MessagingAdapter["downloadAttachment"];
  setConversationTitle?(req): Promise<MessagingConversationTitleUpdateResult>;
  start?(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
  stop?(): Promise<void>;
};
```

Implement, in order:

1. **Constructor / factory** — accept `<Channel>MessagingConfig`, store it, construct the platform SDK client. Don't connect yet; `start()` does that.
2. **`capabilityProfile` field** — your literal from Step 2.
3. **`start(listener)`** — connect to the platform (WebSocket subscribe, gateway connect, long-poll loop, etc.). Begin authenticating. Save the listener so inbound events can reach the controller. If your platform uses out-of-band HTTP callbacks, also start the HTTP server here.
4. **`stop()`** — disconnect and shut down anything started.
5. **`deliver(intent)`** — the giant switch over `intent.kind`. Return `MessagingDeliveryResult`. See [Step 5](#step-5--render-outbound-intents) for the full table.
6. **`downloadAttachment(req)`** — fetch a user-uploaded file's bytes by the opaque handle persisted in the inbound `media` event.
7. **`setConversationTitle(req)`** — update the channel topic / DM title, if your platform exposes it.

> **Important:** the adapter must NOT call `turn/start` or any backend operation directly. It only translates events. The `MessagingController` owns workflow logic. Adapters that try to "be helpful" by debouncing input or starting turns themselves break the controller's turn-admission policy.

## Step 4 — Translate inbound events

Whenever the platform reports something the user did, normalize it to a `MessagingInboundEvent` and call the listener you saved during `start()`. The full type is in the interface package; the kinds are:

| `MessagingInboundEvent.kind` | Translates to | What you supply |
|---|---|---|
| `text` | A user typed in the bound conversation. | Plain text + the channel ref + the actor identity. |
| `command` | User typed a `/...` command. | `command` string + `args[]` + `rawText` + the actor. |
| `callback` | User clicked a button. | Resolve the handle in `MessagingCallbackHandleStore.resolveCallbackHandle`, then echo the record's `actionId` + `value` on the event (the event has those two fields, not a generic `action`). Plus an `interaction` ref carrying any platform-side ids. |
| `media` | User uploaded a file. | Attachment descriptors (each with `id`, `kind`, `name`, `disposition: "available"` if it's downloadable, optional MIME/size/dimensions, and `state.opaque` for download metadata) + a top-level `disposition` on the event itself. |
| `lifecycle` | Bot was added/removed from a channel; rare. | The fixed `lifecycle` enum: `"bound" \| "detached" \| "revoked" \| "adapter_started" \| "adapter_stopped"` — **not** a free-form reason. |

**Required fields you'll forget:** every inbound event needs `receivedAt: this.now()` (not `occurredAt`). Every `media` event needs **both** a per-attachment `disposition` *and* a top-level `disposition` on the event. Every attachment descriptor needs `id` (the platform's stable file id, used by `downloadAttachment` to look up bytes).

For each event, **always**:

- Validate every inbound identifier before authorization, persistence, logging, store lookup, or listener dispatch. Put pure helpers in `src/validate-ids.ts`; reject empty, oversized, wrong-type, and wrong-shape values with a fixed log shape (`platform`, `identifier_field`, `length`, `first8_hash`, `reason`) and never echo the raw value. Prefer length checks plus character loops; if a regex is unavoidable, keep it anchored with a single bounded character class and no nested quantifiers or overlapping alternation.
- Authorize on `actor.platformUserId` against the configured `authorizedActorIds`. The controller re-authorizes too, but doing it at the adapter layer prevents wasted work. An empty actor allowlist is a first-run discovery state, not a startup blocker: accept the platform connection, reject inbound events, and emit `onInboundRejected` so Messaging Activity shows the stable actor ID the operator needs to copy into settings.
- In group/server surfaces, enforce the platform's configured conversation allowlist too (Telegram supergroups, Discord guilds, etc.) before dispatch. Unauthorized general chatter should drop silently; log only actionable attempts such as DMs, slash commands, button clicks, or bot mentions, and rate-limit repeated unauthorized conversation logs.
- Mutable usernames / display names belong in `actor.displayName` / `actor.username` for audit, never as the authorization key.
- Provider-specific routing (channel id, supergroup id, post id) goes inside `MessagingAdapterState.opaque`. The controller may persist and echo this state but **must not parse it** — only your adapter knows the schema.

If your platform supports threads (Discord, Mattermost, Slack), set `conversation.kind: "thread"` and put the parent post / message id in `parentId`. See `MessagingConversationRef` in the interface.

## Step 5 — Render outbound intents

The `deliver(intent)` method gets every `MessagingSurfaceIntent` kind. Translate each into your platform's native send/edit/delete operations. The exhaustive switch:

| `intent.kind` | What it represents | Render to |
|---|---|---|
| `message` | Plain or markdown text. | A new post. Apply markdown dialect translation. |
| `status` | Pinned status card with action buttons. | A post + action buttons; pin if `delivery.pin: true`. Update in place when `delivery.mode: "update"`. |
| `progress` | "Working on it" indicator. | Either a post you keep editing or a typing indicator (platform-dependent). |
| `activity` | Typing state. | The platform's typing indicator if supported. |
| `thread_picker` / `project_picker` | Paginated list of threads/projects with action buttons. | A post + buttons + page nav. The producer already paginated based on your profile's `maxActions`. |
| `single_select` / `multi_select` | A list of choices. | A post + action buttons. |
| `questionnaire` | Multi-question form. | A post + buttons for each option of the current question. |
| `approval` | "Approve / Decline / etc." prompt. | A post + decision buttons. |
| `confirmation` | Confirm/cancel prompt. | A post + buttons. |
| `error` | Error surface. | A post (typically without buttons). |
| `dismiss` | Remove a prior surface. | Delete or unpin the targeted post. |
| `stream_update` | Streaming assistant text update. | Edit the prior post in place. Adapters may benignly discard with `outcome: "discarded"` if streaming is disabled or unsafe. |

For each intent that contains actions, **read the profile and apply defensive caps**:

```ts
// Producers should already have applied these via applyActionCapabilityLimits,
// but the adapter clips again as a safety net.
const maxActions = this.capabilityProfile.actions?.maxActions ?? <fallback>;
const maxLabel = this.capabilityProfile.actions?.maxLabelLength ?? <fallback>;
const items = actions
  .filter((a) => !a.disabled)
  .slice(0, maxActions)
  .map((a) => ({ label: a.label.slice(0, maxLabel), ... }));
```

Use the shared `layoutMessagingActionRows` helper from the interface package for any platform that supports row layouts — it consumes `MessagingActionLayoutHint` (`row`, `column`, `rowBreakBefore`, `rowBreakAfter`, `width`) and emits chunked rows respecting your `maxColumns` / `maxRows`. Read [`layoutMessagingActionRows`](../packages/messaging/interface/src/index.ts) before reinventing the wheel.

Return `MessagingDeliveryResult` with the appropriate `outcome` (`presented`, `updated`, `pinned`, `discarded`, `failed`, etc.) and any platform surface refs the controller should remember (post id, channel id wrapped in opaque state) so it can target updates / dismisses later.

## Step 6 — Wire callback handles

When you render a button, you need to be able to reverse the click. The platform delivers a small payload back when the user clicks (`callback_data` on Telegram, `custom_id` on Discord, `integration.context` on Mattermost). That payload should be an **opaque short handle**, not the semantic action data. The semantic action lives in the `MessagingStore.callbackHandles` table (the controller persists it; restart-safe).

The pattern, identical across providers:

1. **Render time** — for each action you produce:
   ```ts
   const handle = `${this.channel}:${createHash("sha256")
     .update(JSON.stringify([intent.id, action.id, action.value ?? null]))
     .digest("base64url")
     .slice(0, 12)}`;
   ```
   Persist the handle ↔ semantic-action mapping via the controller's `MessagingCallbackHandleStore`. Embed `handle` in the platform's callback payload.
2. **Click time** — when the platform delivers a click, look up the handle in the store, reconstruct `MessagingInboundCallbackEvent`, fire the listener.

The store is shared across the controller and your adapter (both go through the interface `MessagingCallbackHandleStore` shape). No bespoke state needed — use it.

### Out-of-band HTTP callback model (Mattermost, Slack)

If your platform delivers button clicks via HTTP POST instead of through the same connection used for inbound events, additional concerns apply:

- **Run the HTTP listener inside the adapter package**, not the desktop app. Boundary integrity.
- **Bind to `127.0.0.1`** only. Production deployments expose the listener through a tunnel (Cloudflare Tunnel, Tailscale Funnel, ngrok). See [the operator guide](messaging-platform-integration.md) for setup instructions and security recommendations.
- **Sign every callback URL with an HMAC** in the platform's free-form callback payload. The platform itself does NOT sign callbacks (e.g., Mattermost doesn't), so anyone with the public URL could forge clicks otherwise. Compute HMAC over `(intentId, actionId, issuedAt)` with a per-process secret; verify on receipt.
- **Always respond `200` to the callback POST**, even on HMAC verification failure — don't reveal verification status to attackers. Log the failure loudly so you notice in monitoring.
- **The HMAC secret regenerates on adapter restart.** Outstanding handles created before a restart fail HMAC verification — this is correct (acts as automatic TTL).

See `packages/messaging/providers/mattermost/src/mattermost-callback-server.ts` for the reference implementation.

## Step 7 — Wire attachment delivery

Two halves:

### Inbound (user uploads a file)

When the platform reports a user-uploaded file (file ID in a posted event), translate to a `media` `MessagingInboundEvent` with one or more `MessagingAttachmentDescriptor`. Each descriptor has:
- `name`, `mimeType`, `sizeBytes`, `dimensions?`
- `state.opaque` — your adapter's bookkeeping (file id, checksum, whatever) so `downloadAttachment` later can fetch the bytes.

Implement `downloadAttachment(request)`:
- Resolve the opaque state into a download.
- Return `{ data: Uint8Array, fileName, mimeType, sizeBytes }`.
- Apply `inboundAttachments.maxDownloadBytes` as a hard cap; reject oversized files.

### Outbound (bot delivers a file)

When `intent.parts` contains a `MessagingFilePart`, render it as a platform attachment. Most platforms use a two-step upload (`POST /files` → `POST /posts` with file ids). Cap against `outboundAttachments.maxUploadBytes`. If the platform supports remote-URL image previews (`outboundAttachments.supportsRemoteImageUrl`), use that for `MessagingImagePart` with a URL.

The forthcoming Plan/Review attachment delivery work ([issue #193](https://github.com/pwrdrvr/PwrAgent/issues/193) / [plan 2026-05-05-002](plans/2026-05-05-002-feat-messaging-plan-review-attachment-delivery-plan.md)) is the first producer that emits `MessagingFilePart` — wire the path now even if no producer is shipping one yet, so the adapter is feature-complete.

## Step 7.5 — Slash commands (when the platform supports them)

If the platform has native slash commands with autocomplete UX (Discord, Mattermost, Slack), **register the canonical command set on adapter start**. Skip this step only when the platform genuinely has no slash-command surface (Telegram's `/cmd` syntax counts; SMS does not).

The canonical set today mirrors what Discord and Mattermost both register:

| trigger | description |
|---|---|
| `resume` | Bind this conversation to a PwrAgent thread |
| `status` | Show the current binding's controls |
| `detach` | Detach this conversation from its current thread |

Reference implementations:

- Discord: [`packages/messaging/providers/discord/src/discord-commands.ts`](../packages/messaging/providers/discord/src/discord-commands.ts) — application commands API, registered globally on the bot at startup
- Mattermost: [`packages/messaging/providers/mattermost/src/mattermost-commands.ts`](../packages/messaging/providers/mattermost/src/mattermost-commands.ts) — team-scoped, registered per team the bot belongs to

### What you must do

1. **Reconciler.** On `adapter.start()`, list the bot's existing commands, diff against the desired set, create missing / update mismatched / leave orphans untouched. Mirror the Discord pattern's idempotent reconcile — running it twice should be a no-op the second time.
2. **Namespace your triggers** by default. The canonical verbs (`resume`, `status`, `detach`) **will collide** with built-in platform commands on at least one platform — `/status` is taken by Mattermost (user status), `/leave` by Slack and Mattermost, etc. Default the registered triggers under a `pwragent_` (or similar) prefix and expose the prefix as a config field so operators can override or empty-out for bare triggers if they accept the collision risk. The full trigger must satisfy the platform's char/length constraints (Mattermost: `[A-Za-z0-9_./-]`, 1–128 chars; check your platform's docs).
3. **Token / auth.** Most platforms hand back a per-command token at registration that they include on every subsequent invocation; persist or cache it and constant-time-compare on inbound. Mattermost uses string-equal of the registered token; Discord uses Discord's interaction signature; Slack uses signed request bodies. Read your platform's docs and **don't invent your own auth** when the platform provides one — Mattermost's command token, Slack's request signature, etc., are first-class authentication mechanisms scoped to that surface.
4. **Listener routing.** If the platform's slash-command POSTs share the same callback URL as interactive callbacks (Mattermost does), route by Content-Type at the listener: `application/x-www-form-urlencoded` → command branch; `application/json` → interactive callback branch. This keeps the operator's tunnel mapping single-path simple.
5. **Authorization.** Apply the same `authorizedActorIds` allowlist to slash commands as to inbound text events — an unauthorized user typing `/resume` shouldn't bind anything. Drop unauthorized invocations silently from the platform's point of view; log the actionable attempt without returning an explanatory "not authorized" message.
6. **Thread context.** If the user invokes the command from inside a thread reply, the platform's command body usually carries a thread/root identifier (Mattermost: `root_id`; Slack: `thread_ts`). Use it to build a `kind: "thread"` channel ref so the bot's response renders in-thread instead of escaping to the parent channel. Without this, `/resume` from a thread breaks user expectations.
7. **Dispatch.** Translate the platform's command body into a `MessagingInboundCommandEvent` (`kind: "command"`) and call `listener(event)`. Reuse the same dispatch path as inbound `/cmd` text-mention parsing — the controller handles both identically. Strip the namespace prefix back to the canonical base verb (`resume`/`status`/`detach`) before dispatching so the controller routes on stable names regardless of how the operator namespaced.
8. **Defensive failure.** Slash-command registration is autocomplete UX, not correctness. If reconciliation fails (no permission, network blip, platform outage), log and continue starting the adapter. Text-mention invocations (`@<bot> resume`) cover parity if the user knows the names.

### What you do NOT need to do

- Persist tokens to disk if the platform issues new ones on each successful registration. List + cache in memory at every adapter start; the platform side is the source of truth.
- Delete commands you didn't create. Filter your reconciler to triggers in the desired set; leave third-party commands on the same team/server alone.
- Build a separate auth surface. Use the platform's command-issued token / signature, not your own HMAC.

If you skip slash commands, mention it in the provider's package README and file a follow-up issue tagged `enhancement` so it's tracked. The framework doesn't currently capture "slash commands supported but unimplemented" as a capability flag — see if a future iteration of `MessagingCapabilityProfile` should add one.

## Step 8 — Register with the desktop runtime

Three edits:

### 8.1 — `apps/desktop/src/main/messaging/provider-loader.ts`

```diff
 export type DesktopMessagingProviderId = Extract<
   MessagingChannelKind,
-  "telegram" | "discord"
+  "telegram" | "discord" | "<channel>"
 >;
```

Add to `defaultMessagingProviderRegistry`:

```ts
  <channel>: {
    async load() {
      const module = await import("@pwragent/messaging-provider-<channel>");
      return {
        createAdapter({ config, logger, store }) {
          return config.<channel>
            ? module.create<Channel>Adapter(config.<channel>, store, logger)
            : undefined;
        },
      };
    },
  },
```

Add to `configuredMessagingProviderIds()`:

```ts
  ...(config.<channel> && config.<channel>.enabled !== false
    ? (["<channel>"] as const)
    : []),
```

### 8.2 — `apps/desktop/src/main/messaging/messaging-config.ts`

- Import `<Channel>MessagingConfig`.
- Add `<channel>?: <Channel>MessagingConfig` field on `DesktopMessagingConfig`.
- Add env-var loading in `loadDesktopMessagingConfig()`. See `apps/desktop/src/main/settings/desktop-settings-env.ts` for the env-var naming convention (`PWRAGENT_MESSAGING_<CHANNEL>_BOT_TOKEN`, etc.).
- Mirror redaction in `redactDesktopMessagingConfig()` so secrets don't leak to logs.

### 8.3 — `.dependency-cruiser.cjs`

The existing pattern rules use `^packages/messaging/providers/`, so they cover your new folder automatically. Run `pnpm lint:boundaries` to confirm. If the lint fails, double-check that your provider only imports `@pwragent/messaging-interface` + your platform SDK.

### 8.4 — `electron.vite.config.ts` (mandatory — easy to miss)

The desktop main process is bundled by `electron-vite`. Workspace packages
have to be listed in the `externalizeDepsPlugin.exclude` array to be
**bundled into** the main process rather than treated as external ESM
imports at runtime. **If you skip this step, the dynamic
`import("@pwragent/messaging-provider-<channel>")` from the provider
loader will fail at runtime** with:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/.../packages/shared/src/contracts/normalized-app-server'
imported from /.../packages/shared/src/index.ts
```

The error message points at `@pwragent/shared` but the actual fix is
in your provider's bundling. Edit
`apps/desktop/electron.vite.config.ts`:

```diff
 externalizeDepsPlugin({
   exclude: [
     "@pwragent/shared",
     "@pwragent/codex-app-server-protocol",
     "@pwragent/agent-core",
     "@pwragent/messaging-interface",
     "@pwragent/messaging-provider-discord",
+    "@pwragent/messaging-provider-<channel>",
     "@pwragent/messaging-provider-telegram"
   ]
 })
```

This list looks duplicative with the workspace dependency declaration in
`apps/desktop/package.json` but isn't — the `package.json` makes the
package importable; the `electron.vite.config.ts` `exclude` makes it
get bundled. Both are required.

### 8.5 — Settings UI (recommended for parity with the existing providers)

The desktop app has a Settings UI for messaging providers that flows through `apps/desktop/src/main/settings/desktop-settings-service.ts`. Adding your provider there gives users a non-env-var way to configure it: secrets land in the system keychain via `safeStorage`, non-secret values land in the per-profile TOML config, and env vars (when set) override both with `overriddenByEnv: true` flagged on the snapshot.

The Mattermost addition in [PR #199](https://github.com/pwrdrvr/PwrAgent/pull/199) is the canonical example for a provider with both a bot token and a second secret (the callback HMAC) plus provider-specific UX toggles. Use it as a reference; the integration points you have to touch are:

| File | What to add |
|---|---|
| `packages/shared/src/contracts/settings.ts` | Extend `DesktopSettingsSecretName` for each Keychain-stored secret. Add a per-platform block to `DesktopSettingsSnapshot.messaging`. Add a corresponding patch shape to `DesktopSettingsConfigPatch`. Add the platform to `SETTINGS_CREDENTIAL_TEST_KINDS` so the renderer's "Test" button has a kind to send. |
| `apps/desktop/src/main/settings/desktop-config.ts` | Extend `DesktopSettingsConfig.messaging` with a per-platform block. Add TOML emit/parse for that block, the patch-merge case, and the prune branch. |
| `apps/desktop/src/main/settings/desktop-settings-env.ts` | Declare every `PWRAGENT_MESSAGING_<PLATFORM>_*` env constant the runtime resolves. |
| `apps/desktop/src/main/settings/desktop-settings-service.ts` | Read each secret in `readSettings()` via `readSecretState`. Resolve every non-secret with the appropriate `resolveBoolean` / `resolveString` / `resolveList` / `resolveNumber` helper — they auto-emit `source: "env"` with `overriddenByEnv: true` when an env var is set. Add `resolve<Platform><Secret>Sync()` for every secret the runtime needs to pass to the provider at adapter start. |
| `apps/desktop/src/main/messaging/messaging-config.ts` | Extend the `DesktopMessagingSettingsSource` `Pick` to include the new sync resolvers. Replace the env-only branch (if any) with a settings + env merge that mirrors the Telegram/Discord pattern: env wins on each leaf via `envConfig.<platform>?.<field> ?? settings.<field>`. Update `redactDesktopMessagingConfig` to emit a redacted view of every secret (`"[REDACTED]"`) and surface non-secret toggles in the audit log. |
| `apps/desktop/src/main/credential-tester/credential-tester.ts` | Add a `test<Platform>` case + `resolve<Platform>BotToken` / `resolve<Platform><ExtraField>` deps if the probe needs more than a token (Mattermost needs the server URL). Extend `liftMessagingResult`'s union and the runtime's `CredentialValidationRequest` type. |
| `packages/messaging/providers/<platform>/src/validate-credentials.ts` | Implement the smoke probe — see Mattermost (raw fetch against `<serverUrl>/api/v4/users/me`) or Discord (`discord.js` `REST` GET `/users/@me`) depending on whether the SDK exposes a non-disruptive method. |
| `apps/desktop/src/renderer/src/features/settings/MessagingSettings.tsx` | Add a `<SettingsSection>` for the platform, mirroring the Telegram/Discord blocks. The same `SecretField` / `TextField` / `ListField` / `ToggleField` / `NumberField` primitives cover everything. Wire the section's `onSave<Platform>` from `SettingsScreen.tsx`. |

The `apps/desktop/src/renderer/src/features/settings/__tests__/settings-screen.test.tsx` Mattermost block in PR #199 is also worth copying as a renderer-integration test template — it asserts the section renders, that fields disable correctly when their parent toggle is off, and that edits flow through `writeConfig` with the right patch shape.

Env vars remain the source of truth when present (they shadow the Settings UI), so the operator-runbook headless deployment path keeps working unchanged. Settings UI is the nominal-case path for desktop users.

### 8.6 — Channel chip icon and the brand-asset rule

Every messaging surface in the desktop UI (status-bar chip, sidebar thread row, activity log row) shows a small platform icon. You need one for your provider. Before you draw anything, **check the platform's brand guidelines** — most chat platforms have a published kit and explicit usage rules, and the safe path is to use the official asset rather than redrawing it.

Decision tree:

1. **Find the brand-guidelines page.** Search `<platform> brand guidelines` or check the platform's developer-portal footer. Read the rules. The questions you're answering:
   - Are recoloring or monochrome silhouettes permitted?
   - Are there required clearspace, minimum size, or wordmark-vs-icon rules?
   - Does the platform distribute a downloadable brand kit?
2. **Follow the brand-asset pattern** for recognizable vendor marks:
   - Download the official kit, take the icon-only variant in each colorway you need (typically black + white + brand-color, "without clearspace" if available).
   - Save the verbatim SVG files under `apps/desktop/src/renderer/src/assets/<platform>/` — never edit the SVG content.
   - Render via `<img>`, NOT inline `<svg>` — see [`apps/desktop/src/renderer/src/icons/MattermostIcon.tsx`](../apps/desktop/src/renderer/src/icons/MattermostIcon.tsx), [`TelegramIcon.tsx`](../apps/desktop/src/renderer/src/icons/TelegramIcon.tsx), and [`DiscordIcon.tsx`](../apps/desktop/src/renderer/src/icons/DiscordIcon.tsx) for reference implementations. The `<img>` tag is structurally insulated from parent CSS `color` rules, which protects the asset from recoloring side-effects.
   - Add a `README.md` to the asset directory documenting the source URL, the usage rules, and the procedure for re-fetching on update. See [`apps/desktop/src/renderer/src/assets/mattermost/README.md`](../apps/desktop/src/renderer/src/assets/mattermost/README.md) as the template — the minimum content is: source links (brand guidelines + kit zip), the specific usage restrictions ("do not modify color/shape/etc."), and a copy-pasteable update procedure. Future maintainers should be able to update the assets without re-reading this guide.
3. **Wire the icon** into the four usage sites: the icon-map in `MessagingStatusBar.tsx`, the icon-map in `ThreadRow.tsx`, the conditional in `MessagingActivityScreen.tsx`'s `ActivityRow`, and the connection-test row in `MessagingSettings.tsx`. The status-chip dot communicates platform health; the icon stays a brand identity mark.

Boundary rule (also captured in [`apps/desktop/AGENTS.md`](../apps/desktop/AGENTS.md#third-party-brand-assets)): **never hand-redraw a vendor's mark from memory or training data, and never modify SVG path data inside a brand-asset file.** If the asset needs updating, re-download from the source.

## Step 9 — Tests

Mirror the patterns in `packages/messaging/providers/discord/src/__tests__/` and `packages/messaging/providers/telegram/src/__tests__/`. Minimum coverage:

| Test | What it pins |
|---|---|
| Capability profile shape | The literal you declared parses, has all required fields, has sensible numbers (`maxActions > 0`, `maxLabelLength > 0`, etc.). |
| Inbound event normalization | Each platform event kind translates to the right `MessagingInboundEvent.kind`. Edge cases: command parsing, file uploads, threaded replies, /commands you may not yet support. |
| Outbound rendering | For each `MessagingSurfaceIntent.kind`, the adapter calls the right SDK method with the right payload. Snapshot on representative intents. |
| Action ID sanitization | If your platform restricts action ID characters, sanitization round-trips correctly. |
| Authorization | Unauthorized actor IDs are rejected before the controller sees the event. |
| HMAC | (HTTP-callback platforms only) HMAC generation and verification, positive and negative. |
| Threading | Parent post id round-trip for threaded conversations. |
| Reconnect | (For platforms with persistent connections) WS or gateway disconnect / reconnect doesn't drop in-flight callback handles. |

Optional but valuable:

- **Live smoke test, env-gated.** Set `<CHANNEL>_LIVE_TEST_*` env vars; the test connects to a real dev server, posts a button, verifies the round-trip. Skipped in CI.

## Step 10 — Final verification

Run, in order:

```bash
pnpm typecheck         # all 7+ workspace packages compile
pnpm test              # all unit + integration tests pass
pnpm lint:boundaries   # dependency-cruiser is happy
pnpm lint              # per AGENTS.md, the linting agent passes
```

If `lint:boundaries` complains, you've imported from a forbidden package — re-read [`packages/messaging/AGENTS.md`](../packages/messaging/AGENTS.md).

## Common gotchas

This section grows over time as new providers land and find new ways to break. Each entry is a one-paragraph postmortem.

### Adapters must not start turns or call backend operations
The adapter's job ends at "I converted a platform-specific event into a `MessagingInboundEvent`." Workflow decisions — debouncing, queueing, calling `turn/start`, managing binding state — all live in `MessagingController`. Adapters that try to "be helpful" by starting turns themselves break the controller's turn-admission policy and produce duplicate work. (See `docs/messaging-adapter-contract.md` for the formal rule.)

### Platform usernames are not authorization keys
`actor.platformUserId` is the stable id used for authorization. Discord/Telegram/Mattermost all let users change their displayed username. Authorize on the platform's stable user id (Telegram numeric `id`, Discord numeric `id`, Mattermost UUID `id`); only use `displayName`/`username` for audit logging.

### Capability profile values must come from docs, not vibes
"Around 25 should be fine" is how subtle truncation bugs ship. Cite a docs URL or note an empirical verification date next to every numeric value. If you must guess, mark the value `// ASSUMED` so future maintainers know to verify.

### `markdownDialect` is not the same as "renders some markdown"
Telegram uses HTML for safe rendering despite supporting markdown; Discord uses its own dialect that diverges from CommonMark in code-block fence handling; Mattermost is GFM-superset. Set the dialect to the *exact* thing the platform uses, then translate accordingly. Do not assume markdown is markdown.

### Per-character vs per-byte limits matter
Telegram's 4096 limit is bytes, not characters — a 2000-char Cyrillic message is over budget. Mattermost's 16,383 is multi-byte-aware characters. Set `text.encoding` correctly.

### HTTP callback URLs need explicit deployment guidance
If your platform uses out-of-band HTTP callbacks, you cannot rely on users' devices being publicly reachable. Document Cloudflare Tunnel / Tailscale Funnel / ngrok in the operator guide. Don't ship without that.

### `MessagingInboundEvent` field names
The base event timestamp is `receivedAt`, not `occurredAt`. The lifecycle event uses a fixed `lifecycle` enum, not a free-form `reason`. The callback event echoes `actionId` (string) and `value` (separately) — there is no `action` field carrying the full `MessagingSurfaceAction` you persisted. Look up the resolved handle's `actionId` and `value` and pass those.

### `MessagingAdapterState.opaque` is `MessagingJsonValue`
Not `Record<string, unknown>`. Plain `Record<string, string>` works because every leaf is JSON-serializable; `Record<string, unknown>` does not satisfy the type. Same for any nested object you stuff into adapter state.

### `MessagingProgressIntent` has `label`/`detail`, not `text`
Easy to assume by analogy with `status` and `stream_update`, but the progress intent only has `label: string` and optional `detail: string`. Concatenate them yourself if you want a single string.

### Outbound `Blob` construction with Node 22 lib types
`new Blob([uint8Array])` fails type-checking under Node 22's lib types because `Uint8Array<ArrayBufferLike>` is not assignable to `ArrayBufferView<ArrayBuffer>` (the `SharedArrayBuffer` case widens the union). Workaround: copy the bytes into a fresh `ArrayBuffer`-backed `Uint8Array` first:
```ts
const buffer = new ArrayBuffer(bytes.byteLength);
new Uint8Array(buffer).set(bytes);
formData.append("files", new Blob([buffer], { type: mime }), name);
```

### Browser-first SDKs and `window` access in Electron's main process
Some platform SDKs are written browser-first and reach for `window` or a
DOM `WebSocket` at startup. Electron's **main** process is a Node
environment with no `window`, so a bare `window.addEventListener(…)`
throws "window is not defined" the moment the SDK initializes — even
though Node 22+ has a global `WebSocket`.

The defense in depth is:

1. **Pin a version of the SDK that uses `globalThis.window?.…`**
   (optional chaining), so missing-`window` no-ops cleanly. For
   `@mattermost/client` this is `^11.4.0` — the upstream fix landed in
   [mattermost/mattermost#35195](https://github.com/mattermost/mattermost/pull/35195)
   (issue [#33581](https://github.com/mattermost/mattermost/issues/33581),
   ticket MM-67137). Older versions (10.8.0–10.12.x, 11.0.x) require the
   workaround below.
2. **If you must use a pre-fix version**, install a minimal `window`
   stub once at module load, before the SDK imports:
   ```ts
   if (typeof (globalThis as { window?: unknown }).window === "undefined") {
     (globalThis as { window?: unknown }).window = {
       addEventListener: () => {},
       removeEventListener: () => {},
       navigator: { userAgent: "PwrAgent" },
     };
   }
   ```
   Use `globalThis as unknown as { window?: ... }` to avoid colliding
   with `lib.dom`'s own `Window` global type — the stub shape we want is
   much narrower than the real `Window` interface.
3. **WebSocket constructor** — modern SDK versions default
   `newWebSocketFn` to `(url) => new WebSocket(url)`, which resolves to
   Node's global `WebSocket`. No explicit injection is needed on Node 22+.

If your platform's SDK is Node-first (Telegram's `grammy`, Discord's
`discord.js`), no polyfill is needed.

### `electron-vite` workspace bundling list (silent runtime failure)
The desktop main process bundles workspace packages explicitly via
`apps/desktop/electron.vite.config.ts`'s `externalizeDepsPlugin.exclude`
array. Forgetting to add your new provider there typecheks clean, lints
clean, tests clean — but at runtime the dynamic provider import fails
with `ERR_MODULE_NOT_FOUND` pointing at `@pwragent/shared`'s internals.
The fix is in *your* provider's bundling, not in shared. See Step 8.4.

### Test mocks that construct `DesktopMessagingProviderRegistry`
Adding a new provider id to `DesktopMessagingProviderId` breaks any test that builds a `Partial<DesktopMessagingProviderRegistry>` and casts to the full type — TypeScript flags the new provider as `undefined`. Update the test fixtures (e.g., `apps/desktop/src/main/__tests__/messaging-provider-loader.test.ts`) to include a stub for your provider when you wire the loader entry.

### Outbound delivery target lives on `intent.audit?.channel` (not "requestContext")
Every adapter's `deliver()` needs to figure out which platform conversation to post into. The canonical source is `intent.audit?.channel` — that's what Telegram (`telegram-adapter.ts:1252`) and Discord (`discord-adapter.ts:886`) both read. The companion source is `intent.targetSurface?.state?.opaque`, used when updating an existing surface.

Naming any other field (e.g. `intent.requestContext.channel`) gets you a silent failure: the resolver returns `undefined`, the adapter returns `outcome: "failed"`, the inbound side keeps logging "ROUTED" so it looks like work is happening, but the user never sees a reply. Add a `logger.warn` at every "no target resolved" branch so future regressions of this shape surface in the dev console immediately.

### Conversation kind must round-trip through callbacks
`MessagingCallbackHandleStore.resolveCallbackHandle` keys on `channel:kind:parentId:id` (see `buildMessagingConversationKey`). If your callback path can't recover the conversation kind (`dm` / `channel` / `thread` / `topic`) from what the platform sends back, the lookup silently misses with no useful error.

Mattermost is the cautionary tale: the interactive callback body has `channel_id` but no channel type, and the id alone doesn't disambiguate (DM ids look like any other 26-char base32). Solution: stash the kind on `integration.context` at delivery time and read it back at callback time. The HMAC only needs to cover authenticity-critical fields; routing breadcrumbs can ride along unsigned because manipulation makes the lookup fail closed (same outcome as no tampering).

Same pattern applies to thread roots, topic ids, or any platform-specific routing context the callback body strips. If in doubt, embed it in `integration.context` (or the equivalent opaque round-trip slot for your platform) and parse it back at callback time.

### Provider-specific URL constraints on action ids (Mattermost)
Mattermost registers the action callback handler at `/api/v4/posts/{post_id}/actions/{action_id:[A-Za-z0-9]+}` — strictly ASCII alphanumeric, **no underscores, dashes, dots, or colons**. A button id of `command_resume` makes the click route to a path that fails the regex, falls through to Go's not-found handler, and returns a bare 404 with no useful body. The button visibly does nothing.

Sanitize action ids with the platform's actual constraint, not what feels reasonable. For Mattermost: `rawId.replace(/[^A-Za-z0-9]/g, "")`. Drop non-alphanumerics; do not substitute underscores. The HMAC-signed `integration.context` carries the original id so the callback handler still resolves to the right semantic action.

Other platforms have their own quirks — Slack truncates, Discord caps at 100 chars, Telegram limits callback_data to 64 bytes — read the docs.

### URL-routed callback ids must be unique within a post (Mattermost)
Producers commonly emit many chips with the **same** `action.id` and differentiate via `action.value` (e.g. `thread_picker`, `project_picker`). Telegram (`callback_data`) and Discord (`custom_id`) both carry the per-chip payload directly on the wire, so duplicates don't matter — each chip's distinct payload routes correctly.

Mattermost is different: it routes interactive callbacks by URL path and **matches the FIRST action in `props.attachments[].actions[]` whose `id` matches the URL**. Duplicate ids silently route every click to the first chip's `integration.context`. Diagnostic shape: user clicks chip #2 in a picker, ends up bound/routed to chip #1's payload. Especially confusing because the first chip is often the most-recently-active item, so the wrong-but-plausible result looks like opaque-state corruption rather than a routing-id collision.

If your provider routes callbacks by URL or any other id-only mechanism, append the chip's slot index to the rendered id (Mattermost: `${sanitize(action.id)}${index}`) so each rendered button has a URL-unique id. Keep the original `action.id` in your callback context (HMAC payload, handle lookup, etc.) so resolution and authentication still work — only the URL-visible id changes.

_(Add new gotchas here as you find them.)_

## Living examples

Concrete code references in the tree, kept current as adapters evolve:

| File | What it's the canonical example of |
|---|---|
| `packages/messaging/providers/telegram/src/telegram-adapter.ts` | An inline-stream provider with HTML dialect and the largest button budget. Long-poll connection lifecycle. Inline keyboard rendering. |
| `packages/messaging/providers/telegram/src/telegram-formatting.ts` | `layoutMessagingActionRows` consumption. HTML escaping. Message chunking under a tight per-message byte budget. |
| `packages/messaging/providers/discord/src/discord-adapter.ts` | An inline-stream provider with components/action rows. Gateway reconnect handling. Slash command setup. Defensive truncation patterns. |
| `packages/messaging/providers/discord/src/discord-formatting.ts` | Component layout (`maxRows: 5`, `maxColumns: 5`). Custom-id encoding. |
| `packages/messaging/providers/discord/src/discord-commands.ts` | Slash command registration and handler. Pattern for any platform with slash commands. |
| `packages/messaging/providers/mattermost/src/mattermost-adapter.ts` | An out-of-band HTTP callback provider. WebSocket inbound + REST outbound + HTTP listener for callbacks. Threading via `root_id`. |
| `packages/messaging/providers/mattermost/src/mattermost-callback-server.ts` | The reference implementation of the localhost-bound HTTP callback listener with HMAC verification. |
| `packages/messaging/providers/mattermost/src/mattermost-formatting.ts` | Multi-attachment auto-flow rendering. Action ID alphanumeric sanitization. |

## Evaluation rubric

This guide is intentionally living. After you ship a new provider, evaluate the guide cold against the work you actually did. The rubric:

1. **Cold-start usability:** Could someone unfamiliar with PwrAgent's messaging follow the guide and produce a working adapter without reading any other doc?
2. **Completeness:** Does every required file have a clear creation step?
3. **Ordering:** Are dependencies (e.g., declare profile before implementing render) called out so a reader can't stumble into them out of order?
4. **Examples vs. instructions:** Does the guide tell the reader *what to do* rather than just *what to read*?
5. **Failure modes:** Does the guide name the things that go wrong (e.g., "this platform requires HTTP callback URL" rather than the reader discovering it on their own)?
6. **Living examples:** Are the file/line references to existing adapters still accurate after the work?

After your evaluation, append a short **Lessons from \<your platform\>** entry below capturing what was missing, wrong, or confusing — and then *fix the guide*. Future contributors should see the rubric, see the lessons, and know the guide is being kept honest.

### Lessons from Mattermost

Captured at the end of Phase 10 of [plan 2026-05-06-001](plans/2026-05-06-001-feat-messaging-mattermost-adapter-and-provider-guide-plan.md). The guide skeleton was written *before* the implementation; this list is everything that was missing, wrong, or confusing in the skeleton vs the actual experience of building Mattermost.

**What the guide got right (kept):**

- The capability profile workshop with field-by-field cheat sheet was the most valuable single section. I wrote the literal, then read the cheat sheet, then trimmed.
- Reference-adapter line counts (~1800 / ~2100 LOC) set realistic expectations.
- The boundary callout about not importing desktop code was load-bearing — I almost reached for a desktop type and stopped because of the warning.
- The "register in provider-loader.ts AND messaging-config.ts AND package.json AND test mocks" four-touch wiring was something I'd have missed without an explicit Step 8.

**Inline corrections folded into the body** (search above):

- Inbound event field-name corrections (`receivedAt`, lifecycle enum, callback event field names, attachment descriptor required fields).
- `MessagingAdapterState.opaque` is `MessagingJsonValue`, not `Record<string, unknown>`.
- `MessagingProgressIntent` has `label`/`detail`, not `text`.
- Node 22 `Blob` constructor + `Uint8Array<ArrayBufferLike>` workaround.
- Test mock registry update needed when adding a provider id.

**What was missing:**

- **`electron.vite.config.ts` workspace bundling list (Step 8.4).** The original guide had a four-touch wiring step (provider-loader, messaging-config, package.json, test mocks) but omitted the *fifth* required edit: adding the new provider to the desktop's electron-vite `externalizeDepsPlugin.exclude` array. Without it, typecheck and tests pass but the runtime dynamic import fails with a `ERR_MODULE_NOT_FOUND` error that misleadingly points at `@pwragent/shared` internals rather than the missing bundling config. This was the single most consequential gap in the guide — it shipped silently into the first runtime test. Now spelled out as Step 8.4 with the exact diff and the misleading error message preserved as a search-anchor.
- **The capability profile workshop didn't acknowledge documentation gaps.** Mattermost's docs are explicitly silent on `actions.maxActions`, `actions.maxLabelLength`, and `actions.maxCallbackPayloadBytes` per attachment. The guide now suggests `// ASSUMED — docs silent` annotations; previously it implied every value comes from a citable doc page.
- **Step 5 (rendering) and Step 3 (adapter shape) are not strictly sequential.** In practice you bounce: write the constructor + `start`/`stop` → call into the formatting module → discover an intent's shape needs a new helper → back-fill `deliver()` for the next intent kind. The guide should expect the bounce.
- **Slash commands are out-of-scope for v1.** Mattermost supports them, but they require *another* HTTP endpoint (separate from the interactive callback URL). The guide implies adapters take all-or-nothing on commands; in practice text-mention parsing or a `/<cmd>` prefix detection on the `posted` text covers most needs in v1.
- **The "redact secrets in messaging-config" step is easy to skip.** The reference Discord/Telegram redactors include the bot token; my first pass omitted Mattermost from the redactor entirely. Step 8.2 now flags this explicitly.
- **The HTTP callback URL has more deployment surface than "use ngrok."** Cloudflare Tunnel + Zero Trust + IP allowlist is the recommended production posture; Tailscale Funnel is a free-ish alternative. The operator guide ([`docs/messaging-platform-integration.md`](messaging-platform-integration.md)) now covers both.

**What was wrong:**

- The guide's example of `MessagingInboundEvent` field names was vague; concrete corrections are now folded in.
- The guide implied a `value` field on `MessagingCallbackHandleRecord.action`. The record stores `actionId` and `value` separately. Easy to confuse.

**What was confusing:**

- The capability profile section listed `maxRows` as "undefined = unlimited" but the platform may not have a row concept at all (Mattermost auto-flows). The guide could clarify that `maxRows: undefined` and `supportsLayoutHints: false` cover different cases (the former says "no upper bound on rows"; the latter says "the platform doesn't honor explicit layout hints, full stop").
- **There is no current way for a producer to know "this provider needs HTTP callbacks."** The framework hides this from producers (correctly), but if a future provider needs different *delivery semantics* per click (e.g., immediate response with side-effects), we'd need to extend the interface. Tracked as a possible future extension; not blocking.

**Process feedback:**

- Writing the guide first **did** force me to be honest about what a contributor needs vs. what I could just figure out by reading Discord. The bounce-back evaluation surfaced ~15 corrections that would otherwise have stayed implicit knowledge.
- The reference-implementation index ("Living Examples" section) at the bottom is a good payoff: I caught myself referring to the table mid-implementation.
