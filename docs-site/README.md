# docs-site/

This directory is the source for **docs.pwragent.ai**, served by GitHub
Pages out of `main`. The site uses the default `minima` Jekyll theme; no
custom layouts or assets.

## Local preview

```bash
gem install bundler jekyll
cd docs-site
bundle init
bundle add jekyll
bundle exec jekyll serve --baseurl ""
```

Then open <http://127.0.0.1:4000/>.

## Structure

| Path | Purpose |
|---|---|
| [`index.md`](index.md) | Landing page |
| [`messaging/overview.md`](messaging/overview.md) | Provider-agnostic concepts |
| [`messaging/streaming.md`](messaging/streaming.md) | Why you probably don't want streaming |
| [`messaging/webhook-dangers.md`](messaging/webhook-dangers.md) | Security note on HTTP-callback platforms |
| [`messaging/telegram.md`](messaging/telegram.md), [`discord.md`](messaging/discord.md), [`slack.md`](messaging/slack.md), [`feishu.md`](messaging/feishu.md) | Non-webhook platforms |
| [`messaging/mattermost.md`](messaging/mattermost.md), [`line.md`](messaging/line.md) | HTTP-callback platforms |
| [`CNAME`](CNAME) | Custom domain — `docs.pwragent.ai` |
| [`_config.yml`](_config.yml) | Jekyll config |

## Editing conventions

Each per-platform page follows this structure:

1. One-line description.
2. **What you need to get started** — the bare minimum, single source of credentials.
3. **Step by step** — exact paste/save/test/pair flow from the desktop app's Settings → Messaging panel.
4. **Settings reference** — what each field above and below the Test button does, what the defaults are, and when you'd want to change them.
5. **See also** — links to [`streaming.md`](messaging/streaming.md) for the streaming caveat, [`webhook-dangers.md`](messaging/webhook-dangers.md) for HTTP-callback platforms, and any platform-specific deep links.

Defaults are *the* recommendation. Each setting's "why you might change it" is treated as the rarer case, not the headline.

This is the operator-facing surface. Contributor / architecture content for messaging lives in the main repo under `docs/messaging-*.md`.
