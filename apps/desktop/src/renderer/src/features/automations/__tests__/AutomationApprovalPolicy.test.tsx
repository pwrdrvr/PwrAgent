import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MCP_AUTO_APPROVAL_SETTINGS } from "@pwragent/shared";
import { selectListbox } from "../../../test/select";
import { AutomationApprovalPolicy, type AutomationApprovalValue } from "../AutomationApprovalPolicy";

const inherit: AutomationApprovalValue = { tools: "inherit", questions: "inherit", escalations: "inherit" };
const reviewerOn = { ...DEFAULT_MCP_AUTO_APPROVAL_SETTINGS, enabled: true };

function option(trigger: HTMLElement, name: string): HTMLElement {
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return within(selectListbox(trigger)).getByRole("option", { name: new RegExp(`^${name}`) });
}

describe("AutomationApprovalPolicy", () => {
  it("names what Inherit resolves to in Default Access with the reviewer on", () => {
    render(<AutomationApprovalPolicy value={inherit} onChange={vi.fn()} reviewer={reviewerOn} executionMode="default" backendKind="codex" />);
    expect(screen.getByLabelText("Automation MCP tool approval")).toHaveTextContent("Inherit (Review each call)");
    expect(screen.getByLabelText("Automation MCP questions")).toHaveTextContent("Inherit (Review and answer)");
    expect(screen.getByLabelText("Automation Default Access escalations")).toHaveTextContent("Inherit (Stay in sandbox)");
    expect(screen.getByText(/Reviewer on · Helper model/)).toBeInTheDocument();
  });

  it("does not offer review while the reviewer is off, and warns about a saved review choice", () => {
    render(<AutomationApprovalPolicy value={{ ...inherit, tools: "auto" }} onChange={vi.fn()} reviewer={DEFAULT_MCP_AUTO_APPROVAL_SETTINGS} executionMode="default" backendKind="codex" />);
    expect(screen.getByText("With the reviewer off, every call is declined.")).toBeInTheDocument();
    expect(screen.getByText(/Reviewer off/)).toBeInTheDocument();
    const questions = screen.getByLabelText("Automation MCP questions");
    expect(questions).toHaveTextContent("Inherit (Cancel)");
    expect(option(questions, "Review and answer")).toHaveAttribute("aria-disabled", "true");
  });

  it("hands escalations to Codex Auto and offers Codex Auto decides only with Auto access", () => {
    const { rerender } = render(<AutomationApprovalPolicy value={inherit} onChange={vi.fn()} reviewer={reviewerOn} executionMode="default" backendKind="codex" />);
    const tools = screen.getByLabelText("Automation MCP tool approval");
    expect(option(tools, "Codex Auto decides")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(tools);
    rerender(<AutomationApprovalPolicy value={inherit} onChange={vi.fn()} reviewer={reviewerOn} executionMode="auto" backendKind="codex" />);
    expect(screen.getByLabelText("Automation MCP tool approval")).toHaveTextContent("Inherit (Codex Auto decides)");
    expect(screen.queryByLabelText("Automation Default Access escalations")).not.toBeInTheDocument();
    expect(screen.getByText("Handled by Codex Auto")).toBeInTheDocument();
  });

  it("locks a provider without per-run policy to Inherit, and flags a saved choice that would stop the run", () => {
    const { rerender } = render(<AutomationApprovalPolicy value={inherit} onChange={vi.fn()} reviewer={reviewerOn} executionMode="default" backendKind="acp:claude" backendLabel="Claude Agent" />);
    expect(screen.queryByLabelText("Automation MCP tool approval")).not.toBeInTheDocument();
    expect(screen.getByText("Inherit (Review each call)")).toBeInTheDocument();
    expect(screen.getByText(/Claude Agent runs follow the reviewer/)).toBeInTheDocument();
    rerender(<AutomationApprovalPolicy value={{ ...inherit, questions: "reject" }} onChange={vi.fn()} reviewer={reviewerOn} executionMode="default" backendKind="acp:claude" backendLabel="Claude Agent" />);
    expect(screen.getByText(/the run will not start/)).toBeInTheDocument();
  });
});
