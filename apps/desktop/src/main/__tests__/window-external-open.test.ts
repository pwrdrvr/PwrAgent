import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/app", getVersion: () => "0.0.0" },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() },
}));

const { isSafeExternalOpenUrl } = await import("../window");

describe("isSafeExternalOpenUrl", () => {
  it("allows the schemes the renderer is expected to hand to the OS", () => {
    expect(isSafeExternalOpenUrl("https://github.com/pwrdrvr/PwrAgnt")).toBe(true);
    expect(isSafeExternalOpenUrl("mailto:ops@example.com")).toBe(true);
    expect(isSafeExternalOpenUrl("file:///Users/x/notes.md")).toBe(true);
    expect(isSafeExternalOpenUrl("http://localhost:5173/")).toBe(true);
  });

  it("refuses PwrAgent's own scheme", () => {
    // Load-bearing. `pwragent://` links come from agent-authored markdown,
    // which is attacker-influenceable. They are resolved in-app by the
    // transcript renderer, which intercepts the click and navigates. If this
    // allowlist ever accepted them, a thread link would round-trip out through
    // the OS to whatever app claims the scheme. Navigation-only, in-app only.
    expect(
      isSafeExternalOpenUrl(
        "pwragent://thread/019f5d79-a595-73f2-84d9-a0976762c303?backend=codex",
      ),
    ).toBe(false);
  });

  it("refuses schemes that execute or exfiltrate", () => {
    expect(isSafeExternalOpenUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalOpenUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeExternalOpenUrl("http://evil.example.com")).toBe(false);
    expect(isSafeExternalOpenUrl("not a url")).toBe(false);
  });
});
