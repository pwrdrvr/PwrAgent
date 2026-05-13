# docs-site screenshot shot list

This file documents the desktop-side screenshots that should appear
on `docs.pwragent.ai`. The README's existing screenshots already
cover the marketing surface; everything below extends that pattern
to the operator-facing site.

## Capture pipeline (reuse the README pattern)

The README screenshots are produced by an inspect-style Playwright
spec at
[`apps/desktop/e2e/readme-screenshots.inspect.spec.ts`](../../../apps/desktop/e2e/readme-screenshots.inspect.spec.ts)
that drives known UI surfaces, shells out to
[`apps/desktop/scripts/capture-window.swift`](../../../apps/desktop/scripts/capture-window.swift)
for native macOS window capture (stoplights + drop shadow + retina),
and seeds desktop state via
[`apps/desktop/e2e/fixtures/readme-state-seeding.ts`](../../../apps/desktop/e2e/fixtures/readme-state-seeding.ts).

The same pattern applies here. The implementation should:

1. Add a new spec at
   `apps/desktop/e2e/docs-site-screenshots.inspect.spec.ts`
   gated behind a new env flag (e.g. `PWRAGENT_DOCS_SITE_CAPTURE=1`).
2. Add per-surface state seeders in
   `apps/desktop/e2e/fixtures/docs-site-state-seeding.ts` (Settings →
   Messaging panels need TOML pre-seeded with adapter config so the
   form has interesting content; status-card / resume-browser shots
   reuse the existing replay-fixture machinery).
3. Add a `screenshot:docs-site` script to
   `apps/desktop/package.json`, parallel to `screenshot:readme`.
4. Document the regen flow in
   [`apps/desktop/AGENTS.md`](../../../apps/desktop/AGENTS.md) next to
   the existing "Capturing README Screenshots" section.

Each capture should drop its PNG straight into this directory under
the filename listed below, matching the `<!-- screenshot: ... -->`
HTML-comment placeholder that already exists in the corresponding
doc page.

## Settings panels (per-provider config screens)

These show what each platform's setup page looks like in the
desktop's Settings → Messaging → \<platform\> panel.

| Filename | Doc page | Surface | State to seed |
|---|---|---|---|
| `settings-messaging-telegram.png` | [/providers/telegram/](../../../docs-site/providers/telegram.md) | Settings → Messaging → Telegram | Telegram enabled, bot-token field populated (use a fake non-real token), one authorized user ID, Test button visible. |
| `settings-messaging-discord.png` | [/providers/discord/](../../../docs-site/providers/discord.md) | Settings → Messaging → Discord | Discord enabled, bot token + Application ID populated, one authorized user ID, Test button visible. |
| `settings-messaging-slack.png` | [/providers/slack/](../../../docs-site/providers/slack.md) | Settings → Messaging → Slack | Slack enabled, both Bot Token and App Token populated, Inbound Mode = Socket Mode, one authorized user ID. |
| `settings-messaging-mattermost.png` | [/providers/mattermost/](../../../docs-site/providers/mattermost.md) | Settings → Messaging → Mattermost | Mattermost enabled, bot token + server URL + callback base URL populated, HMAC-secret field with a placeholder hex value, one authorized user ID. |
| `settings-messaging-feishu.png` | [/providers/feishu/](../../../docs-site/providers/feishu.md) | Settings → Messaging → Feishu / Lark | Feishu enabled, App ID + App Secret populated, tenant region set to Feishu, Inbound Mode = persistent, one authorized open_id. |
| `settings-messaging-line.png` | [/providers/line/](../../../docs-site/providers/line.md) | Settings → Messaging → LINE | LINE enabled, channel secret populated, local listener URL filled in, Public Webhook URL filled in (use a placeholder tunnel hostname), one authorized user ID. |

## Settings — non-messaging

| Filename | Doc page | Surface | State to seed |
|---|---|---|---|
| `settings-applications.png` | [/settings/](../../../docs-site/settings.md) | Settings → Applications | All four tools discovered (Terminal, Editor, git, gh). Show auto-discovered paths. |
| `settings-worktrees.png` | [/settings/](../../../docs-site/settings.md) | Settings → Worktrees | Default storage path shown (`~/.pwragent/worktrees/`). |
| `settings-models.png` | [/settings/](../../../docs-site/settings.md) | Settings → Models | Codex App Server version shown, source path (Codex Desktop or CLI), logged-in account shown, model list populated. |

## Desktop app feature shots

| Filename | Doc page | Surface | State to seed |
|---|---|---|---|
| `desktop-recents.png` | [/desktop/](../../../docs-site/desktop.md) | Recents lens populated | Reuse [`readme-recents-hero` replay fixture](../../../apps/desktop/e2e/fixtures/readme-recents-hero/replay.fixture.json) but without the messenger badge requirement (this shot is about the desktop UX itself, not the messaging surface). |
| `desktop-worktree-picker.png` | [/desktop/](../../../docs-site/desktop.md) | Handoff dialog | A thread bound to Local with handoff metadata; trigger Handoff from the status card so the Local → Worktree picker is open. |
| `desktop-status-card.png` | [/using-codex/](../../../docs-site/using-codex.md) | Bound-thread status card | A thread with a messaging binding; status card showing Model / Reasoning / Fast / Permissions / Tools / Stream / Skills / Refresh / Detach. |
| `desktop-resume-browser.png` | [/using-codex/](../../../docs-site/using-codex.md) | Resume Thread browser | The desktop equivalent of the messaging-side resume browser — recents picker, paginated. |

## Messenger-side captures

Captures inside Telegram / Slack / Discord / Mattermost / Feishu /
LINE clients showing PwrAgent bot behavior (status cards, approval
prompts, monitor cards, etc.) are tracked separately at
[pwrdrvr/PwrAgent#345](https://github.com/pwrdrvr/PwrAgent/issues/345).

That work is materially harder than these desktop-side captures
because driving messenger native clients programmatically (or
running real bot sessions reproducibly for screenshot capture) is
its own pipeline build-out. The placeholder image references in
[/using-codex/](../../../docs-site/using-codex.md) and each
provider page point at file paths that will exist once #345 lands.

## Placeholder convention

Every needed capture has a `<!-- screenshot: <filename> — <hint> -->`
HTML-comment placeholder in the doc page where it'll eventually
land. Search the docs-site for `<!-- screenshot:` to find them
all. When the capture infrastructure lands, the script writes the
PNG to this directory and the rendered Markdown picks it up
automatically (no doc edits needed beyond uncommenting the
placeholder, if we choose to ship explicit `![]()` references
later).
