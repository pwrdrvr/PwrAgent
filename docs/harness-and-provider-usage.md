# Harness Auth and Provider Usage

Read this before adding or changing usage limits, account or quota probes, sign-in flows, or anything else that touches a harness's credentials.

## The rule

PwrAgent never uses a harness's own credentials to call that vendor's API.

- Do not extract, copy, or refresh a harness's auth token, keyring secret, OAuth file, or session credential.
- Do not call a provider's API with that credential, and do not impersonate the harness's User-Agent or client identity.
- Talk to the vendor only through the harness's supported protocol (Codex App Server, the Claude Agent SDK, ACP) or through the vendor's own CLI, so the vendor's binary makes the request.

If the supported protocol or CLI does not expose what you want, such as a quota bucket or a plan tier, PwrAgent does not show it. Ask the vendor to expose it; do not work around the gap.

## Why

A subscription login is granted to the vendor's client, not to every program on the machine. Several vendors say so in their terms, and they enforce it against the user's account, not against PwrAgent. An operator can lose their subscription because PwrAgent read a token it was never meant to have. Internal endpoints also change without notice, so a workaround breaks even when nobody objects.

When the vendor's binary makes the request, the vendor sees its own client, its own rate limits, and its own auth refresh. PwrAgent only reads what that binary chooses to report.

## The Antigravity incident

t3code was asked to remove its Antigravity usage-limit reporting. t3code read the Antigravity CLI's OAuth token from the OS keyring or an `antigravity-oauth-token` file. It then called `v1internal:retrieveUserQuotaSummary` and `v1internal:fetchAvailableModels` on `https://cloudcode-pa.googleapis.com` and `https://daily-cloudcode-pa.googleapis.com`, sending a forged `antigravity/hub/...` User-Agent. t3code removed that code on 2026-11-25 in [pingdotgg/t3code#43026](https://github.com/pingdotgg/t3code/pull/43026). Julius Marminge confirmed that the violation was calling the internal API instead of using ACP.

PwrAgent runs Antigravity threads through the official ACP server (`agy acp`). Its on-demand quota reader uses the official CLI's headless `agy --print /usage` command and parses the command output. Google describes third-party headless wrapping as unsupported under consumer plans. The refresh interval controls traffic and confers no provider permission. See the [ACP guide](https://antigravity.google/docs/ide/extensions/acp) and [Google's headless CLI FAQ](https://antigravity.google/docs/faq/#can-i-use-antigravity-cli-headless-mode-in-third-party-coding-agents-or-automate-account-switching).

Only a usage gesture from a visible, focused window can request this CLI read. The owning PwrAgent root allows one attempt at a time, followed by at least 15 minutes before another gesture can launch the CLI. The cooldown covers unsuccessful attempts and survives restarts and profile switches. A successful reading stays cached in the owner with its observation time. The cooldown is shared across profiles in the same root. Separate machines and separate roots have independent cooldowns.

## Every harness, not only Antigravity

The same boundary applies to every backend PwrAgent integrates:

- No token extraction from keyrings, credential files, or environment variables a harness set up for itself.
- No direct quota, account, model-list, or billing calls made with the harness's credential.
- No scraping a harness's local session database, rollout files, or logs as a substitute for a protocol field. Local session stores are not a side door for quota or account data.

This document adds to the [Codex data boundary](../apps/desktop/docs/codex-data-boundary.md) and does not weaken it. PwrAgent still never reads Codex-owned session JSONL, rollout files, or SQLite databases, and `pnpm lint:codex-storage` still enforces that.

Current usage sources follow the rule: Codex rate limits come from App Server `account/rateLimits`, Claude limits come from the Agent SDK's rate-limit events, and Antigravity usage comes from `agy --print /usage`.

An API key the operator enters in PwrAgent Settings for PwrAgent's own use is not a harness credential. This rule covers credentials that a harness's own sign-in created.

## Vendor terms

These are the terms for each harness PwrAgent ships, linked from each vendor's own site. Read the current text before you build anything near the boundary.

| Harness | Vendor | Terms |
| --- | --- | --- |
| Codex | OpenAI | [Terms of Use](https://openai.com/policies/terms-of-use/) (no sharing account credentials; no circumventing rate limits), [Usage Policies](https://openai.com/policies/usage-policies/) |
| Claude | Anthropic | [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) ("Authentication and credential use": third parties may not offer Claude.ai login or route requests through plan credentials), [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) |
| Grok | xAI | [Terms of Service, Consumer](https://x.ai/legal/terms-of-service), [Terms of Service, Enterprise](https://x.ai/legal/terms-of-service-enterprise), [Acceptable Use Policy](https://x.ai/legal/acceptable-use-policy) |
| Antigravity | Google | [Antigravity Additional Terms of Service](https://antigravity.google/terms) (section 6: third-party software accessing the service, including using Antigravity OAuth from another client, is a breach) |
| Gemini CLI | Google | [Gemini CLI terms and privacy](https://www.geminicli.com/docs/resources/tos-privacy) (directly accessing the services behind Gemini CLI with third-party software, such as reusing its OAuth, violates the terms) |
| Qwen Code | Alibaba (Qwen) | [Qwen Code terms and privacy](https://github.com/QwenLM/qwen-code/blob/main/docs/users/support/tos-privacy.md), [Qwen Terms of Service](https://qwen.ai/termsservice) |
| Kimi Code | Moonshot AI | No general terms page is published for Kimi Code. Its [membership rules](https://www.kimi.com/code/docs/kimi-code/membership.html) share one quota across devices and say that spoofing the client User-Agent violates them. |

Add a row when PwrAgent ships a new harness. Link only a page on the vendor's own site; if the vendor publishes none, say so.
