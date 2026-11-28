import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FactoryBranchProjection, FactoryProjectProjection, FactoryProjectReadRequest } from "@pwragent/shared/factory-projection";
import { factoryWorkItemKey, type FactoryWorkItem } from "@pwragent/shared/factory-work-item";
import { chooseSelectOption } from "../../../test/select";
import { FactoryWindow } from "../FactoryWindow";

const projectKey = "directory:/example/aster";
const repo = { host: "github.com", owner: "northwind-labs", name: "Aster", id: "repo-A" } as const;
const headOid = "a".repeat(40);
const baseOid = "b".repeat(40);
const nextBase = "c".repeat(40);
const observedAt = 1_790_000_000_000;

function list(count: number): FactoryProjectProjection {
  return {
    projectKey, repository: repo, authority: { source: "local_owner_github", observedAt },
    inventory: "observed", truncated: false,
    pullRequests: Array.from({ length: count }, (_, n) => ({
      number: n + 1, title: `Improve cache ${n + 1}`, url: `https://github.com/northwind-labs/Aster/pull/${n + 1}`,
      lifecycle: "open", draft: false, firstParty: true,
    })),
  };
}

function depot(count: number) {
  const model = list(count);
  const read = vi.fn(async (request: FactoryProjectReadRequest): Promise<FactoryProjectProjection> => {
    if (!request.selection) return model;
    const pullRequest = model.pullRequests[request.selection.number - 1]!;
    const changed = !!request.selection.expected;
    return {
      ...model,
      selected: { kind: "observed", evidence: {
        pullRequest, revision: { headOid, baseOid: changed ? nextBase : baseOid },
        revisionState: changed ? "base_changed" : "current",
        ci: "pending", review: "absent", reviewCoverage: "complete", digest: "synthetic",
        candidate: { kind: "none" },
        receipts: [{ kind: "integration", name: "Merge candidate", source: "github", status: "absent" }],
      } },
    };
  });
  const open = vi.fn(async (_reference: string) => {});
  vi.stubGlobal("pwragent", {
    listFactoryProjects: async () => [{ key: projectKey, label: "Aster", path: "/example/aster" }],
    openFactoryThread: open, readFactoryProject: read,
  });
  render(<FactoryWindow />);
  return { read, open };
}

async function load() {
  const field = await screen.findByLabelText("Repository name");
  fireEvent.change(field, { target: { value: repo.name } });
  await click(screen.getByRole("button", { name: "Read pull requests" }));
}

async function click(button: HTMLElement) {
  await act(async () => { fireEvent.click(button); });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([5, 10, 20, 25])("uses one inventory request and one selected read for %i rows", async (count) => {
  const { read } = depot(count);
  await load();
  const row = await screen.findByRole("button", { name: /^Improve cache 1\s+#1\b/ });
  expect(read).toHaveBeenCalledTimes(1);
  await click(row);
  await screen.findByText("Checks in progress", { selector: ".factory-row-reason" });
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ selection: expect.objectContaining({ repositoryId: repo.id, number: 1 }) }));
  await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "Escape" }); });
  expect(screen.getByRole("button", { name: /^Improve cache 1\s+#1\b/ })).toHaveFocus();
});

it("retains the original revision on refresh and shows missing proof without an approval control", async () => {
  const { read } = depot(2);
  await load();
  await click(await screen.findByRole("button", { name: /^Improve cache 1\s+#1\b/ }));
  const drawer = await screen.findByRole("complementary");
  expect(within(drawer).getByRole("heading", { level: 2 })).toHaveFocus();
  await within(drawer).findByText("Merge candidate");
  expect(within(drawer).getByText("Landing unavailable.", { exact: false })).toBeVisible();
  expect(within(drawer).queryByRole("button", { name: /land|approve|arm/i })).toBeNull();
  await click(within(drawer).getByRole("button", { name: "Refresh evidence" }));
  await within(drawer).findByText("Earlier base");
  expect(read).toHaveBeenLastCalledWith(expect.objectContaining({
    selection: expect.objectContaining({ expected: { headOid, baseOid } }),
  }));
  expect(within(drawer).getByText(nextBase)).toBeVisible();
  expect(within(drawer).getByText(baseOid)).toBeVisible();
});

it("keeps last confirmed evidence visible on read failure and when offline", async () => {
  const { read } = depot(2);
  await load();
  const row = await screen.findByRole("button", { name: /^Improve cache 1\s+#1\b/ });
  read.mockRejectedValueOnce(new Error("Forge unavailable"));
  await click(row);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Forge unavailable Showing last confirmed evidence."));
  expect(row).toBeVisible();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  fireEvent(window, new Event("offline"));
  expect(screen.getByText("Network offline.", { exact: false })).toBeVisible();
  expect(within(screen.getByRole("complementary")).getByRole("button", { name: "Read evidence" })).toBeDisabled();
});

const issueId = "10000000-0000-4000-a000-000000000042";
const mergeBase = "d".repeat(40);
const branch: FactoryBranchProjection = {
  outcomeId: `linear:${issueId}`, issue: { provider: "linear", source: "local_operator", id: issueId },
  workItem: { provider: "linear", id: issueId },
  authority: { source: "local_owner_git", observedAt, profile: "test", runtimeInstanceId: "fixture" },
  branch: "fix/focus", baseRef: "refs/heads/main", stage: "branch", publication: "unobserved", headOid, baseOid,
  receipts: [{ kind: "review", source: "owner_review", name: "Focus review", status: "inconclusive", mergeBaseOid: mergeBase,
    reference: "pwragent://thread/focus-review?backend=codex&messageId=proof", headOid }],
};

function branchResponse(candidate = branch, owner = repo.owner as string): FactoryProjectProjection {
  return {
    ...list(0), repository: { host: repo.host, owner, name: repo.name },
    inventory: "unobserved", authority: { source: "local_owner_git", observedAt }, candidate,
  };
}

function selectionResponse(number: number, candidate?: FactoryBranchProjection, revision = { headOid, baseOid }): FactoryProjectProjection {
  const result = list(2);
  return {
    ...result, candidate,
    selected: { kind: "observed", evidence: {
      pullRequest: result.pullRequests[number - 1]!, revision, revisionState: revision.baseOid === baseOid ? "current" : "base_changed",
      ci: "failed", review: "blocked", reviewCoverage: "complete", digest: "fixture", candidate: { kind: "none" },
      receipts: [{ kind: "test", name: `Check for PR ${number}`, source: "github", status: "failed" }],
    } },
  };
}

function openBranchForm() {
  const picker = screen.getByText("Project and evidence source", { selector: "summary" });
  if (!picker.closest("details")?.open) fireEvent.click(picker);
  const options = screen.getByText("Read a local branch", { selector: "summary" });
  if (!options.closest("details")?.open) fireEvent.click(options);
}

async function loadBranch() {
  openBranchForm();
  chooseSelectOption(screen.getByRole("combobox", { name: "Tracking record" }), "Linear issue");
  fireEvent.change(screen.getByLabelText("Linear issue ID"), { target: { value: issueId } });
  fireEvent.change(screen.getByLabelText("Branch"), { target: { value: branch.branch } });
  fireEvent.change(screen.getByLabelText("Base ref"), { target: { value: branch.baseRef } });
  await click(screen.getByRole("button", { name: "Read branch evidence" }));
}

it.each<[string, FactoryWorkItem, string]>([
  ["GitHub issue", { provider: "github", kind: "issue", repositoryId: repo.id, number: 42 }, `${repo.id} #42`],
  ["GitHub pull request", { provider: "github", kind: "pull_request", repositoryId: repo.id, number: 42 }, `${repo.id} #42`],
  ["Jira issue", { provider: "jira", siteId: "fixture-site", id: "10042" }, "fixture-site / 10042"],
  ["Linear issue", { provider: "linear", id: issueId }, issueId],
])("submits and labels a %s as an operator-selected tracking record", async (label, workItem, reference) => {
  const { read } = depot(2);
  await load();
  openBranchForm();
  chooseSelectOption(screen.getByRole("combobox", { name: "Tracking record" }), label);
  if (workItem.provider === "github") {
    expect(screen.getByLabelText("GitHub repository ID")).toHaveValue(repo.id);
    fireEvent.change(screen.getByLabelText(workItem.kind === "issue" ? "Issue number" : "Pull request number"), { target: { value: "42" } });
  } else if (workItem.provider === "jira") {
    fireEvent.change(screen.getByLabelText("Jira site ID"), { target: { value: workItem.siteId } });
    fireEvent.change(screen.getByLabelText("Jira issue ID"), { target: { value: workItem.id } });
  } else {
    fireEvent.change(screen.getByLabelText("Linear issue ID"), { target: { value: workItem.id } });
  }
  fireEvent.change(screen.getByLabelText("Branch"), { target: { value: branch.branch } });
  fireEvent.change(screen.getByLabelText("Base ref"), { target: { value: branch.baseRef } });
  const outcomeId = factoryWorkItemKey(workItem);
  read.mockResolvedValueOnce(branchResponse({ ...branch, workItem, outcomeId, issue: workItem.provider === "linear" ? branch.issue : undefined }));
  await click(screen.getByRole("button", { name: "Read branch evidence" }));
  expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ candidate: expect.objectContaining({ workItem }) }));
  const row = screen.getByRole("button", { name: /^fix\/focus/ });
  expect(row).toHaveAttribute("data-row-key", outcomeId);
  await click(row);
  const drawer = within(screen.getByRole("complementary"));
  expect(drawer.getByText(reference)).toBeVisible();
  expect(drawer.getByText(/Operator selected/)).toBeVisible();
  expect(drawer.getByText(/Owner review/)).toBeVisible();
});

function prRow(number: number) {
  return screen.getByRole("button", { name: new RegExp(`^Improve cache ${number}\\s+#${number}\\b`) });
}

async function confirmPublication(read: ReturnType<typeof depot>["read"]) {
  read.mockResolvedValueOnce(branchResponse());
  await loadBranch();
  await click(prRow(1));
  read.mockResolvedValueOnce(selectionResponse(1, { ...branch, publication: "confirmed", stage: "published" }));
  await click(screen.getByRole("button", { name: "Compare with local branch" }));
  const row = prRow(1);
  expect(row).toHaveAttribute("data-row-key", branch.outcomeId);
  return row;
}

it("uses the owner’s repository identity and purges a same-name repository when its owner changes on the branch read", async () => {
  const { read } = depot(2);
  await load();
  await confirmPublication(read);
  read.mockResolvedValueOnce(branchResponse(branch, "replacement-labs"));
  await loadBranch();

  expect(screen.getByText("Aster · replacement-labs/Aster")).toBeVisible();
  expect(screen.queryByText(/pwrdrvr\//i)).toBeNull();
  expect(screen.queryByRole("button", { name: /^Improve cache/ })).toBeNull();
  await click(screen.getByRole("button", { name: /^fix\/focus/ }));
  const drawer = within(screen.getByRole("complementary"));
  expect(drawer.queryByRole("link", { name: "Open on GitHub" })).toBeNull();
  expect(drawer.getByText("Reviewed merge base")).toBeVisible();
});

it("discards the comparison and old detail after a same-slug immutable repository ID replacement", async () => {
  const { read } = depot(2);
  await load();
  await confirmPublication(read);
  const toggle = screen.getByText("Project and evidence source", { selector: "summary" });
  if (!toggle.closest("details")?.open) await click(toggle);
  read.mockResolvedValueOnce({ ...list(2), repository: { ...repo, id: "repo-B" } });
  await load();

  const row = prRow(1);
  expect(row).toHaveAttribute("data-row-key", "github:repo-B:1");
  expect(screen.queryByRole("button", { name: /^fix\/focus/ })).toBeNull();
  await click(row);
  expect(read).toHaveBeenLastCalledWith(expect.objectContaining({
    selection: expect.objectContaining({ repositoryId: "repo-B", expected: undefined }),
    candidate: undefined,
  }));
});

it.each(["headOid", "baseOid"] as const)("invalidates a confirmed publication when only the local %s changes", async (field) => {
  const { read } = depot(2);
  await load();
  await confirmPublication(read);
  read.mockResolvedValueOnce(branchResponse({ ...branch, [field]: nextBase }));
  await loadBranch();

  expect(prRow(1)).toHaveAttribute("data-row-key", "github:repo-A:1");
  const local = screen.getByRole("button", { name: /^fix\/focus/ });
  expect(local).toHaveAttribute("data-row-key", branch.outcomeId);
  await click(local);
  const drawer = within(screen.getByRole("complementary"));
  expect(drawer.queryByRole("link", { name: "Open on GitHub" })).toBeNull();
  expect(drawer.queryByText("Check for PR 1")).toBeNull();
  await click(prRow(1));
  expect(read).toHaveBeenLastCalledWith(expect.objectContaining({
    selection: expect.objectContaining({ expected: { headOid, baseOid }, number: 1 }),
  }));
});

it("separates a target-only publication change from head drift while retaining adverse PR evidence", async () => {
  const { read } = depot(2);
  await load();
  const published = await confirmPublication(read);
  expect(published).toHaveAttribute("data-row-key", branch.outcomeId);
  read.mockResolvedValueOnce(selectionResponse(1, { ...branch, publication: "revision_changed" }, { headOid, baseOid: nextBase }));
  await click(screen.getByRole("button", { name: "Refresh evidence" }));

  const local = screen.getByRole("button", { name: /local and published target bases differ/i });
  expect(local).toHaveAttribute("data-row-key", branch.outcomeId);
  expect(prRow(1)).toHaveTextContent("Checks failed");
  await click(local);
  const drawer = within(screen.getByRole("complementary"));
  expect(drawer.getByText("Published target at comparison")).toBeVisible();
  expect(drawer.getByText(nextBase)).toBeVisible();
  expect(drawer.queryByRole("link", { name: "Open on GitHub" })).toBeNull();
  await click(prRow(1));
  expect(within(screen.getByRole("complementary")).getByText("The target base changed.", { exact: false })).toBeVisible();
});

it("distinguishes a mismatched candidate from an absent PR and clears the old confirmation", async () => {
  const { read } = depot(2);
  await load();
  await confirmPublication(read);
  read.mockResolvedValueOnce({ ...list(2), candidate: { ...branch, publication: "mismatch" } });
  await click(screen.getByRole("button", { name: "Refresh evidence" }));
  expect(screen.getByRole("button", { name: /does not match the local branch and target/i })).toBeVisible();
  await click(prRow(1));
  const drawer = within(screen.getByRole("complementary"));
  expect(drawer.getByText("The selected PR does not match the local branch and target.")).toBeVisible();
  expect(drawer.queryByText("GitHub did not confirm this selection.")).toBeNull();

  read.mockResolvedValueOnce({ ...list(2), selected: { kind: "absent" } });
  await click(drawer.getByRole("button", { name: "Read evidence" }));
  expect(drawer.getByText("GitHub did not confirm this selection.")).toBeVisible();
  expect(drawer.queryByRole("link", { name: "Open on GitHub" })).toBeNull();
});

it("loads the latest selection after the pending read without retrying the first or any skipped PR", async () => {
  const { read } = depot(3);
  await load();
  const first = Promise.withResolvers<FactoryProjectProjection>();
  read.mockReturnValueOnce(first.promise);
  await click(prRow(1));
  await click(prRow(2));
  await click(prRow(3));
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("heading", { name: "Improve cache 3" })).toHaveFocus();
  read.mockResolvedValueOnce({
    ...list(3),
    selected: { kind: "observed", evidence: {
      pullRequest: list(3).pullRequests[2]!, revision: { headOid, baseOid }, revisionState: "current",
      ci: "failed", review: "blocked", reviewCoverage: "complete", digest: "third", candidate: { kind: "none" },
      receipts: [{ kind: "test", name: "Check for PR 3", source: "github", status: "failed" }],
    } },
  });
  await act(async () => { first.resolve({ ...selectionResponse(1), pullRequests: list(3).pullRequests }); });
  expect(within(screen.getByRole("complementary")).getByText("Check for PR 3")).toBeVisible();
  expect(within(screen.getByRole("complementary")).queryByText("Check for PR 1")).toBeNull();
  expect(read.mock.calls.map(([request]) => request.selection?.number)).toEqual([undefined, 1, 3]);
});

it.each([false, true])("uses updated draft metadata for cached PR evidence with linked=%s", async (linked) => {
  const { read } = depot(2);
  await load();
  if (linked) await confirmPublication(read);
  else await click(prRow(1));

  const toggle = screen.getByText("Project and evidence source", { selector: "summary" });
  if (!toggle.closest("details")?.open) await click(toggle);
  const inventory = list(2);
  inventory.pullRequests[0] = { ...inventory.pullRequests[0]!, title: "Improve cache 1", draft: true };
  read.mockResolvedValueOnce(inventory);
  await load();

  expect(within(screen.getByRole("region", { name: "Paused" })).getByRole("button", {
    name: /Improve cache 1.*Draft pull request/,
  })).toBeVisible();
  expect(prRow(1)).toHaveAttribute("data-row-key", linked ? branch.outcomeId : "github:repo-A:1");
});

it("shows local head divergence even if the published head and target have not moved", async () => {
  const { read } = depot(2);
  await load();
  await confirmPublication(read);
  const result = selectionResponse(1, { ...branch, publication: "revision_changed", headOid: nextBase });
  if (result.selected?.kind !== "observed") throw new Error("Missing fixture evidence.");
  result.selected.evidence.ci = "pending";
  result.selected.evidence.review = "absent";
  read.mockResolvedValueOnce(result);
  await click(screen.getByRole("button", { name: "Refresh evidence" }));

  expect(screen.getByRole("button", { name: /local and published heads differ/i })).toHaveAttribute("data-row-key", branch.outcomeId);
  expect(prRow(1)).toHaveTextContent("Checks in progress");
});

it("keeps a published outcome in Needs you when its linked local review covers an older base", async () => {
  const { read } = depot(2);
  await load();
  await confirmPublication(read);
  const result = selectionResponse(1, {
    ...branch, stage: "published", publication: "confirmed",
    receipts: [{ ...branch.receipts[0]!, status: "stale_base" }],
  });
  if (result.selected?.kind !== "observed") throw new Error("Missing fixture evidence.");
  result.selected.evidence.ci = "pending";
  result.selected.evidence.review = "absent";
  read.mockResolvedValueOnce(result);
  await click(screen.getByRole("button", { name: "Refresh evidence" }));
  expect(within(screen.getByRole("region", { name: "Needs you" })).getByRole("button", {
    name: /Improve cache 1.*Review refers to an earlier base/,
  })).toHaveAttribute("data-row-key", branch.outcomeId);
});

it("keeps the GitHub comparison baseline when comparing an unrelated branch", async () => {
  const { read } = depot(2);
  await load();
  read.mockResolvedValueOnce(branchResponse({ ...branch, headOid: mergeBase }));
  await loadBranch();
  await click(prRow(1));
  read.mockResolvedValueOnce({ ...list(2), candidate: { ...branch, publication: "mismatch" } });
  await click(screen.getByRole("button", { name: "Compare with local branch" }));

  expect(read.mock.lastCall?.[0].selection?.expected).toEqual({ headOid, baseOid });
  await click(screen.getByRole("button", { name: "Read evidence" }));
  expect(read.mock.lastCall?.[0].selection?.expected).toEqual({ headOid, baseOid });
});

it("retains an applied check policy and the prior PR baseline after a failed selected read", async () => {
  const { read } = depot(2);
  await load();
  await click(prRow(1));
  fireEvent.click(screen.getByText("Required CI checks"));
  fireEvent.change(screen.getByLabelText("Check names, one per line"), { target: { value: "build\nverify" } });
  read.mockRejectedValueOnce(new Error("Forge unavailable"));
  await click(screen.getByRole("button", { name: "Read with these checks" }));
  expect(screen.queryByText("Merge candidate")).not.toBeInTheDocument();
  await click(screen.getByRole("button", { name: "Read evidence" }));
  expect(read.mock.lastCall?.[0].selection).toMatchObject({
    repositoryId: repo.id, requiredChecks: ["build", "verify"], expected: { headOid, baseOid },
  });

  read.mockResolvedValueOnce({ ...list(2), repository: { ...repo, id: "repo-B" } });
  const toggle = screen.getByText("Project and evidence source", { selector: "summary" });
  if (!toggle.closest("details")?.open) await click(toggle);
  await load();
  await click(prRow(1));
  expect(read.mock.lastCall?.[0].selection).toMatchObject({
    repositoryId: "repo-B", requiredChecks: [], expected: undefined,
  });
});

it.each([false, true])("reconciles linked A when reading B from a page with truncated=%s", async (truncated) => {
  const { read } = depot(2);
  await load();
  await confirmPublication(read);
  read.mockResolvedValueOnce({ ...selectionResponse(2), pullRequests: list(2).pullRequests.slice(1), truncated });
  await click(prRow(2));

  if (truncated) {
    expect(prRow(1)).toHaveAttribute("data-row-key", branch.outcomeId);
    expect(prRow(1)).not.toHaveTextContent(/merged|closed/i);
  } else {
    expect(screen.queryByRole("button", { name: /^Improve cache 1/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^fix\/focus/ })).toHaveAttribute("data-row-key", branch.outcomeId);
  }
  expect(read.mock.calls.map(([args]) => args.selection?.number)).toEqual([undefined, undefined, 1, 1, 2]);
});

it("displays inventory, PR evidence and local branch times from their own observations", async () => {
  const { read } = depot(2);
  await load();
  await confirmPublication(read);
  read.mockResolvedValueOnce(branchResponse({
    ...branch, authority: { ...branch.authority, observedAt: observedAt + 60_000 },
  }));
  await loadBranch();
  read.mockResolvedValueOnce({
    ...selectionResponse(2), authority: { source: "local_owner_github", observedAt: observedAt + 120_000 },
  });
  await click(prRow(2));
  await click(prRow(1));
  expect(screen.getByText(/Pull request inventory observed/).querySelector("time"))
    .toHaveAttribute("datetime", new Date(observedAt + 120_000).toISOString());
  expect(screen.getByText(/GitHub evidence observed/).querySelector("time"))
    .toHaveAttribute("datetime", new Date(observedAt).toISOString());
  expect(screen.getByText(/Local branch observed/).querySelector("time"))
    .toHaveAttribute("datetime", new Date(observedAt + 60_000).toISOString());
});

it("compares an explicitly tracked off-page PR in one selected read through the local row", async () => {
  const { read } = depot(25);
  await load();
  openBranchForm();
  chooseSelectOption(screen.getByRole("combobox", { name: "Tracking record" }), "GitHub pull request");
  fireEvent.change(screen.getByLabelText("Pull request number"), { target: { value: "42" } });
  fireEvent.change(screen.getByLabelText("Branch"), { target: { value: branch.branch } });
  fireEvent.change(screen.getByLabelText("Base ref"), { target: { value: branch.baseRef } });
  const workItem = { provider: "github", kind: "pull_request", repositoryId: repo.id, number: 42 } as const;
  const candidate = { ...branch, workItem, outcomeId: factoryWorkItemKey(workItem) };
  read.mockResolvedValueOnce(branchResponse(candidate));
  await click(screen.getByRole("button", { name: "Read branch evidence" }));
  await click(screen.getByRole("button", { name: /^fix\/focus/ }));
  const response = selectionResponse(2, { ...candidate, publication: "confirmed", stage: "published" });
  if (response.selected?.kind !== "observed") throw new Error("Missing selected evidence.");
  response.selected.evidence.pullRequest = list(42).pullRequests[41]!;
  read.mockResolvedValueOnce({ ...response, pullRequests: list(25).pullRequests, truncated: true });
  await click(screen.getByRole("button", { name: "Compare tracked PR #42" }));

  expect(prRow(42)).toHaveAttribute("data-row-key", candidate.outcomeId);
  expect(read.mock.calls.map(([args]) => args.selection?.number)).toEqual([undefined, undefined, 42]);
  expect(read.mock.lastCall?.[0].selection).toMatchObject({ repositoryId: repo.id, number: 42, expected: undefined });
});

it("refreshes registered projects from both the empty and populated picker without reading GitHub", async () => {
  const read = vi.fn();
  const projects = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([
    { key: projectKey, label: "Aster", path: "/example/aster" },
  ]).mockResolvedValueOnce([
    { key: "directory:/example/cedar", label: "Cedar", path: "/example/cedar" },
  ]);
  vi.stubGlobal("pwragent", { listFactoryProjects: projects, readFactoryProject: read, openFactoryThread: vi.fn() });
  render(<FactoryWindow />);

  await click(await screen.findByRole("button", { name: "Refresh projects" }));
  expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent("Aster");
  await click(screen.getByRole("button", { name: "Refresh projects" }));
  expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent("Cedar");
  expect(projects).toHaveBeenCalledTimes(3);
  expect(read).not.toHaveBeenCalled();
});
