import { describe, expect, it, vi } from "vitest";
import type { CodexEnvironmentOption, ThreadTodo } from "@pwragent/shared";
import {
  listThreadTodoDispatchEnvironments,
  resolveThreadTodoStartEnvironment,
  resolveThreadTodoStartSpeed,
} from "../thread-todos/thread-todo-dispatch";

const CODEX = { kind: "codex" as const, codexFastAllowed: true };
const ENVIRONMENTS: CodexEnvironmentOption[] = [
  { id: "dev", name: "Dev", sourcePath: "/repo/.codex/environments/dev.toml", actions: [] },
  { id: "ci", name: "CI", sourcePath: "/repo/.codex/environments/ci.toml", actions: [] },
];

describe("resolveThreadTodoStartSpeed", () => {
  it("applies a pick the destination allows", () => {
    expect(resolveThreadTodoStartSpeed({ destination: CODEX, requested: "fast" })).toEqual({ fastMode: true });
    expect(resolveThreadTodoStartSpeed({ destination: CODEX, requested: "standard", inherited: { fastMode: true } }))
      .toEqual({ fastMode: false });
  });

  it("refuses Fast and Ultrafast when Settings turned Fast off", () => {
    const off = { kind: "codex" as const, codexFastAllowed: false };
    expect(() => resolveThreadTodoStartSpeed({ destination: off, requested: "fast" })).toThrow("turned off");
    expect(() => resolveThreadTodoStartSpeed({ destination: off, requested: "ultrafast" })).toThrow("turned off");
    expect(resolveThreadTodoStartSpeed({ destination: off, inherited: { serviceTier: "ultrafast" } })).toEqual({ fastMode: false });
    expect(resolveThreadTodoStartSpeed({ destination: off, inherited: { fastMode: false } })).toEqual({ fastMode: false });
  });

  it("refuses a speed the model's catalog entry lacks, and trusts a silent catalog", () => {
    const catalog = { models: [{ id: "mini", supportsFast: false }, { id: "sol", supportsFast: true, serviceTiers: ["ultrafast"] }] };
    expect(() => resolveThreadTodoStartSpeed({ destination: CODEX, catalog, model: "mini", requested: "fast" })).toThrow("no Fast");
    expect(() => resolveThreadTodoStartSpeed({ destination: CODEX, catalog, model: "mini", requested: "ultrafast" })).toThrow("no Ultrafast");
    expect(resolveThreadTodoStartSpeed({ destination: CODEX, catalog, model: "sol", requested: "ultrafast" }))
      .toEqual({ fastMode: false, serviceTier: "ultrafast" });
    expect(resolveThreadTodoStartSpeed({ destination: CODEX, catalog: { models: [] }, model: "x", requested: "fast" }))
      .toEqual({ fastMode: true });
  });

  it("keeps a non-Codex provider's inherited settings and refuses a speed there", () => {
    const claude = { kind: "claude" as const };
    expect(resolveThreadTodoStartSpeed({ destination: claude, inherited: { fastMode: true } })).toEqual({ fastMode: true });
    expect(() => resolveThreadTodoStartSpeed({ destination: claude, requested: "fast" })).toThrow("only for Codex");
  });
});

describe("resolveThreadTodoStartEnvironment", () => {
  const listOptions = vi.fn(async () => ENVIRONMENTS);

  it("starts without one for none or no pick", async () => {
    expect(await resolveThreadTodoStartEnvironment({ requested: "none", cwd: "/repo", listOptions })).toBeUndefined();
    expect(await resolveThreadTodoStartEnvironment({ cwd: "/repo", listOptions })).toBeUndefined();
  });

  it("reuses the raising thread's own environment and runs setup for another", async () => {
    const source = { environmentId: "dev", environmentName: "Dev", executionTarget: "local" as const, setupStatus: "completed" as const };
    expect(await resolveThreadTodoStartEnvironment({ requested: "dev", cwd: "/repo", source, listOptions }))
      .toEqual({ runtime: source, rerunSetup: false });
    expect(await resolveThreadTodoStartEnvironment({ requested: "CI", cwd: "/repo", source, listOptions }))
      .toEqual({ runtime: { environmentId: "ci", environmentName: "CI", executionTarget: "local" }, rerunSetup: true });
  });

  it("refuses an environment the checkout does not have", async () => {
    await expect(resolveThreadTodoStartEnvironment({ requested: "nope", cwd: "/repo", listOptions })).rejects.toThrow();
    await expect(resolveThreadTodoStartEnvironment({ requested: "dev", listOptions })).rejects.toThrow("no project directory");
  });
});

describe("listThreadTodoDispatchEnvironments", () => {
  const card = (overrides: Partial<ThreadTodo> = {}): ThreadTodo => ({
    id: "todo-1", backend: "codex", threadId: "source", kind: "handoff", status: "open", title: "Go",
    action: { type: "start_thread", prompt: "Go" }, cwd: "/wt/repo",
    sourceProject: { key: "directory:/repo", label: "repo", path: "/repo" },
    createdAt: 0, updatedAt: 0, ...overrides,
  });
  const deps = (todo: ThreadTodo) => ({
    getTodo: () => todo,
    listProjects: async () => [
      { key: "directory:C:/src/repo", label: "repo", kind: "directory" as const, path: "C:/src/repo" },
    ],
    readThreadEnvironmentId: vi.fn(async () => "dev"),
    readProjectPresetId: vi.fn(async () => "ci"),
    listOptions: vi.fn(async () => ENVIRONMENTS),
  });

  it("defaults the owner's start to the raising thread's environment, read in its checkout", async () => {
    const d = deps(card());
    expect(await listThreadTodoDispatchEnvironments({ id: "todo-1" }, d)).toEqual({
      projectFound: true, projectLabel: "repo",
      environments: [{ id: "dev", name: "Dev" }, { id: "ci", name: "CI" }],
      defaultEnvironmentId: "dev", defaultSource: "thread",
    });
    expect(d.listOptions).toHaveBeenCalledWith("/wt/repo");
  });

  it("uses the target project's preset when the card is for another project", async () => {
    const d = deps(card({ targetProject: { key: "directory:/snap", label: "snap", path: "/snap" } }));
    const listed = await listThreadTodoDispatchEnvironments({ id: "todo-1" }, d);
    expect(listed).toMatchObject({ projectLabel: "snap", defaultEnvironmentId: "ci", defaultSource: "project" });
    expect(d.readThreadEnvironmentId).not.toHaveBeenCalled();
    expect(d.listOptions).toHaveBeenCalledWith("/snap");
  });

  it("finds this machine's copy of another machine's project and uses its preset", async () => {
    const d = deps(card());
    const listed = await listThreadTodoDispatchEnvironments({ project: { key: "directory:/repo", label: "repo", path: "/repo" } }, d);
    expect(listed).toMatchObject({ projectFound: true, defaultEnvironmentId: "ci", defaultSource: "project" });
    expect(d.readProjectPresetId).toHaveBeenCalledWith("directory:C:/src/repo");
    expect(d.listOptions).toHaveBeenCalledWith("C:/src/repo");
  });

  it("tells another machine which repository the card's project clones", async () => {
    const d = {
      ...deps(card({ sourceProject: { key: "directory:/src/PwrAgnt", label: "PwrAgnt", path: "/src/PwrAgnt" } })),
      listProjects: async () => [{
        key: "directory:/src/PwrAgnt", label: "PwrAgnt", kind: "directory" as const, path: "/src/PwrAgnt",
        repositoryKey: "github.com/pwrdrvr/pwragent", repositoryKeys: ["github.com/fixture-user/pwragent"],
      }],
    };
    expect(await listThreadTodoDispatchEnvironments({ id: "todo-1" }, d)).toMatchObject({
      projectLabel: "PwrAgnt",
      repositoryKey: "github.com/pwrdrvr/pwragent",
      repositoryKeys: ["github.com/fixture-user/pwragent"],
    });
  });

  it("finds this machine's copy filed under another name by its origin", async () => {
    const d = {
      ...deps(card()),
      listProjects: async () => [
        { key: "directory:C:/scratch/PwrAgnt", label: "PwrAgnt", kind: "directory" as const, path: "C:/scratch/PwrAgnt",
          repositoryKey: "github.com/fixture-user/pwragnt-notes" },
        { key: "directory:C:/src/PwrAgent", label: "PwrAgent", kind: "directory" as const, path: "C:/src/PwrAgent",
          repositoryKey: "github.com/pwrdrvr/pwragent" },
      ],
    };
    const listed = await listThreadTodoDispatchEnvironments({
      project: { key: "directory:/src/PwrAgnt", label: "PwrAgnt", path: "/src/PwrAgnt", repositoryKey: "github.com/pwrdrvr/pwragent" },
    }, d);
    expect(listed).toMatchObject({ projectFound: true, projectLabel: "PwrAgent" });
    expect(d.listOptions).toHaveBeenCalledWith("C:/src/PwrAgent");
  });

  it("says when this machine has no copy of the project", async () => {
    const d = { ...deps(card()), listProjects: async () => [] };
    expect(await listThreadTodoDispatchEnvironments({ project: { key: "k", label: "other", path: "/other" } }, d))
      .toEqual({ projectFound: false, environments: [], defaultSource: "none" });
  });

  it("falls back to none when neither default is in the list", async () => {
    const d = { ...deps(card()), readThreadEnvironmentId: vi.fn(async () => "gone"), readProjectPresetId: vi.fn(async () => undefined) };
    expect(await listThreadTodoDispatchEnvironments({ id: "todo-1" }, d)).toMatchObject({ defaultSource: "none" });
  });
});
