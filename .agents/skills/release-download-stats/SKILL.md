---
name: release-download-stats
description: Check and summarize PwrAgent GitHub Release asset download statistics. Use when the user asks for download counts, bytes served, DMG, ZIP, Windows Setup.exe, or updater traffic, per-release stats, or whether GitHub Releases show any traffic.
---

# Release Download Stats

Use this skill to inspect GitHub Release asset metadata for
`pwrdrvr/PwrAgent`. It reports cumulative GitHub `download_count` values for
release assets; it does not identify users and it does not count update-check
polls.

## Workflow

1. Run the bundled script from the repo root:

   ```bash
   python3 .agents/skills/release-download-stats/scripts/release_download_stats.py
   ```

2. For specific releases, pass exact tags or PwrAgent shorthand:

   ```bash
   python3 .agents/skills/release-download-stats/scripts/release_download_stats.py beta.22 beta.21 beta.20
   ```

3. For the latest N releases:

   ```bash
   python3 .agents/skills/release-download-stats/scripts/release_download_stats.py --latest 5
   ```

4. Summarize the results in the response. Prefer:
   - ZIP updater downloads separately from DMG downloads.
   - `PwrAgent.dmg` stable alias separately from versioned DMG assets.
   - Total DMG as `stable alias + versioned DMG` only when useful.
   - `PwrAgent.Setup.exe` and unversioned `PwrAgent-windows-*-setup.exe` aliases separately from versioned `PwrAgent-*-windows-*-setup.exe` assets.
   - Total Windows setup traffic as `stable alias + versioned setup` only when useful.
   - GiB totals for approximate transfer volume.

## Interpretation Rules

- Treat GitHub values as cumulative per asset, not per day.
- State that GitHub does not distinguish manual downloads, bots, CI, or
  auto-updater downloads.
- State that update-check polls against `latest-mac.yml` or `latest.yml` are
  not represented by these installer-asset counts.
- When both `PwrAgent.dmg` and a versioned `.dmg` are present, do not collapse
  them unless the user asks for total DMG traffic.
- Apply the same separation to a stable `Setup.exe` alias and versioned setup
  executables.
- Use UTC timestamps unless the user asks for a local timezone conversion.

## Common Commands

Print markdown tables:

```bash
python3 .agents/skills/release-download-stats/scripts/release_download_stats.py beta.22 beta.21 beta.20
```

Emit JSON for further processing:

```bash
python3 .agents/skills/release-download-stats/scripts/release_download_stats.py --json --latest 10
```
