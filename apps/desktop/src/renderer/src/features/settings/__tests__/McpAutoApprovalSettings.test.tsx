import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MCP_AUTO_APPROVAL_SETTINGS } from "@pwragent/shared";
import { chooseSelectOption } from "../../../test/select";
import { McpAutoApprovalSettings } from "../McpAutoApprovalSettings";
import { useUnsavedSettingsGuard } from "../UnsavedSettingsChanges";

describe("MCP Auto approval settings", () => {
  it("saves the provider, model, effort and edited prompt together", async () => {
    const onSave = vi.fn(async () => true);
    render(<McpAutoApprovalSettings backends={[]} saving={false} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText("Use MCP reviewer"));
    fireEvent.change(screen.getByLabelText("Reviewer model"), { target: { value: "gpt-6.1-sol" } });
    fireEvent.change(screen.getByLabelText("Reviewer reasoning effort"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Reviewer approval prompt"), { target: { value: "Approve the requested read operations." } });
    fireEvent.click(screen.getByRole("button", { name: "Save MCP reviewer" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ ...DEFAULT_MCP_AUTO_APPROVAL_SETTINGS, enabled: true, model: "gpt-6.1-sol", reasoningEffort: "high", prompt: "Approve the requested read operations." }));
  });

  it("keeps System One settings editable while identifying the planned adapter", async () => {
    const onSave = vi.fn(async () => true);
    render(<McpAutoApprovalSettings backends={[]} saving={false} onSave={onSave} />);
    chooseSelectOption(screen.getByLabelText("Reviewer model type"), "System One (planned)");
    fireEvent.change(screen.getByLabelText("Reviewer API endpoint"), { target: { value: "http://localhost:8000/decide" } });
    fireEvent.change(screen.getByLabelText("Reviewer minimum confidence"), { target: { value: "0.95" } });
    expect(screen.getByText(/not callable in this build/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save MCP reviewer" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ modelType: "system-one", endpoint: "http://localhost:8000/decide", confidenceThreshold: 0.95 })));
  });

  it("does not save invalid API settings and surfaces write failures", async () => {
    const onSave = vi.fn(async () => false);
    render(<McpAutoApprovalSettings backends={[]} saving={false} onSave={onSave} />);
    chooseSelectOption(screen.getByLabelText("Reviewer model type"), "Responses API");
    fireEvent.click(screen.getByLabelText("Use MCP reviewer"));
    fireEvent.click(screen.getByRole("button", { name: "Save MCP reviewer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("endpoint");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reviewer API endpoint"), { target: { value: "https://reviewer.test/v1/responses" } });
    fireEvent.click(screen.getByRole("button", { name: "Save MCP reviewer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
  });

  it("preserves edited fields when another settings write refreshes the snapshot", () => {
    const props = { backends: [], saving: false, onSave: vi.fn(async () => true) };
    const { rerender } = render(<McpAutoApprovalSettings {...props} settings={{ ...DEFAULT_MCP_AUTO_APPROVAL_SETTINGS }} />);
    fireEvent.change(screen.getByLabelText("Reviewer approval prompt"), { target: { value: "Unsaved monitoring policy" } });
    rerender(<McpAutoApprovalSettings {...props} settings={{ ...DEFAULT_MCP_AUTO_APPROVAL_SETTINGS, timeoutMs: 10000 }} />);
    expect(screen.getByLabelText("Reviewer approval prompt")).toHaveValue("Unsaved monitoring policy");
    expect(screen.getByLabelText("Reviewer timeout seconds")).toHaveValue(10);
  });

  it("registers unsaved reviewer settings with the navigation guard", async () => {
    const leave = vi.fn();
    function GuardedReviewer() {
      const guard = useUnsavedSettingsGuard();
      return <>{guard.provide(<McpAutoApprovalSettings backends={[]} saving={false} onSave={async () => true} />)}<button onClick={() => guard.confirmLeave(leave)}>Leave settings</button>{guard.dialog}</>;
    }
    render(<GuardedReviewer />);
    fireEvent.change(screen.getByLabelText("Reviewer approval prompt"), { target: { value: "Unsaved monitoring policy" } });
    fireEvent.click(screen.getByRole("button", { name: "Leave settings" }));
    expect(leave).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("MCP reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(leave).toHaveBeenCalledOnce();
  });
});
