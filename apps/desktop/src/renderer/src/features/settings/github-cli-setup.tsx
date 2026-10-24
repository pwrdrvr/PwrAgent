import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsCopyValue } from "./SettingsCopyValue";
import { SettingsField } from "./SettingsLayout";

const INSTALL_GUIDE = "https://github.com/cli/cli#installation";
const LINUX_INSTALL_GUIDE = "https://github.com/cli/cli/blob/trunk/docs/install_linux.md";

// gh 2.99.0 introduced --attach for PR creation, edits, and comments.
// https://github.com/cli/cli/releases/tag/v2.99.0
export function isGhVersionTooOldForAttachments(version: string | undefined): boolean {
  const match = version?.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  return major < 2
    || (major === 2 && minor < 99)
    || (major === 2 && minor === 99 && patch === 0 && Boolean(match[4]));
}

// Add the upstream repository even when gh is already installed: Ubuntu's
// own repository can leave apt's candidate below the attachment minimum.
const UBUNTU_DEBIAN_COMMAND = [
  "(",
  "  set -e",
  "  sudo apt update",
  "  sudo apt install -y curl",
  "  sudo mkdir -p -m 755 /etc/apt/keyrings /etc/apt/sources.list.d",
  "  gh_keyring_file=$(mktemp)",
  "  trap 'rm -f \"$gh_keyring_file\"' EXIT",
  "  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o \"$gh_keyring_file\"",
  "  sudo install -m 644 \"$gh_keyring_file\" /etc/apt/keyrings/githubcli-archive-keyring.gpg",
  "  echo \"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" \\",
  "    | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null",
  "  sudo apt update",
  "  sudo apt install gh",
  ")",
].join("\n");

export function GitHubCliSetup(props: {
  desktopApi?: DesktopApi;
  upgrade?: boolean;
  version?: string;
}) {
  const platform = props.desktopApi?.platform;
  const command = platform === "darwin"
    ? `brew ${props.upgrade ? "upgrade" : "install"} gh`
    : platform === "win32"
      ? `winget ${props.upgrade ? "upgrade" : "install"} --id GitHub.cli --exact --source winget`
      : platform === "linux"
        ? UBUNTU_DEBIAN_COMMAND
        : undefined;
  const instructions = platform === "darwin"
    ? "Run in Terminal with Homebrew installed."
    : platform === "win32"
      ? "Run in PowerShell with WinGet installed. Open a new terminal window afterward."
      : platform === "linux"
        ? "On Ubuntu or Debian, add GitHub's official APT repository. Your distribution's repository may ship an older gh. For other Linux distributions, use the install guide."
        : "Use GitHub's install guide to choose a method for your system.";

  return (
    <SettingsField
      label={`${props.upgrade ? "Upgrade" : "Install"} GitHub CLI`}
      sub={instructions}
      control={
        <div className="settings-gh-status">
          {props.upgrade ? (
            <span className="settings-warning" role="status">
              GitHub CLI {props.version} cannot attach images or videos to pull requests
              using --attach. Upgrade to 2.99.0 or newer.
            </span>
          ) : null}
          {command ? (
            platform === "linux" ? (
              <details className="settings-gh-setup__commands">
                <summary>Ubuntu / Debian commands</summary>
                <SettingsCopyValue value={command} desktopApi={props.desktopApi} label="GitHub CLI setup commands" />
              </details>
            ) : (
              <SettingsCopyValue value={command} desktopApi={props.desktopApi} label="GitHub CLI setup command" />
            )
          ) : null}
          {platform === "linux" ? (
            <span className="settings-pathrow__path settings-gh-status__reason">
              Without sudo, download the Linux archive for your architecture from the latest
              release, verify it against the release checksums file, and extract its
              <code> bin/gh</code> to <code>~/.local/bin/gh</code>. Select that path below.
            </span>
          ) : null}
          <span className="settings-pathrow__path settings-gh-status__reason">
            After installing, enable GitHub checks if they are off, then click Re-check
            and select the updated path under Available paths.
            Use Choose… if it is not detected.
          </span>
          <div className="settings-inline-actions">
            <a
              className="button button--secondary"
              href={platform === "linux" ? LINUX_INSTALL_GUIDE : INSTALL_GUIDE}
              target="_blank"
              rel="noreferrer"
            >
              Open install guide
            </a>
            <a
              className="button button--secondary"
              href="https://github.com/cli/cli/releases/latest"
              target="_blank"
              rel="noreferrer"
            >
              Download latest release
            </a>
          </div>
        </div>
      }
    />
  );
}
