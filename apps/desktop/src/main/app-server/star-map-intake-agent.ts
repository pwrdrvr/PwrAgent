import {
  PWRAGENT_TOOL_NAMESPACE,
  type AppServerBackendKind,
  type CreateInstanceThreadResult,
  type PwrAgentFederationOperationName,
} from "@pwragent/shared";
import type { DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import {
  agentToolFailure,
  agentToolSuccess,
  type AgentToolDefinition,
} from "../agent-tools/agent-tool-definition";
import {
  AgentToolRouter,
  readAgentDynamicToolCall,
  toDynamicToolResponse,
} from "../agent-tools/agent-tool-router";
import {
  buildPwrAgentFederationToolDefinitions,
  type PwrAgentFederationHandler,
} from "../agent-tools/pwragent-federation-agent-tools";
import type { HelperThreadToolCallHandler } from "../codex-app-server/client";
import {
  MAX_DISAMBIGUATION_CANDIDATES,
  truncateCandidateReason,
} from "./star-map-intake-candidates";

/**
 * The tools the Star Map `[+]` intake agent may call.
 *
 * Deliberately far narrower than the `federation` catalog it is drawn from,
 * and narrower still than `thread_orchestration`, which is not here at all.
 * Two independent reasons:
 *
 * 1. Blast radius. The intake exists to create one thread. Every tool that
 *    mutates an *existing* thread — `steer_thread`, `stop_thread`,
 *    `send_message_to_thread`, `start_review`, `move_thread_workspace`,
 *    `detach_thread_directory`, the monitor tools — is a way for a misfire to
 *    damage work the operator did not mention. `search_federation_threads` is
 *    withheld for the same reason: it is the tool that would let a confused
 *    agent *find* something to damage.
 * 2. They cannot work here. `handoff_task` and `attach_thread_directory` act
 *    on "the current thread" and gate on `isLiveDynamicToolCall`, which an
 *    ephemeral intake turn cannot satisfy. Advertising them would spend
 *    tokens describing tools whose only possible answer is `forbidden`.
 *
 * `create_instance_thread` with the default `groupingMode: "none"` — its own
 * description calls this "independent intake" — is the whole job.
 */
const INTAKE_FEDERATION_TOOLS: readonly PwrAgentFederationOperationName[] = [
  "list_federation_instances",
  "list_instance_projects",
  "create_instance_thread",
];

export const ASK_OPERATOR_TO_PICK_PROJECT_TOOL = "ask_operator_to_pick_project";

export type StarMapIntakeAgentOutcome =
  | {
      kind: "created";
      backend: AppServerBackendKind;
      threadId: string;
    }
  | {
      kind: "needs_disambiguation";
      candidates: { directoryKey: string; reason?: string }[];
      /**
       * The task payload the agent extracted before it got stuck. Carrying it
       * out of the ask is what makes the operator's pick cost nothing: the
       * second dispatch creates the thread directly instead of paying for a
       * second agent turn to re-derive the same sentence.
       */
      input?: string;
    }
  | {
      /**
       * A creation was still running when the turn ended. The thread is
       * probably being created and this intake is finished either way: the
       * one thing that must not happen is the caller treating this as "no
       * thread" and creating a second one.
       */
      kind: "creation_unconfirmed";
    };

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Builds the intake agent's tool surface and captures what it did.
 *
 * The outcome is read from the tools rather than from a final structured
 * message: a turn that created a thread has already produced its result, and
 * making that result depend on the model also emitting well-formed JSON adds
 * a second way for a successful intake to be reported as a failure.
 */
export function buildStarMapIntakeAgentTools(params: {
  federationHandler: PwrAgentFederationHandler | undefined;
  /** Resolves an agent-supplied project key to a registered directory key. */
  resolveDirectoryKey: (projectKey: string) => string | undefined;
  /**
   * Called with the project key the moment a creation is about to happen, so
   * the dialog can name it while there is still nothing to undo. This is the
   * last instant the operator can catch a wrong pick — after it returns, the
   * thread exists — and in the confident path nothing else ever names the
   * project out loud.
   */
  onCreateStarting?: (projectKey: string) => void;
}): {
  dynamicTools: DynamicToolSpec[];
  handleToolCall: HelperThreadToolCallHandler;
  readOutcome: () => StarMapIntakeAgentOutcome | undefined;
  /**
   * Whether a creation was started and has not answered yet. The caller reads
   * this when a turn ends without an outcome: a creation still running is not
   * the same as no thread, and treating it as one is how a single request
   * ends up with two threads.
   */
  isCreationInFlight: () => boolean;
} {
  let outcome: StarMapIntakeAgentOutcome | undefined;
  /**
   * Set synchronously, before the creation is awaited. `outcome` alone cannot
   * hold the cap: it is only assigned once the creation resolves, so two calls
   * arriving in the same step would both read it as unset and both proceed.
   * Codex dispatches inbound tool calls concurrently, so that is a real
   * interleaving and not a theoretical one.
   */
  let creationInFlight = false;

  /**
   * The one-thread cap. The classifier this replaces could only ever create a
   * single thread in a single project; a tool-using agent can loop. Refusing
   * the second creation keeps the blast radius of a misfire identical to what
   * it was, and says why, so a model that misread the request stops rather
   * than retrying against a generic error.
   *
   * A creation that *failed* releases the flag: the model may legitimately
   * retry a different project after a `not_found`. Only a creation that
   * succeeded is final.
   */
  const federationHandler: PwrAgentFederationHandler | undefined =
    params.federationHandler
      ? async (request) => {
          if (request.operation !== "create_instance_thread") {
            return await params.federationHandler!(request);
          }
          if (outcome || creationInFlight) {
            return {
              ok: false,
              error: {
                code: "forbidden",
                message: outcome
                  ? "This intake has already finished. Exactly one thread is"
                    + " created per request, so do not call this tool again —"
                    + " end the turn instead."
                  : "A thread is already being created for this request. Wait"
                    + " for that call to return; do not start another.",
              },
            };
          }
          creationInFlight = true;
          try {
            // Only a key this instance recognizes is announced: the fallback
            // would put a raw directory key where the dialog prints a project
            // name, on the one line that exists for the operator to catch a
            // wrong pick.
            const projectKey = readString(request.args.projectKey);
            if (projectKey && params.resolveDirectoryKey(projectKey)) {
              params.onCreateStarting?.(projectKey);
            }
            const response = await params.federationHandler!(request);
            if (response.ok) {
              const result = response.data as CreateInstanceThreadResult;
              outcome = {
                kind: "created",
                backend: result.backend,
                threadId: result.threadId,
              };
            }
            return response;
          } finally {
            creationInFlight = false;
          }
        }
      : undefined;

  const askTool: AgentToolDefinition = {
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name: ASK_OPERATOR_TO_PICK_PROJECT_TOOL,
    description:
      "Ask the operator which project the request belongs to, when the"
      + " request does not say and you cannot tell. This ends your turn: the"
      + " operator picks from the candidates you rank here and PwrAgent"
      + " creates the thread, so do not call create_instance_thread"
      + " afterwards. Prefer this to guessing — a thread created in the wrong"
      + " project costs the operator more than one question. Pass the task"
      + " payload in input exactly as you would have passed it to"
      + " create_instance_thread, so their pick does not cost another turn.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["candidates"],
      properties: {
        candidates: {
          type: "array",
          description:
            "Plausible projects, most likely first, at most"
            + ` ${MAX_DISAMBIGUATION_CANDIDATES}. Use projectKey values from`
            + " list_instance_projects only. Return an empty array when"
            + " nothing in the request points anywhere: the operator is then"
            + " shown their recent projects, and an invented ranking makes"
            + " that harder, not easier.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["projectKey", "reason"],
            properties: {
              projectKey: { type: "string" },
              reason: {
                type: "string",
                description:
                  "One short clause (under 12 words) naming the evidence you"
                  + " used, addressed to the operator: \"matches the PwrSnap"
                  + " screenshot work\", not \"the request mentions"
                  + " screenshots\".",
              },
            },
          },
        },
        input: {
          type: "string",
          description:
            "The concrete task for the thread's first turn, with the"
            + " instruction that addressed you removed. Omit only if the"
            + " request carries no task at all.",
        },
      },
    },
    dispatch: (args) => {
      if (outcome) {
        return agentToolFailure({
          code: "forbidden",
          message:
            "This intake has already finished. End the turn.",
        });
      }
      const rawCandidates = Array.isArray(args.candidates) ? args.candidates : [];
      const seen = new Set<string>();
      const candidates: { directoryKey: string; reason?: string }[] = [];
      for (const entry of rawCandidates) {
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as { projectKey?: unknown; reason?: unknown };
        const projectKey = readString(record.projectKey);
        if (!projectKey) continue;
        const directoryKey = params.resolveDirectoryKey(projectKey);
        if (!directoryKey || seen.has(directoryKey)) continue;
        seen.add(directoryKey);
        const reason = readString(record.reason);
        candidates.push({
          directoryKey,
          ...(reason ? { reason: truncateCandidateReason(reason) } : {}),
        });
        if (candidates.length >= MAX_DISAMBIGUATION_CANDIDATES) break;
      }
      const input = readString(args.input);
      outcome = {
        kind: "needs_disambiguation",
        candidates,
        ...(input ? { input } : {}),
      };
      return agentToolSuccess({
        asked: true,
        candidateCount: candidates.length,
        message:
          "The operator will pick from these candidates. End the turn now;"
          + " PwrAgent creates the thread once they choose.",
      });
    },
  };

  const router = new AgentToolRouter(
    [
      ...buildPwrAgentFederationToolDefinitions(federationHandler).filter(
        (definition) =>
          INTAKE_FEDERATION_TOOLS.includes(
            definition.name as PwrAgentFederationOperationName,
          ),
      ),
      askTool,
    ],
    { unsupportedMessage: "That tool is not available to the Star Map intake." },
  );

  return {
    dynamicTools: router.buildDynamicToolSpecs(),
    handleToolCall: async (request) => {
      const call = readAgentDynamicToolCall(request);
      if (!call) {
        return toDynamicToolResponse(
          agentToolFailure({
            code: "invalid_arguments",
            message: "That is not a PwrAgent tool call.",
          }),
        );
      }
      // An unknown or withheld tool is refused by the router itself, with the
      // `unsupportedMessage` it was constructed with.
      return await router.handleDynamicToolCall({ backend: "codex", call });
    },
    readOutcome: () => outcome,
    isCreationInFlight: () => creationInFlight,
  };
}

/**
 * What the intake agent is. Kept deliberately short: the tool descriptions
 * already carry the operational detail (settings inheritance, work modes,
 * overrides only on request), and repeating it here would give the model two
 * sources to reconcile.
 *
 * The one thing no tool description can say is the thing this whole surface
 * exists for — that the operator is talking *to* the intake, so the sentence
 * they typed is an instruction to be carried out, not a prompt to be pasted.
 */
export const STAR_MAP_INTAKE_AGENT_SYSTEM = [
  "You are the PwrAgent Star Map intake. The operator typed one request into",
  "the [+] card. Your job is to start exactly one thread that does the work",
  "they described, in the right project, and then stop.",
  "",
  "The request is addressed to you. Separate the instruction to you from the",
  "task for the new thread, and pass only the task as input. \"Make a thread",
  "in the Foo project and ask it to rebuild the parser\" means: create one",
  "thread in Foo whose input is \"Rebuild the parser.\" Never pass the",
  "operator's sentence through unchanged when it addresses you — a thread",
  "whose first turn is an instruction to create a thread will create another",
  "one.",
  "",
  "A request that merely mentions threads is not addressed to you. \"Write a",
  "feature that creates threads from a template\" is the task itself; pass it",
  "through verbatim.",
  "",
  "Call list_federation_instances, then list_instance_projects, to find the",
  "project. Page the project list when it is incomplete rather than deciding",
  "from the first page. Then call create_instance_thread once.",
  "",
  "If the request does not say which project and you cannot tell, call",
  ASK_OPERATOR_TO_PICK_PROJECT_TOOL + " instead of guessing.",
  "",
  "Apply operator startup preferences from ~/.pwragent/AGENTS.md when they",
  "are supplied below. Set model, execution mode, work mode or branch",
  "overrides only when the request or those preferences ask for them.",
  "",
  "Create one thread, then end the turn. Do not report back in prose; nobody",
  "reads it.",
].join("\n");
