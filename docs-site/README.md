# docs-site/

This directory is the source for **docs.pwragent.ai**, served by GitHub
Pages out of `main`. Custom layouts under [`_layouts/`](_layouts/) and a
single stylesheet at [`assets/css/site.css`](assets/css/site.css) carry
the Tangerine Terminal theme; no Jekyll theme inheritance.

## Local preview

The fastest path is the bundled [Dockerfile](Dockerfile) — works under
restricted Docker Desktop / colima configurations that don't expose
the host filesystem to the VM:

```bash
docker build -t pwragent-docs-site:local docs-site/
docker run --rm -it -p 4000:4000 pwragent-docs-site:local
```

Open <http://localhost:4000/>.

For native local serving (requires Ruby ≥ 3.0 + the gems in
[Gemfile](Gemfile)):

```bash
cd docs-site
bundle install
bundle exec jekyll serve --baseurl ""
```

## Structure

| Path | Purpose |
|---|---|
| [`index.md`](index.md) | Landing page with the hero wordmark and platform table |
| [`using-codex.md`](using-codex.md) | End-to-end usage guide for driving Codex via messaging |
| [`rate-limits.md`](rate-limits.md) | Per-platform write budgets and PwrAgent budget protection |
| [`streaming.md`](streaming.md) | Why you probably don't want streaming |
| [`webhook-dangers.md`](webhook-dangers.md) | Security note on HTTP-callback platforms |
| [`providers/index.md`](providers/index.md) | Providers index — links to the six setup pages |
| [`providers/{telegram,discord,slack,feishu}.md`](providers/) | Non-webhook platforms |
| [`providers/{mattermost,line}.md`](providers/) | HTTP-callback platforms |
| [`_layouts/`](_layouts/) | Custom Jekyll layouts (no theme inheritance) |
| [`assets/css/site.css`](assets/css/site.css) | Tangerine Terminal theme stylesheet |
| [`_config.yml`](_config.yml) | Jekyll config (kramdown + rouge + `jekyll-redirect-from`) |
| [`CNAME`](CNAME) | Custom domain — `docs.pwragent.ai` |

Old `/messaging/<page>/` URLs are preserved via `redirect_from:` front
matter on the new pages; the `jekyll-redirect-from` plugin (included
in the `github-pages` gem) renders meta-refresh stubs at the old paths.

## Editing conventions

Each per-platform setup page follows this structure:

1. One-line description.
2. **What you need to get started** — the bare minimum credentials.
3. **Step by step** — exact paste/save/test/pair flow from the desktop's Settings → Messaging panel.
4. **Settings reference** — what each field above and below the Test button does, defaults, when to change.
5. **See also** — links to [`streaming.md`](streaming.md), [`webhook-dangers.md`](webhook-dangers.md), and the [usage guide](using-codex.md).

Defaults are *the* recommendation. Each setting's "why you might change it" is treated as the rarer case, not the headline.

`using-codex.md` is the operator-facing usage guide. It assumes a paired
bot and walks through bindings, commands, the resume browser, queue-and-
steer, monitor cards, and detach. Per-provider exceptions live inline
inside collapsed `<details>` blocks next to the section they qualify.

This is the operator-facing surface. Contributor / architecture content
for messaging lives in the main repo under `docs/messaging-*.md`.
