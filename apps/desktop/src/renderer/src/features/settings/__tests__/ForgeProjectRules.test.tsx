import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "../../../test/phase-probes";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopCodexModelProvider,
  ForgeAgentToolPolicy,
  ForgeAgentToolRule,
} from "@pwragent/shared";
import { chooseSelectOption, selectOptionLabels } from "../../../test/select";
import { ForgeProjectRules } from "../ForgeProjectRules";
import { decodeForgeRulesRoute, encodeForgeRulesRoute } from "../forge-rules-route";

const REPOSITORY = "github.com/pwrdrvr/pwragent";

const ALL_AGENTS_RULE: ForgeAgentToolRule = {
  repository: REPOSITORY,
  agent: { backend: "*" },
  access: { ci: "allow" },
};

const CLAUDE_RULE: ForgeAgentToolRule = {
  repository: REPOSITORY,
  agent: { backend: "claude" },
  access: { pull_requests: "allow" },
};

const LOCAL_PROVIDER: DesktopCodexModelProvider = {
  id: "llamacpp",
  name: "Local llama",
  baseUrl: "http://127.0.0.1:8080/v1",
  models: ["qwen3-abliterated"],
  hasApiKey: false,
};

function policyWith(
  rules: ForgeAgentToolRule[],
  overrides: Partial<ForgeAgentToolPolicy["access"]> = {},
): ForgeAgentToolPolicy {
  return {
    enabled: true,
    access: {
      read: "allow",
      pull_requests: "auto",
      comments: "auto",
      issues: "auto",
      ci: "auto",
      approve_merge: "ask",
      ...overrides,
    },
    rules,
  };
}

function renderRules(
  policy: ForgeAgentToolPolicy,
  options: { focusRepository?: string } = {},
) {
  const onRulesChange = vi.fn(async (_rules: ForgeAgentToolRule[]) => true);
  render(
    <ForgeProjectRules
      acpAgents={[{ registryId: "grok", name: "Grok" }]}
      codexProviders={[LOCAL_PROVIDER]}
      focusRepository={options.focusRepository ?? REPOSITORY}
      policy={policy}
      saving={false}
      onRulesChange={onRulesChange}
    />,
  );
  return { onRulesChange };
}

function rulesTable(): HTMLElement {
  return screen.getByRole("table", { name: "Rules for pwrdrvr/pwragent" });
}

afterEach(() => {
  cleanup();
});

describe("ForgeProjectRules", () => {
  it("shows the level an unset cell inherits, quietly, and a set cell solidly", () => {
    renderRules(policyWith([ALL_AGENTS_RULE, CLAUDE_RULE]));
    const table = rulesTable();

    // Claude's CI cell inherits All agents' Allow; its PR cell is its own.
    const claudeCi = within(table).getByRole("combobox", { name: "CI reruns for Claude" });
    expect(claudeCi).toHaveTextContent("Inherit (Allow)");
    expect(claudeCi).toHaveClass("is-inherited");
    const claudePrs = within(table).getByRole("combobox", { name: "Pull requests for Claude" });
    expect(claudePrs).toHaveTextContent("Allow");
    expect(claudePrs).not.toHaveClass("is-inherited");
    expect(claudePrs).toHaveClass("is-set", "is-allow");

    // All agents inherits the defaults above.
    expect(within(table).getByRole("combobox", { name: "Comments for All agents" }))
      .toHaveTextContent("Inherit (Auto)");
    expect(within(table).getByRole("combobox", { name: "Approve and merge for All agents" }))
      .toHaveTextContent("Inherit (Ask)");
    expect(selectOptionLabels(claudeCi)).toEqual(["Inherit (Allow)", "Allow", "Auto", "Ask", "Off"]);
  });

  it("writes the whole rules list when a cell changes", async () => {
    const { onRulesChange } = renderRules(policyWith([ALL_AGENTS_RULE, CLAUDE_RULE]));
    chooseSelectOption(
      within(rulesTable()).getByRole("combobox", { name: "Comments for Claude" }),
      "Ask",
    );
    await waitFor(() => expect(onRulesChange).toHaveBeenCalledWith([
      ALL_AGENTS_RULE,
      { ...CLAUDE_RULE, access: { pull_requests: "allow", comments: "ask" } },
    ]));
  });

  it("clears a group when Inherit is chosen", async () => {
    const { onRulesChange } = renderRules(policyWith([ALL_AGENTS_RULE, CLAUDE_RULE]));
    chooseSelectOption(
      within(rulesTable()).getByRole("combobox", { name: "Pull requests for Claude" }),
      /^Inherit/,
    );
    await waitFor(() => expect(onRulesChange).toHaveBeenCalledWith([
      ALL_AGENTS_RULE,
      { ...CLAUDE_RULE, access: {} },
    ]));
  });

  it("drops an emptied All agents rule, since its row is always drawn", async () => {
    const { onRulesChange } = renderRules(policyWith([ALL_AGENTS_RULE, CLAUDE_RULE]));
    chooseSelectOption(
      within(rulesTable()).getByRole("combobox", { name: "CI reruns for All agents" }),
      /^Inherit/,
    );
    await waitFor(() => expect(onRulesChange).toHaveBeenCalledWith([CLAUDE_RULE]));
  });

  it("sets a cell on the All agents row when no rule exists for it yet", async () => {
    const { onRulesChange } = renderRules(policyWith([CLAUDE_RULE]));
    chooseSelectOption(
      within(rulesTable()).getByRole("combobox", { name: "Issues for All agents" }),
      "Ask",
    );
    await waitFor(() => expect(onRulesChange).toHaveBeenCalledWith([
      CLAUDE_RULE,
      { repository: REPOSITORY, agent: { backend: "*" }, access: { issues: "ask" } },
    ]));
  });

  it("removes an agent row, and never offers to remove All agents", async () => {
    const { onRulesChange } = renderRules(policyWith([ALL_AGENTS_RULE, CLAUDE_RULE]));
    const table = rulesTable();
    expect(within(table).queryByRole("button", { name: /Remove the All agents row/ })).toBeNull();
    fireEvent.click(within(table).getByRole("button", { name: "Remove the Claude row" }));
    await waitFor(() => expect(onRulesChange).toHaveBeenCalledWith([ALL_AGENTS_RULE]));
  });

  it("locks a group that is Off in the defaults and says why", () => {
    renderRules(policyWith([ALL_AGENTS_RULE, CLAUDE_RULE], { comments: "off" }));
    const table = rulesTable();
    expect(within(table).queryByRole("combobox", { name: "Comments for Claude" })).toBeNull();
    const locked = within(table).getByRole("button", { name: "Comments for Claude: Off in the defaults" });
    expect(locked).toHaveAttribute("aria-disabled", "true");
    expect(locked).toHaveAttribute("data-tooltip", expect.stringContaining("cannot turn it on"));
    expect(screen.getByText(/Comments is Off in the defaults above, so no project rule can turn it on/))
      .toBeInTheDocument();
    // The other groups stay editable.
    expect(within(table).getByRole("combobox", { name: "Issues for Claude" })).toBeEnabled();
  });

  it("warns when Approve and merge is set to Allow", async () => {
    const { onRulesChange } = renderRules(policyWith([ALL_AGENTS_RULE, CLAUDE_RULE]));
    expect(screen.queryByText(/Approve and merge is set to Allow/)).toBeNull();
    chooseSelectOption(
      within(rulesTable()).getByRole("combobox", { name: "Approve and merge for Claude" }),
      "Allow",
    );
    await waitFor(() => expect(onRulesChange).toHaveBeenCalledWith([
      ALL_AGENTS_RULE,
      { ...CLAUDE_RULE, access: { pull_requests: "allow", approve_merge: "allow" } },
    ]));
    cleanup();

    renderRules(policyWith([
      ALL_AGENTS_RULE,
      { ...CLAUDE_RULE, access: { approve_merge: "allow" } },
    ]));
    expect(screen.getByRole("note")).toHaveTextContent(
      "Approve and merge is set to Allow for Claude.",
    );
    expect(within(rulesTable()).getByRole("combobox", { name: "Approve and merge for Claude" }))
      .toHaveClass("is-risk");
  });

  it("adds a Codex model provider row with a known model", async () => {
    const { onRulesChange } = renderRules(policyWith([ALL_AGENTS_RULE]));
    fireEvent.click(screen.getByRole("button", { name: "+ Add agent" }));
    const picker = screen.getByRole("group", { name: "Add an agent" });
    const agentSelect = within(picker).getByRole("combobox", { name: "Agent" });
    expect(selectOptionLabels(agentSelect)).toEqual(["Claude", "Codex", "Codex · Local llama", "Grok"]);
    chooseSelectOption(agentSelect, "Codex · Local llama");
    chooseSelectOption(within(picker).getByRole("combobox", { name: "Model" }), "qwen3-abliterated");
    fireEvent.click(within(picker).getByRole("button", { name: "Add agent" }));
    await waitFor(() => expect(onRulesChange).toHaveBeenCalledWith([
      ALL_AGENTS_RULE,
      {
        repository: REPOSITORY,
        agent: { backend: "codex", codexModelProvider: "llamacpp", model: "qwen3-abliterated" },
        access: {},
      },
    ]));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Add an agent" })).toBeNull());
  });

  it("refuses a second row for the same agent", () => {
    const { onRulesChange } = renderRules(policyWith([ALL_AGENTS_RULE, CLAUDE_RULE]));
    fireEvent.click(screen.getByRole("button", { name: "+ Add agent" }));
    const picker = screen.getByRole("group", { name: "Add an agent" });
    chooseSelectOption(within(picker).getByRole("combobox", { name: "Agent" }), "Claude");
    fireEvent.click(within(picker).getByRole("button", { name: "Add agent" }));
    expect(within(picker).getByRole("alert")).toHaveTextContent("Claude already has a row in this project.");
    expect(onRulesChange).not.toHaveBeenCalled();
  });

  it("adds a typed project without writing until a cell is set", async () => {
    const { onRulesChange } = renderRules(policyWith([]), { focusRepository: "" });
    expect(screen.getByText("No project rules. Every project uses the defaults above.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ Add project" }));
    const picker = screen.getByRole("group", { name: "Add a project" });
    fireEvent.change(within(picker).getByRole("textbox", { name: "Repository" }), {
      target: { value: "https://github.com/Owner/Repo.git" },
    });
    fireEvent.click(within(picker).getByRole("button", { name: "Add project" }));
    const table = screen.getByRole("table", { name: "Rules for owner/repo" });
    expect(onRulesChange).not.toHaveBeenCalled();
    chooseSelectOption(
      within(table).getByRole("combobox", { name: "Pull requests for All agents" }),
      "Allow",
    );
    await waitFor(() => expect(onRulesChange).toHaveBeenCalledWith([
      { repository: "github.com/owner/repo", agent: { backend: "*" }, access: { pull_requests: "allow" } },
    ]));
  });

  it("explains a repository it cannot read", () => {
    renderRules(policyWith([]), { focusRepository: "" });
    fireEvent.click(screen.getByRole("button", { name: "+ Add project" }));
    const picker = screen.getByRole("group", { name: "Add a project" });
    const input = within(picker).getByRole("textbox", { name: "Repository" });
    fireEvent.change(input, { target: { value: "not a repository" } });
    fireEvent.click(within(picker).getByRole("button", { name: "Add project" }));
    expect(input).toHaveAccessibleDescription(/host\/owner\/repo/);
  });

  it("opens only the project a deep link names", () => {
    const other = { ...CLAUDE_RULE, repository: "github.com/pwrdrvr/pwrsnap" };
    renderRules(policyWith([CLAUDE_RULE, other]));
    expect(screen.getByRole("button", { name: /pwrdrvr\/pwragent/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /pwrdrvr\/pwrsnap/ })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: /pwrdrvr\/pwrsnap/ }));
    expect(screen.getByRole("table", { name: "Rules for pwrdrvr/pwrsnap" })).toBeInTheDocument();
  });

  it("disables every cell while forge tools are off", () => {
    renderRules({ ...policyWith([ALL_AGENTS_RULE, CLAUDE_RULE]), enabled: false });
    expect(within(rulesTable()).getByRole("combobox", { name: "Pull requests for Claude" })).toBeDisabled();
    expect(screen.getByText(/Forge tools are off for every thread/)).toBeInTheDocument();
  });
});

describe("forge rules route", () => {
  it("round-trips a repository and passes other section ids through", () => {
    expect(decodeForgeRulesRoute(encodeForgeRulesRoute("github.com/pwrdrvr/PwrAgent"))).toEqual({
      sectionId: "agent-forge-tools",
      repository: "github.com/pwrdrvr/PwrAgent",
    });
    expect(decodeForgeRulesRoute("github")).toEqual({ sectionId: "github" });
    expect(decodeForgeRulesRoute(undefined)).toEqual({ sectionId: undefined });
  });
});
