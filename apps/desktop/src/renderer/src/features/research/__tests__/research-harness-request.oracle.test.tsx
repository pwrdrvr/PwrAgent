// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ResearchHarnessRequest } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ResearchHarnessForm } from "../ResearchHarnessForm";

const thread = { backend: "codex", threadId: "thread-1" } as const;

/**
 * A request ID names one exact request so a lost reply can be retried without
 * a second admission. An edited request is a different request: it must not
 * reuse the earlier ID, or the owner refuses it as a reused identity. The
 * operator must also see the owner's own refusal, not a generic unknown outcome.
 */
it("reuses a request ID only for an unchanged retry and shows the owner's refusal", async () => {
  const sent: ResearchHarnessRequest[] = [];
  const startResearchHarness = vi.fn(async (request: ResearchHarnessRequest) => {
    sent.push(structuredClone(request));
    throw new Error("Harness bridge does not support import");
  });
  const api = { researchHarnessStatus: vi.fn(async () => ({ configured: true, bridge: "harness-bridge", workspace: "/fixture/ws" })), startResearchHarness } as unknown as DesktopApi;
  render(<ResearchHarnessForm api={api} thread={thread} onStarted={() => {}} />);
  await waitFor(() => expect(api.researchHarnessStatus).toHaveBeenCalled());
  const form = screen.getByRole("form", { name: "Harness research" });
  const fill = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const objective = screen.queryByLabelText(/^Objective/) ?? screen.queryByLabelText(/^Title/);
  if (objective) fireEvent.change(objective, { target: { value: "Import an invented swarm" } });
  fill(/project/i, "fixture-project");
  fill(/session/i, "fixture-session");
  fill(/^Swarm/i, "fixture-swarm");
  const acknowledge = screen.queryByRole("checkbox");
  if (acknowledge) fireEvent.click(acknowledge);
  const submit = async () => { await act(async () => { fireEvent.submit(form); }); await waitFor(() => expect(startResearchHarness).toHaveBeenCalledTimes(sent.length)); };

  await submit();
  await submit();
  fill(/^Swarm/i, "fixture-swarm-2");
  await submit();

  expect(sent).toHaveLength(3);
  expect(sent[1]!.requestId).toBe(sent[0]!.requestId);
  expect(sent[2]!.requestId).not.toBe(sent[0]!.requestId);
  expect(screen.getByRole("alert")).toHaveTextContent("Harness bridge does not support import");
});
