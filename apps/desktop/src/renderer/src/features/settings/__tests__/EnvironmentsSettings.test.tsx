import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodexEnvironmentDocument,
  ReadCodexEnvironmentDocumentResponse,
  SaveCodexEnvironmentDocumentRequest,
  SaveCodexEnvironmentDocumentResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { chooseSelectOption } from "../../../test/select";
import {
  decodeEnvironmentsRoute,
  encodeEnvironmentsRoute,
  EnvironmentsSettings,
  environmentsRouteLabel,
} from "../EnvironmentsSettings";

afterEach(() => {
  cleanup();
});

const PROJECT = "/fixture/code/pwragent-demo";

function nodeDev(): CodexEnvironmentDocument {
  return {
    name: "Node dev",
    setup: {
      mode: "shared",
      script: "nvm install\ncorepack enable\npnpm install",
      platformScripts: {},
    },
    cleanup: { mode: "shared", script: "", platformScripts: {} },
    actions: [
      {
        key: "entry-0",
        name: "Dev server",
        icon: "run",
        mode: "shared",
        command: "pnpm dev",
        platformCommands: {},
        sourceEntries: { all: 0 },
      },
      {
        key: "entry-1",
        name: "Tests",
        icon: "test",
        mode: "shared",
        command: "pnpm test",
        platformCommands: {},
        sourceEntries: { all: 1 },
      },
    ],
  };
}

function createApi(overrides: Partial<DesktopApi> = {}) {
  const save = vi.fn(
    async (
      request: SaveCodexEnvironmentDocumentRequest,
    ): Promise<SaveCodexEnvironmentDocumentResponse> => ({
      status: "saved",
      document: request.document,
      revision: "rev-2",
      sourcePath: `${request.directoryPath}/.codex/environments/${request.fileName}`,
    }),
  );
  const api = {
    listCodexEnvironmentProjects: vi.fn(async () => ({
      projects: [
        { path: PROJECT, label: "pwragent-demo" },
        { path: "/fixture/code/docs-site", label: "docs-site" },
      ],
    })),
    listCodexEnvironmentFiles: vi.fn(async ({ directoryPath }: { directoryPath: string }) => ({
      directoryPath,
      files: directoryPath === PROJECT
        ? [
            {
              fileName: "environment.toml",
              name: "Node dev",
              setupPlatforms: [],
              actionCount: 3,
            },
            {
              fileName: "docs.toml",
              name: "Docs site",
              setupPlatforms: ["darwin", "linux", "win32"] as const,
              actionCount: 1,
            },
            {
              fileName: "legacy.toml",
              setupPlatforms: [],
              actionCount: 0,
              error: { message: "Line 14 has a value PwrAgent can't read.", line: 14 },
            },
          ]
        : [],
    })),
    readCodexEnvironmentDocument: vi.fn(
      async (): Promise<ReadCodexEnvironmentDocumentResponse> => ({
        status: "ok",
        document: nodeDev(),
        revision: "rev-1",
        sourcePath: `${PROJECT}/.codex/environments/environment.toml`,
      }),
    ),
    saveCodexEnvironmentDocument: save,
    ...overrides,
  } as unknown as DesktopApi;
  return { api, save };
}

function Harness(props: {
  api: DesktopApi;
  initialSub?: string;
  passSetupVariablesToAgents?: boolean;
  onPassChange?: (value: boolean) => Promise<void>;
  onRoute?: (sub: string | undefined) => void;
}) {
  const [sub, setSub] = useState(props.initialSub);
  return (
    <EnvironmentsSettings
      desktopApi={props.api}
      passSetupVariablesToAgents={{
        value: props.passSetupVariablesToAgents ?? true,
        source: "default",
      }}
      saving={false}
      sub={sub}
      onOpenRoute={(next) => {
        props.onRoute?.(next);
        setSub(next);
      }}
      onPassSetupVariablesToAgentsChange={
        props.onPassChange ?? (async () => undefined)
      }
    />
  );
}

function editorRoute(fileName = "environment.toml", name = "Node dev"): string {
  return encodeEnvironmentsRoute({ project: PROJECT, file: fileName, name })!;
}

async function openEditor(api: DesktopApi): Promise<void> {
  render(<Harness api={api} initialSub={editorRoute()} />);
  await screen.findByRole("heading", { name: "Node dev", level: 1 });
}

describe("environments route", () => {
  it("round-trips a project, file and name, and labels the breadcrumb", () => {
    const sub = editorRoute();
    expect(decodeEnvironmentsRoute(sub)).toEqual({
      project: PROJECT,
      file: "environment.toml",
      name: "Node dev",
    });
    expect(environmentsRouteLabel(sub)).toBe("Node dev");
    expect(environmentsRouteLabel(
      encodeEnvironmentsRoute({ project: PROJECT, create: true }),
    )).toBe("New environment");
    // A project-only route is the list: no crumb.
    expect(environmentsRouteLabel(encodeEnvironmentsRoute({ project: PROJECT }))).toBeUndefined();
    expect(decodeEnvironmentsRoute("not json")).toEqual({});
  });
});

describe("EnvironmentsSettings list", () => {
  it("turns the agent variables off for the profile", async () => {
    const { api } = createApi();
    const onPassChange = vi.fn(async () => undefined);
    render(<Harness api={api} onPassChange={onPassChange} />);

    const toggle = await screen.findByRole("switch", { name: /Pass setup variables to agents/ });
    expect(toggle).toBeChecked();
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(onPassChange).toHaveBeenCalledWith(false);
  });

  it("lists the first project's environments and opens one", async () => {
    const { api } = createApi();
    const onRoute = vi.fn();
    render(<Harness api={api} onRoute={onRoute} />);

    const nodeDevRow = await screen.findByRole("button", { name: "Open Node dev settings" });
    expect(nodeDevRow).toHaveAccessibleDescription(/environment\.toml.*one setup script.*3 actions/);
    expect(screen.getByRole("button", { name: "Open Docs site settings" }))
      .toHaveAccessibleDescription(/macOS, Linux, Windows setup.*1 action/);
    expect(screen.getByRole("button", { name: "Open legacy.toml settings" }))
      .toHaveAccessibleDescription(/Line 14 has a value PwrAgent can't read\..*Can't read/);

    fireEvent.click(nodeDevRow);
    expect(onRoute).toHaveBeenLastCalledWith(editorRoute());
    await screen.findByRole("heading", { name: "Node dev", level: 1 });
  });

  it("switches project and shows an empty project", async () => {
    const { api } = createApi();
    render(<Harness api={api} />);

    chooseSelectOption(await screen.findByRole("combobox", { name: "Project" }), "docs-site");
    expect(await screen.findByText("This project has no environments yet.")).toBeInTheDocument();
  });

  it("opens a workspace that is not in the project list, such as a thread's worktree", async () => {
    const { api } = createApi();
    const worktree = "/fixture/worktrees/abc123/pwragent-demo";
    render(<Harness api={api} initialSub={encodeEnvironmentsRoute({ project: worktree })} />);

    expect(await screen.findByRole("combobox", { name: "Project" })).toHaveTextContent("pwragent-demo");
    await waitFor(() => expect(api.listCodexEnvironmentFiles).toHaveBeenCalledWith({ directoryPath: worktree }));
  });
});

describe("EnvironmentsSettings editor", () => {
  it("saves a renamed environment against the revision it read", async () => {
    const { api, save } = createApi();
    await openEditor(api);

    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Node" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
      directoryPath: PROJECT,
      fileName: "environment.toml",
      expectedRevision: "rev-1",
      document: { name: "Node" },
    });
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument());
  });

  it("gives Windows its own setup script and keeps one when switching back", async () => {
    const { api, save } = createApi();
    await openEditor(api);

    const setup = screen.getByRole("region", { name: "Setup script" });
    fireEvent.click(within(setup).getByRole("radio", { name: /Separate macOS, Linux and Windows scripts/ }));
    const windowsTab = within(setup).getByRole("tab", { name: /Windows/ });
    expect(windowsTab).toHaveTextContent("Shared");
    fireEvent.click(windowsTab);
    const script = within(setup).getByRole("textbox", { name: "Windows setup script" });
    expect(script).toHaveValue("nvm install\ncorepack enable\npnpm install");
    fireEvent.change(script, { target: { value: "pnpm.cmd install" } });
    expect(within(setup).getByRole("tab", { name: /Windows/ })).not.toHaveTextContent("Shared");

    fireEvent.click(within(setup).getByRole("radio", { name: /One script for all platforms/ }));
    expect(within(setup).getByText(/Use one script for every platform\?/)).toBeInTheDocument();
    fireEvent.click(within(setup).getByRole("button", { name: "Keep Windows" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].document.setup).toEqual({
      mode: "shared",
      script: "pnpm.cmd install",
      platformScripts: {},
    });
  });

  it("adds, reorders and deletes actions", async () => {
    const { api, save } = createApi();
    await openEditor(api);

    const actions = screen.getByRole("region", { name: "Actions" });
    fireEvent.click(within(actions).getByRole("button", { name: "Add action" }));
    fireEvent.change(within(actions).getByRole("textbox", { name: "Action name" }), {
      target: { value: "Lint" },
    });
    fireEvent.change(within(actions).getByRole("textbox", { name: "Action command" }), {
      target: { value: "pnpm lint" },
    });
    chooseSelectOption(within(actions).getByRole("combobox", { name: "Action icon" }), "Test");
    fireEvent.click(within(actions).getByRole("button", { name: "Done" }));

    fireEvent.click(within(actions).getByRole("button", { name: "More for Lint" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    fireEvent.click(within(actions).getByRole("button", { name: "More for Dev server" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].document.actions.map((action) => [
      action.name,
      action.icon,
      action.command,
    ])).toEqual([
      ["Lint", "test", "pnpm lint"],
      ["Tests", "test", "pnpm test"],
    ]);
  });

  it("holds the save while the environment has no name or an action has no command", async () => {
    const { api, save } = createApi();
    await openEditor(api);

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "" } });
    expect(screen.getByText("Enter a name.")).toBeInTheDocument();
    const actions = screen.getByRole("region", { name: "Actions" });
    fireEvent.click(within(actions).getByRole("button", { name: "Edit Tests" }));
    fireEvent.change(within(actions).getByRole("textbox", { name: "Action command" }), {
      target: { value: "" },
    });
    expect(within(actions).getByText("Add a command, or delete this action.")).toBeInTheDocument();

    expect(screen.getByText("Fix 2 problems to save.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
  });

  it("says when the file changed on disk and reloads it", async () => {
    const { api } = createApi({
      saveCodexEnvironmentDocument: vi.fn(async () => ({ status: "conflict" as const })),
    });
    await openEditor(api);

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Node" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/environment\.toml changed on disk/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(api.readCodexEnvironmentDocument).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Node dev");
  });

  it("explains a file PwrAgent can't read and does not offer to edit it", async () => {
    const { api } = createApi({
      readCodexEnvironmentDocument: vi.fn(async () => ({
        status: "unreadable" as const,
        message: "Line 14 has a value PwrAgent can't read.",
        line: 14,
        excerpt: [
          { line: 13, text: "name = \"Seed\"" },
          { line: 14, text: "command = { run = \"pnpm seed\" }" },
        ],
        sourcePath: `${PROJECT}/.codex/environments/legacy.toml`,
      })),
    });
    render(<Harness api={api} initialSub={editorRoute("legacy.toml", "legacy.toml")} />);

    expect(await screen.findByText(/PwrAgent can't edit legacy\.toml\./)).toBeInTheDocument();
    expect(screen.getByText(/command = \{ run = "pnpm seed" \}/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
  });

  it("creates a new environment with a file name from its name", async () => {
    const { api, save } = createApi();
    const onRoute = vi.fn();
    render(
      <Harness
        api={api}
        initialSub={encodeEnvironmentsRoute({ project: PROJECT, create: true })}
        onRoute={onRoute}
      />,
    );

    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
      target: { value: "Docs Preview" },
    });
    expect(screen.getByRole("textbox", { name: "File" })).toHaveValue("docs-preview.toml");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ fileName: "docs-preview.toml" });
    expect(save.mock.calls[0]![0].expectedRevision).toBeUndefined();
    await waitFor(() => expect(onRoute).toHaveBeenLastCalledWith(
      encodeEnvironmentsRoute({ project: PROJECT, file: "docs-preview.toml", name: "Docs Preview" }),
    ));
  });

  it("says when a new environment's file name is taken", async () => {
    const { api } = createApi({
      saveCodexEnvironmentDocument: vi.fn(async () => ({ status: "exists" as const })),
    });
    render(
      <Harness api={api} initialSub={encodeEnvironmentsRoute({ project: PROJECT, create: true })} />,
    );

    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
      target: { value: "Docs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("docs.toml already exists in this project.")).toBeInTheDocument();
  });
});
