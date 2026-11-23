import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AgentTrustPolicy } from "@pwragent/shared/contracts/agent-trust-policy";
import { snapshotThreadAgentTrustPolicy, type SetThreadAgentTrustPolicyRequest } from "@pwragent/shared/contracts/navigation";
import { AgentMessagingTrust } from "./AgentMessagingTrust";

it("submits the revision from when editing began after the current policy refreshes", async () => {
  const policy = {
    version: 1, denialResponse: "silent",
    rules: [{ provider: "slack", allOf: [{ kind: "actor-id", actorId: "U-FIXTURE-ONE" }] }],
  } as const satisfies AgentTrustPolicy;
  const original = snapshotThreadAgentTrustPolicy(policy);
  let current = original;
  const save = vi.fn(async (request: SetThreadAgentTrustPolicyRequest) => {
    if (request.expectedRevision !== current.revision) {
      throw new Error("Messaging access changed while you were editing.");
    }
    return snapshotThreadAgentTrustPolicy(request.policy ?? undefined);
  });
  const api = { readThreadAgentTrustPolicy: async () => current, setThreadAgentTrustPolicy: save };
  const target = { backend: "codex", threadId: "fixture-agent" } as const;
  const { rerender } = render(<AgentMessagingTrust agentName="Release Desk" target={target} api={api} revision={0} />);
  const edit = await screen.findByRole("button", { name: "Edit access" });
  await waitFor(() => expect(edit).toBeEnabled());
  fireEvent.click(edit);

  current = snapshotThreadAgentTrustPolicy({ ...policy, rules: [] });
  rerender(<AgentMessagingTrust agentName="Release Desk" target={target} api={api} revision={1} />);
  await screen.findByText("Restricted · no rules");
  fireEvent.change(screen.getByDisplayValue("U-FIXTURE-ONE"), { target: { value: "U-FIXTURE-TWO" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Messaging access changed while you were editing.");
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: original.revision }));
});
