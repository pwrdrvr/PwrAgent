import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MCP_AUTO_APPROVAL_SETTINGS, type BackendSummary } from "@pwragent/shared";
import { chooseSelectOption, selectOptionLabels } from "../../../test/select";
import { McpAutoApprovalSettings } from "../McpAutoApprovalSettings";
import { useUnsavedSettingsGuard } from "../UnsavedSettingsChanges";

const backends = [
  {
    kind: "codex", label: "Codex", available: true,
    launchpadOptions: { models: [
      { id: "gpt-6-luna", label: "GPT-6-Luna", reasoningEfforts: ["low", "medium"] },
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", reasoningEfforts: ["low", "medium", "high"] },
    ] },
  },
  { kind: "acp:grok", label: "Grok", available: true, launchpadOptions: { models: [{ id: "grok-4.6", label: "Grok 4.6" }] } },
] as unknown as BackendSummary[];
const enabled = { ...DEFAULT_MCP_AUTO_APPROVAL_SETTINGS, enabled: true };

describe("Approval reviewer settings", () => {
  it("shows only the switch and what happens without it while off", () => {
    render(<McpAutoApprovalSettings backends={backends} saving={false} onSave={vi.fn()} />);
    expect(screen.getByText(/Automations pre-approve their allowed MCP tools/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Reviewer model")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("follows the Helper model by default and names where the reviewer answers", async () => {
    const onSave = vi.fn(async () => true);
    render(<McpAutoApprovalSettings backends={backends} helperModels={{ helpers: {}, defaultModel: "gpt-6-luna" }} saving={false} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText("Use approval reviewer"));
    expect(screen.getByLabelText("Reviewer model")).toHaveTextContent("Helper model (GPT-6-Luna)");
    expect(screen.getByText(/Threads in Default Access keep asking you/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ ...enabled, model: "", provider: "codex" }));
  });

  it("offers catalog models from each reviewer provider, and no placeholder adapter", () => {
    render(<McpAutoApprovalSettings backends={backends} settings={enabled} saving={false} onSave={vi.fn()} />);
    const labels = selectOptionLabels(screen.getByLabelText("Reviewer model"));
    expect(labels).toEqual(expect.arrayContaining(["Codex · GPT-6.1-Sol", "Grok · Grok 4.6", "Direct API…"]));
    expect(labels.join(" ")).not.toMatch(/System One/);
    expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
  });

  it("saves a chosen model and effort together with an edited policy", async () => {
    const onSave = vi.fn(async () => true);
    render(<McpAutoApprovalSettings backends={backends} settings={enabled} saving={false} onSave={onSave} />);
    chooseSelectOption(screen.getByLabelText("Reviewer model"), "Codex · GPT-6.1-Sol");
    chooseSelectOption(screen.getByLabelText("Reviewer reasoning"), "high");
    fireEvent.change(screen.getByLabelText("Reviewer MCP policy"), { target: { value: "Approve the requested read operations." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ ...enabled, model: "gpt-6.1-sol", reasoningEffort: "high", prompt: "Approve the requested read operations." }));
  });

  it("shows the escalation policy only while escalation review is on", () => {
    render(<McpAutoApprovalSettings backends={backends} settings={enabled} saving={false} onSave={vi.fn()} />);
    expect(screen.queryByLabelText("Reviewer escalation policy")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Review escalations"));
    expect(screen.getByLabelText("Reviewer escalation policy")).toBeInTheDocument();
  });

  it("does not save an incomplete direct API, and surfaces write failures", async () => {
    const onSave = vi.fn(async () => false);
    render(<McpAutoApprovalSettings backends={backends} settings={enabled} saving={false} onSave={onSave} />);
    chooseSelectOption(screen.getByLabelText("Reviewer model"), "Direct API…");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("endpoint");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reviewer API endpoint"), { target: { value: "https://reviewer.test/v1/responses" } });
    fireEvent.change(screen.getByLabelText("Reviewer API model"), { target: { value: "reviewer-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ modelType: "responses", endpoint: "https://reviewer.test/v1/responses", model: "reviewer-model" }));
  });

  it("discards edits back to the saved values", () => {
    render(<McpAutoApprovalSettings backends={backends} settings={enabled} saving={false} onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Reviewer MCP policy"), { target: { value: "Unsaved policy" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Reviewer MCP policy")).toHaveValue(DEFAULT_MCP_AUTO_APPROVAL_SETTINGS.prompt);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("preserves edited fields when another settings write refreshes the snapshot", () => {
    const props = { backends, saving: false, onSave: vi.fn(async () => true) };
    const { rerender } = render(<McpAutoApprovalSettings {...props} settings={{ ...enabled }} />);
    fireEvent.change(screen.getByLabelText("Reviewer MCP policy"), { target: { value: "Unsaved monitoring policy" } });
    rerender(<McpAutoApprovalSettings {...props} settings={{ ...enabled, timeoutMs: 10000 }} />);
    expect(screen.getByLabelText("Reviewer MCP policy")).toHaveValue("Unsaved monitoring policy");
    expect(screen.getByLabelText("Reviewer time limit seconds")).toHaveValue(10);
  });

  it("registers unsaved reviewer settings with the navigation guard", async () => {
    const leave = vi.fn();
    function GuardedReviewer() {
      const guard = useUnsavedSettingsGuard();
      return <>{guard.provide(<McpAutoApprovalSettings backends={backends} settings={enabled} saving={false} onSave={async () => true} />)}<button onClick={() => guard.confirmLeave(leave)}>Leave settings</button>{guard.dialog}</>;
    }
    render(<GuardedReviewer />);
    fireEvent.change(screen.getByLabelText("Reviewer MCP policy"), { target: { value: "Unsaved monitoring policy" } });
    fireEvent.click(screen.getByRole("button", { name: "Leave settings" }));
    expect(leave).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Approval reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(leave).toHaveBeenCalledOnce();
  });
});
