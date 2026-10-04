import { promises as fs } from "node:fs";
import path from "node:path";
import type { NavigationLaunchpadDefaults } from "@pwragent/shared";
import type { OpenVoiceManagerResponse } from "../../shared/native-voice";
import { getMainLogger } from "../log";
import { resolveActiveProfilePath } from "../profile";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";

const log = getMainLogger("pwragent:voice-manager");

/** PwrAgent-owned workspace; the manager is not a thread about a repository. */
const MANAGER_WORKSPACE_DIR = "voice-manager";

export const VOICE_MANAGER_THREAD_TITLE = "Voice manager";
export const VOICE_MANAGER_AGENT_NAME = "Voice manager";
export const VOICE_MANAGER_AGENT_INSTRUCTIONS = [
  "You are the operator's director for every PwrAgent thread, reached by live voice.",
  "Requests arrive as short spoken delegations relayed by a realtime voice model, so read them for intent, not exact wording.",
  "",
  "- Resolve \"this thread\", \"the one I'm looking at\" and \"here\" with read_operator_focus before acting on them.",
  "- Find any other thread with search_threads, which also searches connected peer machines. Pass the instanceId a result carries when you act on a peer's thread, and name that machine back to the operator.",
  "- Deliver work with send_message_to_thread for a new turn, or steer_thread for guidance to a turn that is running.",
  "- Use stop_thread only when the operator explicitly asks to stop a turn, and only after you have confirmed which thread and machine.",
  "- For \"what needs me\", \"what's running\" or \"what's waiting\", call list_attention_threads, which covers every connected machine. Summarize by machine: what is running, what is unread, what is waiting on the operator. Read a thread with read_thread or get_thread_status only when the operator wants detail.",
  "- When asked to mark a project read or clear its unread items, call mark_project_read once with its projectKey from list_instance_projects and the owning instanceId. It covers the entire project even when listings are truncated. Report changedCount; this does not archive or stop threads. For repeated independent tool calls, use Code Mode to batch them and print only a compact result when available.",
  "- When read_operator_focus reports a launchpad, the operator is starting a new thread in that project, and a request to do something is the new thread's task. Create it with create_instance_thread: projectKey from the launchpad, its instanceId, or the local instanceId from list_federation_instances when it has none, and the request as input. Leave backend, model and the other settings out unless the operator names them; the launchpad's own settings apply. Say back the project and machine, then the threadLink.",
  "- Start every new thread with create_instance_thread, on this machine too: list_federation_instances for the instanceId, list_instance_projects for the projectKey. Name the machine and project back before you create it when the operator was vague about either.",
  "- When the operator names a provider or model, take backend and the exact model ID from the backends list_instance_projects returns for that instance. Pick the closest listed model to what you heard, and say which one you chose.",
  "- Never use handoff_task. It asks the operator questions on this thread, and nobody is reading this thread.",
  "- Answer status questions about one thread with get_thread_status or read_thread.",
  "- Reply in one or two plain sentences that read well aloud: no tables, no code blocks, no raw links.",
  "- Report only what a tool result says happened. When a tool fails, say so and say why.",
  "- Do not edit files or run commands in this workspace. It holds only these instructions.",
].join("\n");

/**
 * Written under every name the supported backends read, matching the Star
 * Map manager. Voice runs only on Codex today, but the thread is ordinary and
 * an operator can still open and type into it.
 */
const MANAGER_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "QWEN.md"] as const;

const MANAGER_AGENTS_MD = [
  `# ${VOICE_MANAGER_AGENT_NAME}`,
  "",
  VOICE_MANAGER_AGENT_INSTRUCTIONS,
  "",
  "<!--",
  "Written by PwrAgent when the Voice manager thread is created, and rewritten",
  "whenever director voice starts, so instruction changes that ship with an",
  "upgrade reach an existing manager thread. Edits made here by hand will be",
  "overwritten; put durable operator preferences in the profile's own",
  "AGENTS.md instead.",
  "-->",
  "",
].join("\n");

export type VoiceManagerDeps = {
  registry?: Pick<
    ReturnType<typeof getDesktopBackendRegistry>,
    "startThread" | "renameThread" | "listThreads" | "setThreadTokenMiser"
  >;
  overlayStore?: Pick<
    ReturnType<typeof getDesktopOverlayStore>,
    "getVoiceManagerThread" | "setVoiceManagerThread" | "getLaunchpadDefaults" | "getThreadOverlayState"
  >;
  listThreadIds?: () => Promise<Set<string>>;
  workspaceDir?: () => string;
};

/**
 * Resolve the Voice manager thread, creating it on first use.
 *
 * Director voice needs a home that is not whichever thread the operator
 * happens to be reading. Like the Star Map manager, it is an ordinary Codex
 * thread with the ordinary PwrAgent tool catalog; this function owns only
 * which thread that is and the workspace its instructions live in. Always
 * Codex, because live voice is a Codex App Server capability.
 */
export async function openVoiceManagerThread(
  deps: VoiceManagerDeps = {},
): Promise<OpenVoiceManagerResponse> {
  try {
    const overlayStore = deps.overlayStore ?? getDesktopOverlayStore();
    const remembered = overlayStore.getVoiceManagerThread();
    if (remembered?.backend === "codex" && (await threadStillExists(remembered.threadId, deps))) {
      await refreshManagerWorkspace(deps.workspaceDir);
      await turnOffTokenMiser(remembered.threadId, deps);
      return { status: "ready", threadId: remembered.threadId, created: false };
    }
    const registry = deps.registry ?? getDesktopBackendRegistry();
    const workspace = await ensureManagerWorkspace(deps.workspaceDir);
    const defaults = await overlayStore.getLaunchpadDefaults();
    const started = await registry.startThread({
      backend: "codex",
      ...codexSettingsFrom(defaults),
      cwd: workspace,
      tokenMiserEnabled: false,
      agent: {
        name: VOICE_MANAGER_AGENT_NAME,
        instructions: VOICE_MANAGER_AGENT_INSTRUCTIONS,
      },
    });
    try {
      await registry.renameThread({
        backend: started.backend,
        threadId: started.threadId,
        name: VOICE_MANAGER_THREAD_TITLE,
      });
    } catch (error) {
      log.warn("could not title the voice manager thread", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    overlayStore.setVoiceManagerThread({ backend: started.backend, threadId: started.threadId });
    return { status: "ready", threadId: started.threadId, created: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("voice manager thread unavailable", { error: message });
    return { status: "failed", error: message };
  }
}

/** Whether a thread id is the remembered Voice manager thread. */
export function isVoiceManagerThread(
  threadId: string,
  overlayStore: Pick<ReturnType<typeof getDesktopOverlayStore>, "getVoiceManagerThread"> = getDesktopOverlayStore(),
): boolean {
  const remembered = overlayStore.getVoiceManagerThread();
  return remembered?.backend === "codex" && remembered.threadId === threadId;
}

/**
 * The launchpad's model choices carry over only when they are Codex choices:
 * a Claude model id handed to Codex would fail the start.
 */
function codexSettingsFrom(defaults: NavigationLaunchpadDefaults) {
  return {
    executionMode: defaults.executionMode,
    ...(defaults.backend === "codex"
      ? {
          model: defaults.model,
          reasoningEffort: defaults.reasoningEffort,
          serviceTier: defaults.serviceTier,
        }
      : {}),
  };
}

async function refreshManagerWorkspace(workspaceDir?: () => string): Promise<void> {
  try {
    await ensureManagerWorkspace(workspaceDir);
  } catch (error) {
    log.warn("could not refresh the voice manager instructions", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function ensureManagerWorkspace(workspaceDir?: () => string): Promise<string> {
  const directory = workspaceDir?.() ?? resolveActiveProfilePath(MANAGER_WORKSPACE_DIR);
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(
    MANAGER_INSTRUCTION_FILES.map(async (name) =>
      await fs.writeFile(path.join(directory, name), MANAGER_AGENTS_MD, "utf8"),
    ),
  );
  return directory;
}

/**
 * The manager runs without Token Miser. Its turns are short tool chains whose
 * results it must read at once, so paging output out saves nothing and every
 * retrieval is another round trip while the operator waits on a spoken answer.
 * Managers made before this rule are switched off once; a failure only logs.
 */
async function turnOffTokenMiser(threadId: string, deps: VoiceManagerDeps): Promise<void> {
  try {
    const overlayStore = deps.overlayStore ?? getDesktopOverlayStore();
    const overlay = await overlayStore.getThreadOverlayState({ backend: "codex", threadId });
    if (overlay?.tokenMiserEnabled === false) return;
    const registry = deps.registry ?? getDesktopBackendRegistry();
    await registry.setThreadTokenMiser({ backend: "codex", threadId, enabled: false });
  } catch (error) {
    log.warn("could not turn Token Miser off for the voice manager", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * An archived manager is replaced rather than reopened. A failed lookup
 * assumes the thread is still there: silently creating a second manager on
 * every transient failure is worse than one failed start.
 */
async function threadStillExists(threadId: string, deps: VoiceManagerDeps): Promise<boolean> {
  try {
    const ids = deps.listThreadIds
      ? await deps.listThreadIds()
      : new Set(
          (await (deps.registry ?? getDesktopBackendRegistry()).listThreads({
            backend: "codex",
            callerReason: "voice-manager-thread",
          }))
            .filter((thread) => thread.archivedAt === undefined)
            .map((thread) => thread.id),
        );
    return ids.has(threadId);
  } catch (error) {
    log.warn("could not verify the remembered voice manager thread", {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}
