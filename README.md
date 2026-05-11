# PwrAgent

**Run a coding agent. Drive it from your messenger.**

PwrAgent is a thread-first desktop app that pairs a coding agent with the
chat platforms you already use. Start a thread on your laptop, follow it
from Telegram, approve a destructive command from Discord, hand the
conversation back to the desktop when you're ready to read the diff.

> **Status: beta — macOS only today.** Steady cadence, non-destructive
> between releases.

![PwrAgent Recents view](docs/assets/screenshots/screenshot-recents-hero.png)
<!-- screenshot: screenshot-recents-hero.png — Recents lens populated with several threads, at least one carrying a messenger badge. 1440×900, macOS, light theme. -->

## Why PwrAgent

- **Built for Codex coders.** Full Codex threads on the go — start them
  from your messenger or your desktop and pick up wherever.
- **No-lock-in Codex integration.** Powered by the Codex App Server
  protocol, so your thread list is the same one Codex sees and there's
  no separate login. Try it for a day, use it for a month — switch back
  to the official Codex client whenever.
- **Safe upgrades and downgrades.** Config and state migrate forward
  without breaking older installs. Run two versions side-by-side or
  downgrade after an update without losing settings or threads. See
  [docs/config-file-evolution.md](docs/config-file-evolution.md).
- **Secrets encrypted at rest.** Bot tokens and API keys are encrypted
  with Electron `safeStorage`, backed by macOS Keychain Access. PwrAgent
  refuses to write secrets if the platform reports an unsafe backend.
- **Messaging observability.** See which threads are being driven from
  your messenger and whether your bot is connected, rate-limited, or
  dropping callbacks — all from one card.
- **Pair in minutes.** Paste a bot token, allowlist your platform user
  ID, hit the in-app connection test. No cloud relay, no third-party
  service in the middle.
- **Find threads how you remember them.** Search and filter by branch
  name, PR, emoji marker, or messaging binding — pick whichever you
  actually recall.
- **Markdown composer.** Write in the markdown you already use; the
  composer renders bold, code blocks, links, and the rest.

## Take a look

| | |
|---|---|
| ![Thread bound to a messenger](docs/assets/screenshots/screenshot-bound-thread.png) <br/>*Bound thread — desktop and messenger stay in sync* | ![Messenger status surface](docs/assets/screenshots/screenshot-messenger-status.png) <br/>*Messenger status at a glance* |
| ![Pairing flow](docs/assets/screenshots/screenshot-pairing.png) <br/>*Paste-token pairing with in-app connection test* | ![Approval gate](docs/assets/screenshots/screenshot-closed-by-default.png) <br/>*Closed by default — destructive actions need approval* |

<!-- screenshot: screenshot-bound-thread.png — Thread detail view with the linked messenger context visible. -->
<!-- screenshot: screenshot-messenger-status.png — Settings or status surface showing Telegram/Discord/Mattermost connection state. -->
<!-- screenshot: screenshot-pairing.png — Pairing / binding flow (or a clean settings card if there is no dedicated wizard). -->
<!-- screenshot: screenshot-closed-by-default.png — Approval gate UI / closed state that conveys "the agent isn't acting on its own." -->

## Quick Start

### macOS

1. Grab the latest signed build from the
   [GitHub Releases page](https://github.com/pwrdrvr/PwrAgent/releases).
2. Open the app. PwrAgent stores all config and state under `~/.pwragent/`.
3. (Optional) Pair a messenger from **Settings → Messaging**. You'll need
   a bot token from Telegram, Discord, or Mattermost and your own
   platform user ID for the allowlist.

### From source

```bash
git clone https://github.com/pwrdrvr/PwrAgent.git
cd PwrAgent
pnpm install
pnpm dev
```

Configure your coding-agent credentials either in your shell environment
or in `~/.config/grok-app-server/config.toml`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

## Roadmap

- macOS-first today. Linux and Windows are not yet supported.
- The desktop release pipeline (signing, notarization, auto-update) is
  documented in
  [docs/desktop-release-runbook.md](docs/desktop-release-runbook.md).
- A versioned online docs site is planned; until then, this repository
  is the source of truth.

## Background

PwrAgent grew out of
[openclaw-codex-app-server](https://github.com/pwrdrvr/openclaw-codex-app-server),
a project that aimed to be the best Codex integration-for-coding into Telegram and Discord.
PwrAgent supersedes it: a desktop-first, thread-centric coding-agent
shell with first-class messenger integration, and a generic messaging
protocol that lets a single workflow layer drive Telegram, Discord,
Mattermost, and Slack from the same code path. That protocol is now
stable across 5 messaging providers and is now a candidate submit to OpenClaw.

## Going deeper

- [ARCHITECTURE.md](ARCHITECTURE.md) — process model, storage layers,
  messaging layer summary, dependency boundaries, workspace map.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow, testing,
  replay fixtures, diagnostics, internal agent-core notes.
- [SECURITY.md](SECURITY.md) — how to report vulnerabilities.
- [docs/messaging-architecture.md](docs/messaging-architecture.md) —
  layered messaging architecture, capability profiles, callback delivery
  models.
- [docs/messaging-platform-integration.md](docs/messaging-platform-integration.md)
  — operator setup, command surface, Cloudflare-Tunnel / Tailscale-Funnel
  guidance for HTTP-callback providers.
- [docs/state-layout.md](docs/state-layout.md) — on-disk state layout,
  environment variables, profiles.

## License

PwrAgent is licensed under the [MIT License](LICENSE). Third-party
dependency notices are aggregated in
[THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES) and shipped with desktop
distributions. See
[docs/third-party-license-notices.md](docs/third-party-license-notices.md)
for the Electron/Chromium runtime notice policy.
