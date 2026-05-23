---
layout: page
title: Linux Install
permalink: /linux/
---

# Install PwrAgent on Linux

PwrAgent publishes Debian packages for Ubuntu and other Debian-based desktop
Linux distributions. The package installs the desktop app and registers a
launcher entry named **PwrAgent** in your desktop environment.

PwrAgent does not bundle or install Codex CLI. Install Codex separately, then
use **Settings -> Applications** in PwrAgent if you need to refresh discovery.

## Choose a package

Download the package that matches your machine from the latest GitHub release:

| Machine | Download |
|---|---|
| Intel / AMD PC (`amd64`) | [PwrAgent-linux-x64.deb](https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent-linux-x64.deb) |
| ARM64 (`arm64`) | [PwrAgent-linux-arm64.deb](https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent-linux-arm64.deb) |

Release assets also include versioned package names and `SHA256SUMS`.

## Verify the download

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

## Install

From the directory where you downloaded the package:

```bash
sudo apt install ./PwrAgent-linux-x64.deb
```

Use `PwrAgent-linux-arm64.deb` instead on ARM64.

After installation, launch PwrAgent from your app menu or run:

```bash
pwragent
```

## Upgrade

Download the newer `.deb` and install it over the current version:

```bash
sudo apt install ./PwrAgent-linux-x64.deb
```

Linux builds do not auto-update from inside the app. PwrAgent will keep its
state under `~/.pwragent/` across package upgrades.

## Uninstall

Remove the app package:

```bash
sudo apt remove pwragent
```

This keeps your PwrAgent profile data. To remove local PwrAgent state too:

```bash
rm -rf ~/.pwragent
```

Codex CLI and its authentication are managed separately by Codex and are not
removed by uninstalling PwrAgent.
