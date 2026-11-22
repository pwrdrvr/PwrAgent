import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../../lib/desktop-api";
import type { PwrAgentProfilesState } from "../../../../lib/usePwrAgentProfiles";
import { CodexProfilesFlow } from "../CodexProfilesFlow";

afterEach(cleanup);

/** Profiles whose refresh lists what main created, as the real hook does. */
function FlowWithProfiles(props: { desktopApi: Partial<DesktopApi>; created: string[] }) {
  const [names, setNames] = useState<string[]>(["default"]);
  const profiles = {
    profiles: names.map((name) => ({ name })),
    refresh: async () => setNames(["default", ...props.created]),
  } as unknown as PwrAgentProfilesState;
  return (
    <CodexProfilesFlow
      desktopApi={props.desktopApi as DesktopApi}
      profiles={profiles}
      onClose={() => undefined}
    />
  );
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Add a Codex profile" });
}

async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(within(dialog()).getByRole("button", { name }));
  });
}

describe("guided Codex profile setup", () => {
  it("reports a profile that failed to create after the list refreshes", async () => {
    const created: string[] = [];
    const desktopApi: Partial<DesktopApi> = {
      createPwrAgentProfile: vi.fn(async ({ profile }: { profile: string }) => {
        if (profile === "personal") throw new Error("disk full");
        created.push(profile);
        return undefined as never;
      }) as never,
      createCodexAuthProfile: vi.fn(async () => ({ created: true })) as never,
      setPwrAgentProfileCodexProfile: vi.fn(async () => undefined) as never,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<FlowWithProfiles desktopApi={desktopApi} created={created} />);
    await click(/Several/);
    await click("Continue →");
    await click(/log in later/);
    await click("Continue →");
    await click("Create 2 profiles");
    // "work" now exists, so the names can no longer be re-derived from the
    // rows; the summary must still say what was tried and what failed.
    expect(within(dialog()).getByText(/Could not create personal\./)).toBeInTheDocument();
    expect(within(dialog()).getByText("Not created")).toBeInTheDocument();
    expect(within(dialog()).getByText("Paired with Codex login work")).toBeInTheDocument();
    warn.mockRestore();
  });

  it("keeps a signed-in row signed in after Back from Create", async () => {
    const desktopApi: Partial<DesktopApi> = {
      createCodexAuthProfile: vi.fn(async () => ({ created: true })) as never,
      startCodexAuthProfileLogin: vi.fn(async () => ({ authenticated: true })) as never,
      checkCodexAuthProfileStatus: vi.fn(async () => ({
        authenticated: true,
        email: "person@example.com",
      })) as never,
    };
    render(<FlowWithProfiles desktopApi={desktopApi} created={[]} />);
    await click("Continue →");
    await click("Log in for work");
    expect(within(dialog()).getByText("✓ Logged in")).toBeInTheDocument();
    await click("Continue →");
    await click(/Back/);
    expect(within(dialog()).getByText("✓ Logged in")).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Continue →" })).toBeEnabled();
    // The status came from the one sign-in; Back started no CLI.
    expect(desktopApi.checkCodexAuthProfileStatus).toHaveBeenCalledTimes(1);
  });
});
