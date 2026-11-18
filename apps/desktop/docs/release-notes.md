# Desktop Release Notes

Moved verbatim from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps
a summary and says when to read this document.

## Release Notes

- The first signed v1.x build is signed under the PwrDrvr LLC Developer ID
  (Team ID `T44CNHC4UH`) with bundle id `com.pwrdrvr.pwragent`. macOS Keychain
  scopes `safeStorage` keys by signing identity + bundle id, so any pre-v1.0
  development build's encrypted secrets at
  `~/.local/state/pwragent/settings-secrets.json` (Telegram / Discord bot
  tokens) WILL fail to decrypt under the new signed build. The
  `desktop-secret-store` returns `undefined` on decrypt failure and prompts the
  user to re-enter the secret in Settings — no crash, no stale ciphertext
  re-used as plaintext. Document this in v1.0.0 release notes for any internal
  testers upgrading from pre-v1.0 dev builds.
- Hardcoded version strings in shipped code are an anti-pattern. Always use
  `app.getVersion()` (main process) or `desktopApi.readAppMetadata()` (renderer)
  so every release reports its real version.
