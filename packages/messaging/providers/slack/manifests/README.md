# Official Slack app manifest

PwrAgent maintains this Slack **manifest**, not a Slack **app**.

`pwragent-slack-app.v2.json` and `pwragent-slack-app.v2.yaml` are generated
from `src/slack-app-manifest.ts` and pinned by unit tests. The v1 files remain
as the historical install artifact. Settings and onboarding open Slack's
create-from-manifest URL with the current JSON document.

Do not put a PwrAgent client secret, OAuth redirect, or Marketplace listing
here. Token rotation, PKCE, and org-wide deploy stay off. Socket Mode stays
on.

Operator walkthroughs live in the docs.pwragent.ai repo (`providers/slack`).
This folder is the contributor source of truth for scopes, events, and the
nine `pwragent_*` slash commands.
