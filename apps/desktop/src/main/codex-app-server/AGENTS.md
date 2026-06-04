# Codex App Server Adapter Guidance

The Codex App Server wire protocol types come from `@pwrdrvr/codex-app-server-protocol`. Do not add desktop-local protocol mirrors here.

Use the stable surface by default. Only pass `--experimental` when the desktop client intentionally opts into experimental App Server APIs during `initialize`.

The published types model the Codex wire protocol. Keep desktop-facing contracts in `@pwragent/shared` normalized to PwrAgent concepts, and do Codex-specific alias handling only at this adapter boundary.
