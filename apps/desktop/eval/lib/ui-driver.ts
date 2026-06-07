/**
 * Composer UI driver (EVAL_DRIVE_UI=1). Drives the REAL new-thread composer
 * through the DOM so the eval validates what a user actually sees: that the
 * project, provider, and access-mode controls are present, list the expected
 * options, and are selectable — then creates the thread by clicking "Start
 * thread". The turn itself is still observed via the IPC driver.
 *
 * Selectors are sourced from the current component tree (role/name based) and
 * mirror the passing e2e specs (e.g. the "Enable Full Access?" dialog). Because
 * they're DOM-coupled they're the most fragile part of the eval; every step is
 * labeled and screenshots on failure so a broken selector is obvious. The
 * caller falls back to IPC thread creation if a UI step throws, so a selector
 * drift never aborts the whole grid.
 */
import path from "node:path";
import type { Page } from "@playwright/test";
import type { BackendKind, ExecutionMode } from "./driver";

/** backend.kind → the label shown in the composer's Provider dropdown. */
export function backendLabel(kind: BackendKind): string {
  switch (kind) {
    case "codex":
      return "OpenAI";
    case "acp:gemini":
      return "Gemini";
    case "acp:grok":
      return "Grok";
    case "acp:kimi":
      return "Kimi";
    case "acp:qwen":
      return "Qwen";
    case "grok":
      return "AgentCore - Grok";
    default:
      return kind.startsWith("acp:") ? kind.slice(4) : kind;
  }
}

function accessLabel(mode: ExecutionMode): string {
  return mode === "full-access" ? "Full Access" : "Default Access";
}

/** What the composer offered the user, recorded for the grid. */
export type ControlAudit = {
  providerOffered: boolean;
  accessModesOffered: string[];
};

export class UiDriver {
  constructor(
    private readonly page: Page,
    private readonly screenshotDir: string,
  ) {}

  private composer() {
    return this.page.locator("form.composer");
  }

  async screenshot(name: string): Promise<void> {
    await this.page
      .screenshot({ path: path.join(this.screenshotDir, `${name}.png`) })
      .catch(() => undefined);
  }

  /** Open the new-thread launchpad for a directory shown in the sidebar. */
  async openLaunchpad(dirLabel: string): Promise<void> {
    // The directory rows live under the "Directories" sidebar tab (role=tab,
    // not button — clicking the wrong role silently no-ops and the launchpad
    // button never renders).
    const dirTab = this.page.getByRole("tab", { name: "Directories", exact: true });
    await dirTab.waitFor({ state: "visible", timeout: 15_000 });
    await dirTab.click();
    const launch = this.page.getByRole("button", {
      name: `Open new thread launchpad for ${dirLabel}`,
    });
    await launch.first().click({ timeout: 15_000 });
    // Wait for the launchpad composer (the "New thread" textbox) to mount.
    await this.page
      .getByRole("textbox", { name: "New thread" })
      .waitFor({ state: "visible", timeout: 15_000 });
  }

  /** Open a composer dropdown by its aria-label and return the option labels. */
  private async openDropdownOptions(ariaLabel: string): Promise<string[]> {
    const trigger = this.composer().getByRole("button", { name: ariaLabel, exact: true });
    await trigger.first().click({ timeout: 10_000 });
    const options = this.page.getByRole("option");
    await options.first().waitFor({ state: "visible", timeout: 10_000 });
    return (await options.allInnerTexts()).map((t) => t.replace(/[✓\s]+/g, " ").trim());
  }

  /**
   * Assert the Provider dropdown offers `kind` and select it. Returns false if
   * the dropdown isn't present (single-backend case — provider is fixed text).
   */
  async selectProvider(kind: BackendKind): Promise<boolean> {
    const label = backendLabel(kind);
    const trigger = this.composer().getByRole("button", { name: "Provider", exact: true });
    if (!(await trigger.first().isVisible().catch(() => false))) {
      return false;
    }
    const offered = await this.openDropdownOptions("Provider");
    if (!offered.some((o) => o.includes(label))) {
      await this.screenshot(`provider-missing-${kind.replace(/[:]/g, "_")}`);
      throw new Error(
        `Provider dropdown did not offer "${label}" (saw: ${offered.join(", ")})`,
      );
    }
    await this.page.getByRole("option", { name: label, exact: true }).first().click();
    return true;
  }

  /**
   * Assert the Access-mode dropdown offers both Default + Full Access, select
   * `mode`, and accept the Full-Access risk dialog if it appears. Returns the
   * offered option labels.
   */
  async selectAccessMode(mode: ExecutionMode): Promise<string[]> {
    const offered = await this.openDropdownOptions("Access mode");
    for (const expected of ["Default Access", "Full Access"]) {
      if (!offered.some((o) => o.includes(expected))) {
        await this.screenshot("access-mode-missing");
        throw new Error(
          `Access-mode dropdown did not offer "${expected}" (saw: ${offered.join(", ")})`,
        );
      }
    }
    await this.page
      .getByRole("option", { name: accessLabel(mode), exact: true })
      .first()
      .click();
    if (mode === "full-access") {
      const dialog = this.page.getByRole("dialog", { name: "Enable Full Access?" });
      if (await dialog.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await dialog
          .getByRole("button", { name: "I Understand and Accept the Risks" })
          .click()
          .catch(() => undefined);
      }
    }
    return offered;
  }

  async typePrompt(text: string): Promise<void> {
    const box = this.page.getByRole("textbox", { name: "New thread" });
    await box.click({ timeout: 10_000 });
    // Tiptap is a contenteditable; type rather than fill for reliability.
    await this.page.keyboard.type(text);
  }

  async clickStart(): Promise<void> {
    const start = this.composer().getByRole("button", { name: "Start thread", exact: true });
    await start.waitFor({ state: "visible", timeout: 10_000 });
    await start.click({ timeout: 10_000 });
  }
}
