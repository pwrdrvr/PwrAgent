// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MathosSwarmsResult, ResearchHarnessRequest, ResearchHarnessStatus } from "@pwragent/shared/research-harness";
import type { DesktopApi } from "../../../lib/desktop-api";
import { chooseSelectOption } from "../../../test/select";
import { ResearchHarnessForm } from "../ResearchHarnessForm";

afterEach(cleanup);

const thread = { backend: "codex", threadId: "thread-1" } as const;
const status: ResearchHarnessStatus = { configured: true, source: "mathos", platformOrigin: "https://os.example.test",
  platformTeam: "o-12345678-1234-4123-8123-123456789abc", platformKeyStored: true, workspace: "/fixture/ws" };

function api(swarms: MathosSwarmsResult, startResearchHarness = vi.fn(async (_request: ResearchHarnessRequest) => ({ runId: "run-1" }))) {
  return { api: { researchHarnessStatus: vi.fn(async () => status), listMathosSwarms: vi.fn(async () => swarms), startResearchHarness } as unknown as DesktopApi,
    startResearchHarness };
}

it("lists the team's swarms and imports the one chosen, titled by its task", async () => {
  const { api: desktop, startResearchHarness } = api({ ok: true, sessions: 3, truncated: false, swarms: [
    { project: "alpha", session: "default", swarm: "s-live", state: "running", task: "Contrived search", members: 3, running: true },
    { project: "beta", session: "second", swarm: "s-old", state: "ended", task: "Contrived proof", members: 2, running: false },
  ] });
  render(<ResearchHarnessForm api={desktop} thread={thread} onStarted={() => {}} />);
  const picker = await screen.findByRole("combobox", { name: "Swarm to import" });
  // Nothing to type: the three IDs come from the choice.
  expect(screen.queryByLabelText("Project")).toBeNull();
  const submit = screen.getByRole("button", { name: "Import records" });
  expect(submit).toBeDisabled();
  chooseSelectOption(picker, /Contrived proof/);
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  await waitFor(() => expect(startResearchHarness).toHaveBeenCalledTimes(1));
  expect(startResearchHarness.mock.calls[0]![0]).toMatchObject({ mode: "import", source: "swarm", project: "beta", session: "second", swarm: "s-old", objective: "Contrived proof" });
});

it("says plainly when the team's VM has no swarms, and still allows typed IDs", async () => {
  const { api: desktop } = api({ ok: true, sessions: 2, truncated: false, swarms: [] });
  render(<ResearchHarnessForm api={desktop} thread={thread} onStarted={() => {}} />);
  expect(await screen.findByText(/No swarms on this team’s VM yet \(2 sessions looked at\)\. Start one in MathOS, then refresh\./)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Enter IDs instead" }));
  expect(screen.getByLabelText("Project")).toBeInTheDocument();
});

it("shows why the swarms could not be listed", async () => {
  const { api: desktop } = api({ ok: false, error: "This team’s MathOS VM is asleep. Open MathOS to wake it, then try again." });
  render(<ResearchHarnessForm api={desktop} thread={thread} onStarted={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("VM is asleep");
});

it("never shows the browser's own required-field bubble: the form is not natively validated", async () => {
  const { api: desktop, startResearchHarness } = api({ ok: true, sessions: 0, truncated: false, swarms: [] });
  render(<ResearchHarnessForm api={desktop} thread={thread} onStarted={() => {}} />);
  const form = await screen.findByRole("form", { name: "Harness research" });
  expect(form).toHaveAttribute("novalidate");
  // Submitting with nothing chosen sends nothing.
  fireEvent.submit(form);
  expect(startResearchHarness).not.toHaveBeenCalled();
});
