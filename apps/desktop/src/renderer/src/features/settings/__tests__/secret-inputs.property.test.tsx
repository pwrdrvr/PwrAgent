import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopCodexModelProvider } from "@pwragent/shared/codex-model-providers";
import type { McpConnectionStatus } from "@pwragent/shared/contracts/mcp-connections";
import type {
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../../lib/desktop-api";
import { CodexModelProvidersSettings } from "../CodexModelProvidersSettings";
import {
  GithubConnectionFields,
  emptyGithubConnectionDraft,
} from "../GithubConnectionForm";
import { FormSecretInput } from "../FormSecretInput";
import { LocalCommandFields, emptyLocalCommandDraft } from "../LocalCommandConnectionForm";
import { PluginsSettings } from "../PluginsSettings";
import { SecretField } from "../SecretField";
import { describeFormSecret, secretStoreState } from "../secret-field-state";

// The rule, from PR #4076's design review, for every secret input in the
// renderer and not only the shared Settings row: the line under the input
// states whether a value is stored, in the same words everywhere; the
// placeholder says what typing does and never claims a value; and Remove is
// offered only while a value is stored. Before this rule covered them, five
// hand-rolled copies said "Stored", "Stored encrypted", "Stored securely",
// "saved" or "Ready", mostly in a placeholder, which disappears as soon as
// anything is typed.

const SAVED = "Saved in keychain";
const UNSET = "Not set";
const PASTE = "Paste the value here";
const PASTE_REPLACE = "Paste a new value to replace it";

afterEach(cleanup);

/** The status line nearest the input: under it, in its own row or field. */
function statusLine(input: HTMLElement): HTMLElement | null {
  for (let node = input.parentElement; node && node !== document.body; node = node.parentElement) {
    const line = node.querySelector<HTMLElement>(".settings-secret__status");
    if (line) return line;
  }
  return null;
}

/**
 * The oracle. Written out here rather than imported, so a surface that only
 * reuses the shared words cannot agree with itself by construction.
 */
function expectSecretRow(
  input: HTMLElement,
  expected: { stored: boolean; draft: boolean; removeName?: string },
) {
  expect(input).toHaveAttribute("placeholder", expected.stored ? PASTE_REPLACE : PASTE);
  const line = statusLine(input);
  expect(line).not.toBeNull();
  if (expected.draft) {
    expect(line).toHaveClass("is-draft");
    expect(line!.textContent).toMatch(/^Not saved yet\./);
  } else {
    expect(line).toHaveTextContent(new RegExp(`^${expected.stored ? SAVED : UNSET}$`));
  }
  if (expected.removeName) {
    const remove = screen.queryByRole("button", { name: expected.removeName });
    expect(Boolean(remove)).toBe(expected.stored && !expected.draft);
  }
}

// Something typed; whitespace alone is not a draft anywhere.
const arbDraft = fc.option(fc.constantFrom("sk-fixture", "fixture-token", "x"), { nil: "" });

describe("every secret input states its stored value the same way", () => {
  it("the shared Settings row (the reference)", () => {
    fc.assert(
      fc.property(fc.boolean(), arbDraft, (stored, draft) => {
        cleanup();
        render(
          <SecretField
            label="Fixture key"
            secret="telegramBotToken"
            state={{ configured: stored, source: stored ? "keychain" : "unset", writable: true }}
            onClearSecret={async () => true}
            onReplaceSecret={async () => true}
          />,
        );
        const input = screen.getByLabelText("Fixture key");
        if (draft) fireEvent.change(input, { target: { value: draft } });
        expectSecretRow(input, {
          stored,
          draft: Boolean(draft),
          removeName: "Remove saved Fixture key",
        });
      }),
      { numRuns: 8 },
    );
  });

  it("a Codex model provider's API key", () => {
    fc.assert(
      fc.property(fc.boolean(), arbDraft, (stored, draft) => {
        cleanup();
        const provider: DesktopCodexModelProvider = {
          id: "fixture",
          name: "Fixture",
          baseUrl: "https://fixture.example/v1",
          hasApiKey: stored,
        };
        render(
          <CodexModelProvidersSettings
            desktopApi={{} as DesktopApi}
            providers={[provider]}
            saving={false}
            onRefresh={async () => undefined}
            onRefreshCatalogs={async () => undefined}
            onSave={async () => true}
          />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Edit" }));
        const input = screen.getByLabelText("API key");
        if (draft) fireEvent.change(input, { target: { value: draft } });
        expectSecretRow(input, {
          stored,
          draft: Boolean(draft),
          removeName: "Remove saved API key",
        });
      }),
      { numRuns: 8 },
    );
  });

  it("a GitHub connection's personal access token", () => {
    fc.assert(
      fc.property(fc.boolean(), arbDraft, (stored, draft) => {
        cleanup();
        render(
          <GithubConnectionFields
            disabled={false}
            draft={{ ...emptyGithubConnectionDraft(), account: "token", tokenStored: stored, token: draft }}
            inspecting={false}
            onChange={() => undefined}
          />,
        );
        expectSecretRow(screen.getByLabelText("Personal access token"), {
          stored,
          draft: Boolean(draft),
        });
      }),
      { numRuns: 8 },
    );
  });

  // A blank value keeps the stored secret; anything else, spaces included,
  // is written, since an environment value may hold them.
  it("a local command's secret environment variable", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.constantFrom("", " ", "fixture-token"), (stored, draft) => {
        cleanup();
        render(
          <LocalCommandFields
            disabled={false}
            draft={{
              ...emptyLocalCommandDraft(),
              commandLine: "fixture-server",
              env: [{ key: "env-fixture", name: "API_TOKEN", value: draft, secret: true, stored }],
            }}
            onChange={() => undefined}
          />,
        );
        expectSecretRow(screen.getByLabelText("API_TOKEN value"), {
          stored,
          draft: draft !== "",
        });
      }),
      { numRuns: 8 },
    );
  });

  // The owner is asked when the dialog opens. Before it could be, the line
  // claimed neither ("A saved value is never shown...") and Remove was always
  // offered, so an empty box looked the same as a stored token.
  it("a local IPC connection's session bearer token", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), arbDraft, async (stored, draft) => {
        cleanup();
        const api = ipcConnectionApi(stored);
        await act(async () => {
          render(
            <PluginsSettings
              desktopApi={api}
              snapshot={pluginsSnapshot()}
              onMcpGatewayEnabledChange={async () => undefined}
            />,
          );
        });
        const article = (await screen.findByText("Native app", { exact: true })).closest("article")!;
        await act(async () => {
          fireEvent.click(within(article).getByRole("button", { name: "Edit" }));
        });
        const dialog = within(screen.getByRole("dialog", { name: "Edit connection" }));
        const input = dialog.getByLabelText("Session bearer token");
        if (draft) fireEvent.change(input, { target: { value: draft } });
        await waitFor(() => expectSecretRow(input, {
          stored,
          draft: Boolean(draft),
          removeName: "Remove saved session bearer token",
        }));
        // Asked once, of the owner, and only for the connection being edited.
        expect(api.readMcpIpcBearerTokenState).toHaveBeenCalledTimes(1);
        expect(api.readMcpIpcBearerTokenState).toHaveBeenCalledWith({ connectionId: "native-app" });
      }),
      { numRuns: 8 },
    );
  });
});

// The rule: one click never deletes a stored secret. Its value is never shown
// again, so a stray click on Remove meant fetching the token from the provider
// a second time. A removal waits for a second, explicit confirmation, and Keep
// backs out of it.
type RemoveStep = "remove" | "confirm" | "keep";
const arbSteps = fc.array(fc.constantFrom<RemoveStep>("remove", "confirm", "keep"), {
  minLength: 1,
  maxLength: 8,
});

async function clickStep(step: RemoveStep, label: string): Promise<boolean> {
  const name = step === "remove"
    ? `Remove saved ${label}`
    : step === "confirm"
      ? `Remove saved ${label} now`
      : `Keep saved ${label}`;
  const button = screen.queryByRole("button", { name });
  if (!button) return false;
  // A removal's write settles before the next click, as it would for a person.
  await act(async () => {
    fireEvent.click(button);
  });
  return true;
}

/** Replays clicks against a model with one bit: is a removal being asked. */
async function expectRemovalWaitsForConfirm(
  steps: RemoveStep[],
  label: string,
  clears: () => number,
) {
  let asking = false;
  let confirmed = 0;
  for (const step of steps) {
    const clicked = await clickStep(step, label);
    // A step the model cannot take must not be on screen to take.
    const available = step === "remove" ? !asking && confirmed === 0 : asking;
    expect(clicked).toBe(available);
    if (!clicked) continue;
    if (step === "remove") asking = true;
    else {
      asking = false;
      if (step === "confirm") confirmed += 1;
    }
    expect(clears()).toBe(confirmed);
  }
}

describe("removing a stored secret", () => {
  it("waits for confirmation in the shared Settings row", async () => {
    await fc.assert(
      fc.asyncProperty(arbSteps, async (steps) => {
        cleanup();
        const onClearSecret = vi.fn(async () => true);
        const state: DesktopSettingsSecretState = { configured: true, source: "keychain", writable: true };
        const view = render(
          <SecretField
            label="Fixture key"
            secret="telegramBotToken"
            state={state}
            onClearSecret={onClearSecret}
            onReplaceSecret={async () => true}
          />,
        );
        // The store answers a removal by reporting the value gone.
        onClearSecret.mockImplementation(async () => {
          view.rerender(
            <SecretField
              label="Fixture key"
              secret="telegramBotToken"
              state={{ configured: false, source: "unset", writable: true }}
              onClearSecret={onClearSecret}
              onReplaceSecret={async () => true}
            />,
          );
          return true;
        });
        await expectRemovalWaitsForConfirm(steps, "Fixture key", () => onClearSecret.mock.calls.length);
      }),
      { numRuns: 8 },
    );
  });
});

describe("a secret in a form that writes on its own Save", () => {
  // The box the model provider, GitHub, MCP and Federation forms share. Remove
  // only marks the value, so it never asks; Keep undoes the mark.
  it("offers Remove for a stored value and Keep while it is marked", () => {
    fc.assert(
      fc.property(fc.boolean(), arbDraft, fc.boolean(), (stored, draft, removing) => {
        fc.pre(!(removing && (!stored || draft)));
        cleanup();
        const onRemove = vi.fn();
        render(
          <FormSecretInput
            label="Fixture key"
            removing={removing}
            value={draft}
            view={describeFormSecret(secretStoreState(stored), { dirty: Boolean(draft), removing })}
            onChange={() => undefined}
            onRemove={onRemove}
          />,
        );
        const input = screen.getByLabelText("Fixture key");
        if (removing) {
          expect(input).toBeDisabled();
          expect(statusLine(input)).toHaveTextContent("Not removed yet. Removed when you save.");
          fireEvent.click(screen.getByRole("button", { name: "Keep saved Fixture key" }));
          expect(onRemove).toHaveBeenLastCalledWith(false);
          return;
        }
        expectSecretRow(input, { stored, draft: Boolean(draft), removeName: "Remove saved Fixture key" });
        const remove = screen.queryByRole("button", { name: "Remove saved Fixture key" });
        if (remove) {
          fireEvent.click(remove);
          expect(onRemove).toHaveBeenLastCalledWith(true);
        }
      }),
      { numRuns: 8 },
    );
  });
});

describe("a local IPC connection's session bearer token", () => {
  async function openEdit(api: DesktopApi) {
    await act(async () => {
      render(
        <PluginsSettings
          desktopApi={api}
          snapshot={pluginsSnapshot()}
          onMcpGatewayEnabledChange={async () => undefined}
        />,
      );
    });
    const article = (await screen.findByText("Native app", { exact: true })).closest("article")!;
    await act(async () => {
      fireEvent.click(within(article).getByRole("button", { name: "Edit" }));
    });
    return within(screen.getByRole("dialog", { name: "Edit connection" }));
  }

  // Remove is offered while the owner has not answered. Pressed then, and
  // answered "nothing stored", the box must not go on promising a removal.
  it("drops a removal marked before the owner says nothing is stored", async () => {
    let answer!: (stored: boolean) => void;
    const api = ipcConnectionApi(false);
    api.readMcpIpcBearerTokenState = vi.fn(async () => await new Promise<{ connectionId: string; stored: boolean }>((resolve) => {
      answer = (stored) => resolve({ connectionId: "native-app", stored });
    }));
    const dialog = await openEdit(api);
    fireEvent.click(dialog.getByRole("button", { name: "Remove saved session bearer token" }));
    expect(dialog.getByText("Not removed yet. Removed when you save.")).toBeInTheDocument();
    await act(async () => answer(false));
    const input = dialog.getByLabelText("Session bearer token");
    expect(input).toBeEnabled();
    expect(dialog.queryByRole("button", { name: "Keep saved session bearer token" })).toBeNull();
    expectSecretRow(input, { stored: false, draft: false, removeName: "Remove saved session bearer token" });
  });

  // An agent or another window can set or remove the token while the dialog
  // is open; this machine announces it, and the line follows.
  it("asks again when this machine changes the connection", async () => {
    let stored = true;
    let announce!: (event: { connectionIds: string[] }) => void;
    const api = ipcConnectionApi(true);
    api.readMcpIpcBearerTokenState = vi.fn(async () => ({ connectionId: "native-app", stored }));
    api.onMcpConnectionsChanged = vi.fn((callback) => {
      announce = callback;
      return () => undefined;
    });
    const dialog = await openEdit(api);
    const input = dialog.getByLabelText("Session bearer token");
    await waitFor(() => expectSecretRow(input, { stored: true, draft: false }));
    stored = false;
    await act(async () => announce({ connectionIds: ["another-connection"] }));
    expectSecretRow(input, { stored: true, draft: false });
    await act(async () => announce({ connectionIds: ["native-app"] }));
    await waitFor(() => expectSecretRow(input, { stored: false, draft: false }));
  });
});

describe("a removal question", () => {
  it("is dropped when the value goes away, and does not come back with a new one", () => {
    const row = (configured: boolean) => (
      <SecretField
        label="Fixture key"
        secret="telegramBotToken"
        state={{ configured, source: configured ? "keychain" : "unset", writable: true }}
        onClearSecret={async () => true}
        onReplaceSecret={async () => true}
      />
    );
    const view = render(row(true));
    fireEvent.click(screen.getByRole("button", { name: "Remove saved Fixture key" }));
    expect(screen.getByRole("button", { name: "Keep saved Fixture key" })).toBeInTheDocument();
    // Removed from another window, then stored again there.
    view.rerender(row(false));
    view.rerender(row(true));
    expect(screen.queryByRole("button", { name: "Keep saved Fixture key" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove saved Fixture key" })).toBeInTheDocument();
    expect(statusLine(screen.getByLabelText("Fixture key"))).toHaveTextContent(/^Saved in keychain$/);
  });
});

/** Settings → Plugins with one local IPC connection, owned by this window. */
function ipcConnectionApi(stored: boolean): DesktopApi {
  const connection: McpConnectionStatus = {
    id: "native-app",
    displayName: "Native app",
    serverUrl: "unix:///tmp/fixture/server.sock#/mcp",
    kind: "remote",
    authMode: "none",
    enabled: true,
    configured: true,
    state: "ready",
    createdAt: 0,
    updatedAt: 0,
  };
  return {
    listCodexMcpServers: vi.fn(async () => ({ codexHome: "/fixture/.codex", detail: "toolsAndAuthOnly", servers: [] })),
    reloadCodexMcpServers: vi.fn(async () => ({ codexHome: "/fixture/.codex", queued: true })),
    onAgentEvent: vi.fn(() => () => undefined),
    listMcpConnections: vi.fn(async () => ({ connections: [connection] })),
    listMcpConnectionTools: vi.fn(async () => ({ connectionId: connection.id, tools: [], fetchedAt: 1 })),
    updateMcpConnection: vi.fn(async () => ({ connectionId: connection.id, connection })),
    readMcpIpcBearerTokenState: vi.fn(async () => ({ connectionId: connection.id, stored })),
  } as unknown as DesktopApi;
}

/** The parts of the snapshot Settings → Plugins reads, gateway on. */
function pluginsSnapshot(): DesktopSettingsSnapshot {
  return {
    general: { mcpGatewayEnabled: { value: true, source: "default" } },
    runtime: {
      messaging: { disabled: false },
      tokenMiser: { managedCodex: { state: "ready", version: "pwragent-v0.149.0" } },
    },
    models: {
      codex: {
        profiles: {
          profileRoot: "/fixture/.codex/profiles",
          effectiveCodexHome: "/fixture/.codex",
          profiles: [{
            name: "",
            displayName: "System default",
            codexHome: "/fixture/.codex",
            source: "default",
            exists: true,
            selected: true,
            hasAuthFile: true,
            hasConfigFile: true,
          }],
        },
      },
    },
  } as unknown as DesktopSettingsSnapshot;
}
