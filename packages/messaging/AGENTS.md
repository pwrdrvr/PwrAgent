# Messaging Package Guidance

This tree defines the generic messaging contract and the provider adapters that implement it.

## Package Boundaries

- `packages/messaging/interface` is the only generic messaging contract. It may define channel-neutral types, capabilities, delivery policies, opaque adapter state, callback handles, and rendering primitives.
- The interface package must not import Telegram, Discord, Feishu, Mattermost, desktop, or agent-core implementation code.
- Provider packages under `packages/messaging/providers/*` are isolated TypeScript packages. They may import `@pwragent/messaging-interface` and their own provider SDKs, but they must not import desktop, agent-core, shared app contracts, or sibling providers.
- Provider SDKs such as `grammy` and `discord.js` belong only inside their provider package. Do not import those SDKs from desktop messaging workflow code or from the generic interface.
- Desktop messaging orchestration lives outside this tree, currently in `apps/desktop/src/main/messaging`. It should speak the generic interface and load providers through the provider loader, not through provider-specific workflow branches.

## Design Rules

- Keep workflow semantics channel-neutral. Resume navigation, status cards, approvals, questionnaires, markdown/content composition, attachments, and message routing should be expressed as generic intents and actions.
- Store provider-specific routing data only as opaque adapter state. Core workflow code may persist and echo this state, but must not parse Telegram chat IDs, Discord message IDs, callback payloads, or provider SDK types.
- When a platform has limitations, encode them as provider capabilities, delivery results, fallback behavior, or generic interface extensions. Do not add Telegram/Discord conditionals to shared workflow logic.
- If a future provider needs a feature the interface cannot express, extend the generic interface first, then implement the extension in providers that can support it.
- Prefer restart-safe behavior. Callback/action mappings that can be encoded generically or persisted should not rely only on provider process memory.

## Enforcement

- Boundary rules are enforced by `.dependency-cruiser.cjs` via `pnpm lint:boundaries`.
- Each package has its own `tsconfig.json`; keep provider source inside its package root and avoid cross-package relative imports.
- Run `pnpm lint` after changing this tree. For provider behavior, add tests in the provider package or the relevant desktop messaging adapter test, depending on where the behavior is exercised.
