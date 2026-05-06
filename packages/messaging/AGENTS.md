# Messaging Package Guidance

This tree defines the generic messaging contract and the provider adapters that implement it.

For a layered architecture overview with diagrams, data-flow sequences, the capability-profile system, and a file map, see [`docs/messaging-architecture.md`](../../docs/messaging-architecture.md). For the technical contract every adapter must satisfy, see [`docs/messaging-adapter-contract.md`](../../docs/messaging-adapter-contract.md).

## Package Boundaries

- `packages/messaging/interface` is the only generic messaging contract. It may define channel-neutral types, capabilities, delivery policies, opaque adapter state, callback handles, and rendering primitives.
- The interface package must not import Telegram, Discord, Feishu, Mattermost, desktop, or agent-core implementation code.
- Provider packages under `packages/messaging/providers/*` are isolated TypeScript packages. They may import `@pwragent/messaging-interface` and their own provider SDKs, but they must not import desktop, agent-core, shared app contracts, or sibling providers.
- Provider SDKs such as `grammy` and `discord.js` belong only inside their provider package. Do not import those SDKs from desktop messaging workflow code or from the generic interface.
- Desktop messaging orchestration lives outside this tree, currently in `apps/desktop/src/main/messaging`. It should speak the generic interface and load providers through the provider loader, not through provider-specific workflow branches.
- **Providers must not touch persistence directly.** No provider may import `apps/desktop/**`, `better-sqlite3`, `drizzle`, any module that exposes raw SQL, or the desktop messaging store implementation. Persistent state reaches providers only through opaque interfaces declared in `@pwragent/messaging-interface` (today: `MessagingCallbackHandleStore`, plus `MessagingAdapterState.opaque` for routing/surface state the workflow layer echoes but never parses). New persistence needs become new interface methods, not new tables. Providers that want to own a schema are doing it wrong — see [`docs/messaging-architecture.md` § Architectural principles](../../docs/messaging-architecture.md#architectural-principles).

## Design Rules

- Keep workflow semantics channel-neutral. Resume navigation, status cards, approvals, questionnaires, markdown/content composition, attachments, and message routing should be expressed as generic intents and actions.
- Store provider-specific routing data only as opaque adapter state. Core workflow code may persist and echo this state, but must not parse Telegram chat IDs, Discord message IDs, callback payloads, or provider SDK types.
- When a platform has limitations, encode them as provider capabilities, delivery results, fallback behavior, or generic interface extensions. Do not add Telegram/Discord conditionals to shared workflow logic.
- If a future provider needs a feature the interface cannot express, extend the generic interface first, then implement the extension in providers that can support it.
- Prefer restart-safe behavior. Callback/action mappings that can be encoded generically or persisted should not rely only on provider process memory.

## Thread-State Update Bus

When the desktop user, a Telegram callback, or a Discord callback changes
persistent thread state (model, reasoning effort, fast mode, permissions,
name, compaction), the change is broadcast on a single in-process bus —
the existing `BackendRegistry` event emitter — and every controller plus
the renderer learns about it. Each `MessagingController` then re-renders
its own bindings' status surfaces via `refreshStatusSurfacesForThread`.

This is what keeps Discord, Telegram, and the desktop UI in sync after a
user clicks the Permissions button on any one of them. Do NOT add
provider-specific cross-surface refresh logic, parallel buses, or
ad-hoc event channels. The pattern is: registry mutation method →
typed `AppServerNotification` emit → fan-out via the existing
`messaging-runtime.onEvent` → controller's `handleBackendEvent` routes
the method to `refreshStatusSurfacesForThread`.

Mutation handlers in `MessagingController` (e.g. `togglePermissionsMode`,
`setBindingModel`) should NOT call `renderBindingStatus` inline for state
that flows through the bus — the bus is the single refresh source.
For binding-local mutations (`cycleToolUpdateMode`,
`syncConversationName`) keep the inline render — there's no bus event
for binding-scoped preferences.

See `apps/desktop/AGENTS.md` for the registry-side emit pattern and
the renderer-side subscription branches.

## Enforcement

- Boundary rules are enforced by `.dependency-cruiser.cjs` via `pnpm lint:boundaries`.
- Each package has its own `tsconfig.json`; keep provider source inside its package root and avoid cross-package relative imports.
- Run `pnpm lint` after changing this tree. For provider behavior, add tests in the provider package or the relevant desktop messaging adapter test, depending on where the behavior is exercised.
