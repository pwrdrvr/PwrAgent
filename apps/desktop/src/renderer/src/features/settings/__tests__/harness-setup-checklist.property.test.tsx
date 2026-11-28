import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { DesktopApi } from "../../../lib/desktop-api";
import { GuidedSetupLaunchProvider } from "../guided-setup/GuidedSetupLauncher";
import {
  AcpSetupChecklist,
  ClaudeSetupChecklist,
  CodexSetupChecklist,
} from "../HarnessSetupPanels";
import {
  acpEntryArb,
  claudeArb,
  codexArb,
  codexBackendArb,
  managedArb,
} from "./harness-setup-arbitraries";

afterEach(cleanup);

/*
 * The Setup checklist is read top to bottom: one step is current, only it
 * carries controls, a finished step offers Change, and the screen has one
 * Check again. Rendered from the panels Settings uses, over generated
 * provider reports.
 */
function expectOneWayForward(): void {
  const list = screen.getByRole("list", { name: / setup steps$/ });
  const section = list.closest("section") ?? list;
  const steps = within(list).getAllByRole("listitem")
    .filter((item) => item.parentElement === list);
  const current = steps.filter((step) => step.getAttribute("aria-current") === "step");
  expect(current.length).toBeLessThanOrEqual(1);
  for (const step of steps) {
    const controls = step.querySelector(".harness-setup__controls");
    if (controls) expect(step).toBe(current[0]);
    const change = within(step).queryByRole("button", { name: /^Change / });
    if (change) expect(step).toHaveClass("harness-setup__step--done");
  }
  // One recheck per screen, wherever it sits.
  expect(within(section).queryAllByRole("button", { name: "Check again" }).length)
    .toBeLessThanOrEqual(1);
  // Never a button that leads nowhere: every step that needs a person
  // offers something to do, or says what is happening.
  if (current[0] && !current[0].classList.contains("harness-setup__step--working")) {
    const actions = within(current[0]).queryAllByRole("button").length
      + within(current[0]).queryAllByRole("link").length
      + within(section).queryAllByRole("button", { name: "Check again" }).length;
    expect(actions).toBeGreaterThan(0);
  }
}

const desktopApi = {
  testSettingsCredentials: vi.fn(),
  readLastSettingsCredentialTest: vi.fn(async () => undefined),
  checkCodexAuthProfileStatus: vi.fn(),
  startCodexAuthProfileLogin: vi.fn(),
  copyText: vi.fn(),
} as unknown as DesktopApi;

function withLauncher(node: ReactNode) {
  return <GuidedSetupLaunchProvider launch={() => {}}>{node}</GuidedSetupLaunchProvider>;
}

describe("harness Setup checklist", () => {
  it("ACP agents: one current step, its controls only there, one Check again", () => {
    fc.assert(fc.property(acpEntryArb, fc.boolean(), (entry, enabled) => {
      try {
        render(withLauncher(
          <AcpSetupChecklist
            entry={entry}
            registryId={entry.registryId}
            name={entry.name}
            enabled={enabled}
            desktopApi={desktopApi}
            onCheck={() => {}}
            onEnable={async () => {}}
          />,
        ));
        expectOneWayForward();
      } finally {
        cleanup();
      }
    }), { numRuns: 60 });
  });

  it("Claude: one current step, its controls only there, one Check again", () => {
    fc.assert(fc.property(claudeArb, fc.boolean(), (claude, signingIn) => {
      try {
        render(withLauncher(
          <ClaudeSetupChecklist
            backend={claude ? { kind: "claude", claude } as BackendSummary : undefined}
            desktopApi={desktopApi}
            claudeSignIn={{ onSignIn: () => {}, signingIn }}
            onChecked={async () => {}}
          />,
        ));
        expectOneWayForward();
      } finally {
        cleanup();
      }
    }), { numRuns: 40 });
  });

  it("Codex: one current step, its controls only there, one Check again", () => {
    fc.assert(fc.property(codexArb, codexBackendArb, managedArb, (codex, backend, managedProgress) => {
      try {
        render(withLauncher(
          <CodexSetupChecklist
            codex={codex}
            backend={backend}
            desktopApi={desktopApi}
            managedProgress={managedProgress}
            onRefreshCodex={async () => undefined}
            onUseAutoDiscovery={() => {}}
            onSignedIn={async () => {}}
          />,
        ));
        expectOneWayForward();
      } finally {
        cleanup();
      }
    }), { numRuns: 60 });
  });
});
