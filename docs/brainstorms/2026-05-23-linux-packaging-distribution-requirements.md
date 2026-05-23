---
date: 2026-05-23
topic: linux-packaging-distribution
---

# Linux Packaging And Distribution

## Summary

PwrAgent will add a first Linux distribution path focused on Ubuntu/Debian:
manual `.deb` downloads for `amd64` and `arm64`, published as assets on the
existing public GitHub Releases page. The package installs PwrAgent as a normal
desktop app with launcher integration, while Codex CLI remains a user-managed
prerequisite discovered by onboarding and documented setup.

---

## Problem Frame

The desktop app now runs successfully on Ubuntu in a graphical Linux VM. That
makes Linux support viable without a large porting effort, but distribution
still needs a low-maintenance first shape. The target user is a developer who
already knows how to install tools, likely already has Codex CLI or is willing
to install it separately, and mainly needs a trustworthy way to install
PwrAgent itself.

Cost and carrying cost matter. The project should avoid standing up custom
hosting, store packaging, or package-repository infrastructure before there is
clear Linux demand. Snap and Flatpak are unattractive first targets because the
app is a software-development agent that needs to work with host filesystems,
local shells, Git repositories, and user-installed CLI tools.

---

## Actors

- A1. Linux developer: Installs and runs PwrAgent on Ubuntu/Debian, then uses
  onboarding to connect local Codex CLI and credentials.
- A2. Maintainer: Builds release artifacts, uploads them to GitHub Releases,
  manually smoke-tests Linux packages, and documents install and removal.
- A3. PwrAgent app: Launches as a native desktop app and verifies agent
  prerequisites at runtime instead of assuming the package installed them.

---

## Key Flows

- F1. First Linux install
  - **Trigger:** A Linux developer wants to try PwrAgent on Ubuntu/Debian.
  - **Actors:** A1, A3
  - **Steps:** The developer downloads the architecture-matching `.deb` from
    GitHub Releases, installs it with Ubuntu/Debian tooling, launches PwrAgent
    from the desktop app menu, and completes onboarding prerequisite checks.
  - **Outcome:** PwrAgent is installed, discoverable from the desktop launcher,
    and ready to use once user-managed prerequisites are configured.
  - **Covered by:** R1, R2, R3, R4, R7

- F2. Manual Linux upgrade
  - **Trigger:** A newer PwrAgent release is available.
  - **Actors:** A1
  - **Steps:** The developer downloads the newer `.deb` for the same
    architecture and installs it over the existing package using documented
    commands.
  - **Outcome:** The installed PwrAgent version updates without introducing an
    apt repository or in-app auto-update requirement.
  - **Covered by:** R5, R8

- F3. Linux uninstall
  - **Trigger:** A developer wants to remove PwrAgent from the Linux machine.
  - **Actors:** A1
  - **Steps:** The developer follows docs to remove the package and separately
    decides whether to keep or delete profile/config state.
  - **Outcome:** The app package and launcher are removed cleanly, and retained
    user data behavior is explicit.
  - **Covered by:** R6, R8

---

## Requirements

**Package artifacts**
- R1. Each public desktop release must include Linux `.deb` artifacts for both
  `amd64` and `arm64`.
- R2. Linux artifacts must be published on the existing public GitHub Releases
  page, alongside the macOS artifacts for the same version.
- R3. The Linux `.deb` package must install PwrAgent itself only. It must not
  install Codex CLI, 1Password, OpenAI credentials, xAI credentials, messaging
  platform credentials, or other user-managed agent prerequisites.
- R4. The package must integrate with the desktop app launcher/menu so users
  can start PwrAgent without running a terminal command after installation.
- R5. Manual upgrades by installing a newer `.deb` over an existing package
  must be a supported path.
- R6. Uninstall must remove the application package and launcher integration
  cleanly. Docs must distinguish package removal from optional deletion of
  `~/.pwragent/` profile/config/state data.

**Docs and release presentation**
- R7. Public docs must provide Ubuntu/Debian install instructions, including
  how to choose `amd64` versus `arm64`, install from a downloaded `.deb`, launch
  the app, and handle Codex CLI as a separate prerequisite.
- R8. Public docs must provide manual upgrade and uninstall instructions for
  Linux.
- R9. GitHub Releases must include checksums for Linux artifacts so users can
  verify downloads before installing.
- R10. Release notes must make clear that the first Linux channel is manual
  download/install, not an apt repository or app-store channel.

**Scope control**
- R11. The first Linux release must not require a new hosting service, CDN,
  Cloudflare R2 bucket, S3 bucket, or custom download service.
- R12. The first Linux release must not require a dedicated apt repository,
  Snap package, Flatpak package, AppImage artifact, or Linux auto-update flow.
- R13. The maintainer must be able to manually smoke-test the first Linux
  package before announcing or documenting it as supported.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R4, R7.** Given a release with Linux artifacts, when an
  Ubuntu `amd64` user downloads and installs the matching `.deb`, PwrAgent
  appears in the desktop app launcher and can be opened from the graphical
  environment.
- AE2. **Covers R1, R2, R4, R7.** Given a release with Linux artifacts, when an
  Ubuntu `arm64` user installs the matching `.deb` in a VM, PwrAgent appears in
  the desktop app launcher and opens successfully.
- AE3. **Covers R3, R7.** Given Codex CLI is not installed, when the user
  installs and opens PwrAgent from the Linux `.deb`, the package install itself
  does not attempt to install Codex CLI; onboarding/docs direct the user to
  install or configure it separately.
- AE4. **Covers R5, R8.** Given PwrAgent v1 is installed from a `.deb`, when the
  user installs v2 from a newer `.deb`, the app package updates through the
  documented manual path.
- AE5. **Covers R6, R8.** Given PwrAgent is installed on Ubuntu, when the user
  follows uninstall instructions, the package and launcher entry are removed
  and the docs explicitly state whether user data remains.

---

## Success Criteria

- A Linux developer can install PwrAgent on Ubuntu/Debian from GitHub Releases
  without using a custom download host or package repository.
- Installed PwrAgent appears in the desktop menu/launcher on Ubuntu.
- A maintainer can produce and manually test both `amd64` and `arm64` `.deb`
  artifacts without building a larger Linux release automation system first.
- Public docs are clear enough that a user can install, upgrade, uninstall, and
  understand the separate Codex CLI prerequisite without maintainer handholding.
- Planning can proceed without inventing package scope, distribution channel,
  first architectures, update expectations, or Linux non-goals.

---

## Scope Boundaries

- Snap Store distribution is out of scope for the first Linux release.
- Flatpak and Flathub distribution are out of scope for the first Linux release.
- AppImage is deferred until there is concrete demand from non-Debian Linux
  users.
- A hosted apt repository and automatic package updates are deferred until
  manual `.deb` upgrades become painful or Linux demand justifies the
  maintenance.
- Cloudflare R2, AWS S3, CloudFront, or any custom download service are out of
  scope while GitHub Releases are adequate.
- The Linux package will not install Codex CLI or credential-management tools.
- A full CI smoke-test workflow for Linux packages is out of scope for the
  first pass; manual maintainer smoke-testing is acceptable.

---

## Key Decisions

- GitHub Releases are the first Linux distribution channel: the repo is public,
  GitHub Releases have enough asset limits for this stage, and this avoids new
  hosting cost.
- `.deb` is the first package format: it matches the tested Ubuntu path and
  gives native installation and desktop launcher integration with less friction
  than store or portable formats.
- `amd64` and `arm64` both ship in the first Linux artifact set: `amd64` covers
  the most common Linux desktop machines, while `arm64` matches the current
  Apple Silicon VM test environment.
- Updates are manual for now: users install newer `.deb` files themselves,
  avoiding apt repository and Linux auto-update maintenance before demand is
  proven.
- Codex CLI remains user-managed: PwrAgent onboarding should detect and guide,
  not package or mutate the user's development toolchain.

---

## Dependencies / Assumptions

- The current macOS release pipeline is electron-builder-based, but current
  release scripting and GitHub Actions are macOS-centered. Linux packaging work
  will need to extend that release shape rather than assume Linux artifacts
  already exist.
- GitHub Releases remain suitable for binary distribution at this scale. GitHub
  currently documents up to 1000 release assets per release, individual assets
  under 2 GiB, and no total release size or bandwidth limit.
- Cloudflare R2 and AWS S3 remain fallback hosting options if GitHub Releases
  become insufficient. R2 currently has free egress and a monthly free tier;
  AWS S3 currently provides limited free data transfer but still adds billing
  and infrastructure surface.
- The first Linux support claim is Ubuntu/Debian-oriented. Other distros may
  work, but are not the supported install target until additional artifacts are
  added.

---

## Outstanding Questions

### Resolve Before Planning

(none)

### Deferred to Planning

- [Affects R1, R13][Technical] Decide where Linux builds run first: local Linux
  VM, GitHub Actions Linux runners, or both.
- [Affects R1][Technical] Confirm whether cross-building `amd64` and `arm64`
  `.deb` artifacts is reliable for the native Electron modules in the package,
  or whether each architecture needs a native Linux build.
- [Affects R4][Technical] Confirm the exact Linux icon and desktop-entry assets
  needed for a polished launcher entry.
- [Affects R9][Technical] Decide checksum format and release-note placement,
  such as one `SHA256SUMS` file per release versus inline checksums.

---

## Sources

- GitHub Docs, "About releases": release assets may be attached to releases;
  each asset must be under 2 GiB, up to 1000 assets per release, with no total
  release size or bandwidth limit.
- Electron Builder docs: Linux package targets include `.deb`, AppImage, RPM,
  Snap, and related Linux metadata/desktop-entry configuration.
- Cloudflare R2 pricing docs: R2 has free egress and a Standard-storage free
  tier, making it a plausible fallback hosting option.
- AWS S3 pricing docs: S3 includes limited free data transfer out but still
  introduces object-storage billing and operational surface.
