import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  BOAT_SANDBOX_TYPES,
  boatSandboxTypeRank,
  isBoatSandboxType,
  redactBoatApiKeys,
  type BoatSandboxPolicy,
  type BoatSandboxType,
} from "@pwragent/shared/contracts/mcp-connections";
import { BoatApiError, type BoatApi, type BoatApiRequest } from "./boat-api";
import { BoatTunnelError, readBoatTunnelTarget, type BoatPortForwards } from "./boat-port-forward";

/**
 * PwrAgent's tools for Boat sandboxes: what an agent may do, and nothing else.
 *
 * Boat has no MCP server for sandbox control, so these tools are PwrAgent's
 * own, and every rule below holds whatever arguments an agent sends:
 *
 * - A request to Boat is built from named fields only. An argument this file
 *   does not read never reaches Boat.
 * - A port is never public. `host_port` always sends `public: false`, no tool
 *   sends `hostedPorts`, and an answer that says a port is public is an error.
 * - While the policy keeps credentials out, create, resume and fork always
 *   send `noEnv: true`.
 * - Size and auto-stop never exceed the operator's caps unless the operator
 *   approves that one request, shown its size and time. Unasked, declined or
 *   unanswerable, it is refused, not clamped, so the agent knows what it did
 *   not get.
 * - A named snapshot is saved only after the operator approves it, told that
 *   it outlives the thread and what Boat charges. PwrAgent never deletes one.
 * - A sandbox is created only from a named snapshot in the operator's own
 *   account, never from a share code someone else issued.
 * - A fork never copies a snapshot Boat is still writing. `fork_sandbox`
 *   waits for a stopping source to finish saving, or refuses.
 * - Every sandbox id must be one this thread created or forked. PwrAgent's
 *   own cleanup session may only stop and delete, and only such ids.
 * - No result or error contains a Boat API key PwrAgent has used, and no
 *   error contains anything shaped like one.
 */

export const BOAT_SERVER_INSTRUCTIONS = [
  "Boat sandboxes are cloud Ubuntu VMs that bill the operator per second while they run.",
  "Create one with create_sandbox, wait until get_sandbox reports state ready or idle, then use exec and the file tools. Both states accept commands; idle is a running sandbox with nothing executing.",
  "A command that may take longer than 30 seconds needs timeoutSeconds (up to 600) or detached: true with command_status to poll.",
  "Sandboxes start with none of the operator's credentials: no GitHub token, model keys or secrets. Write files in with write_file.",
  "host_port returns a private URL that works only with its token. Ports cannot be made public from here.",
  "forward_port makes a sandbox port answer at 127.0.0.1 on the operator's computer, for tools running there such as a local browser or database client. It ends when the sandbox stops or resumes.",
  "fork_sandbox copies the source's last saved snapshot, not its live disk: to fork the current state, call stop_sandbox on the source first, then fork it.",
  "A size or auto-stop above the operator's limit asks the operator to approve that one request; say why you need it before you ask.",
  "save_snapshot saves a sandbox under a name so later sandboxes for this project start warm: pass that name as fromSnapshot to create_sandbox. It asks the operator first, because a named snapshot stays in their Boat account after the thread ends and may cost a daily fee. Use it for a set-up project, not for work in progress; a stopped sandbox already keeps its disk for resume_sandbox and fork_sandbox.",
  "Only sandboxes this thread created are reachable. Call stop_sandbox or delete_sandbox when you are done; auto-stop is a backstop, not a spending cap.",
].join(" ");

export type BoatToolRole = "thread" | "cleanup" | "none";

export type BoatOwnedSandbox = { sandboxId: string; name?: string };

export type BoatToolsContext = {
  api: Pick<BoatApi, "request" | "redact">;
  policy: () => BoatSandboxPolicy;
  /**
   * `thread` is an agent's session. `cleanup` is PwrAgent releasing a
   * thread's sandboxes. `none` names no thread (a Settings tool listing) and
   * may call nothing.
   */
  role: BoatToolRole;
  /** Sandboxes the session's thread created or forked and still holds. */
  ownedSandboxIds: () => ReadonlySet<string>;
  recordOwned: (sandbox: BoatOwnedSandbox) => void;
  forgetOwned: (sandboxId: string) => void;
  idempotencyKey?: () => string;
  /**
   * The machine's tunnels, and the session these calls belong to. A tunnel
   * closes with the last session that asked for it. Absent where no tunnel
   * may be opened.
   */
  forwards?: { manager: BoatPortForwards; session: string };
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * Asks the operator a yes-or-no question about the call in flight.
 * `unavailable` means nobody could be asked: no person can see a prompt for
 * this call. It is never an approval.
 */
export type BoatConfirm = (message: string) => Promise<"approved" | "declined" | "unavailable">;

const SANDBOX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const NAME_LIMIT = 120;
const PATH_LIMIT = 4_096;
const COMMAND_LIMIT = 64 * 1024;
const SETUP_SCRIPT_LIMIT = 64 * 1024;
const WRITE_LIMIT_BYTES = 4 * 1024 * 1024;
const ENV_LIMIT = 100;
const ENV_BYTES_LIMIT = 64 * 1024;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const LIST_LIMIT = 25;
/** Boat is still writing the sandbox's snapshot while it reports these. */
const SAVING_STATES: ReadonlySet<string> = new Set(["stopping", "archiving"]);
const SAVING_WAIT_MS = 90_000;
const SAVING_POLL_MS = 3_000;
/** Beyond any approval: no auto-stop is set further out than a week. */
const TTL_CEILING_MINUTES = 7 * 24 * 60;
/** Boat's rule for a saved snapshot's name. A share code never matches it. */
const SNAPSHOT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RESERVED_SNAPSHOT_NAMES: ReadonlySet<string> = new Set([
  "latest", "tree", "pull", "rm", "save", "current", "self", "new",
]);
const SNAPSHOT_LIST_LIMIT = 100;
const snapshotNameProperty = {
  type: "string",
  description: "Lowercase letters, digits and hyphens, at most 63 characters, such as myapp-deps.",
} as const;
const CLEANUP_TOOLS: ReadonlySet<string> = new Set(["stop_sandbox", "delete_sandbox"]);

const sandboxIdProperty = { type: "string", description: "A sandbox this thread created, as create_sandbox returned it." } as const;
const typeProperty = { type: "string", enum: [...BOAT_SANDBOX_TYPES], description: "Machine size. Omit for the operator's default. A size above the operator's limit asks them to approve it." } as const;
const ttlProperty = { type: "integer", minimum: 1, description: "Minutes until auto-stop. Omit for the operator's default. More than the operator's limit asks them to approve it." } as const;

function tool(
  name: string,
  description: string,
  properties: Record<string, object>,
  required: string[],
  annotations: { readOnly?: boolean; destructive?: boolean } = {},
): Tool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: {
      readOnlyHint: annotations.readOnly === true,
      destructiveHint: annotations.destructive === true,
      openWorldHint: true,
    },
  };
}

export const BOAT_TOOLS: readonly Tool[] = [
  tool("create_sandbox", "Create a cloud Ubuntu VM. Billing starts now and runs until it stops. Returns its id; poll get_sandbox until state is ready or idle.", {
    name: { type: "string", maxLength: NAME_LIMIT },
    type: typeProperty,
    ttlMinutes: ttlProperty,
    env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables for this sandbox only." },
    setupScript: { type: "string", description: "A script run once in the background after boot." },
    fromSnapshot: { ...snapshotNameProperty, description: "Start from this named snapshot in the operator's Boat account instead of a clean machine. list_snapshots shows them." },
  }, []),
  tool("list_sandboxes", "List the sandboxes this thread created, with state, time left and cost so far.", {}, [], { readOnly: true }),
  tool("get_sandbox", "Read one sandbox's state, size, auto-stop time and cost so far.", { sandboxId: sandboxIdProperty }, ["sandboxId"], { readOnly: true }),
  tool("exec", "Run a shell command in a sandbox. Waits up to timeoutSeconds (default 30, at most 600). With detached: true it returns a processId at once.", {
    sandboxId: sandboxIdProperty,
    command: { type: "string" },
    cwd: { type: "string" },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 600 },
    detached: { type: "boolean" },
  }, ["sandboxId", "command"]),
  tool("command_status", "Read a detached command's status and its latest output.", {
    sandboxId: sandboxIdProperty,
    processId: { type: "integer" },
    tailBytes: { type: "integer", minimum: 1, maximum: 262_144 },
  }, ["sandboxId", "processId"], { readOnly: true }),
  tool("kill_command", "Stop a detached command.", {
    sandboxId: sandboxIdProperty,
    processId: { type: "integer" },
  }, ["sandboxId", "processId"]),
  tool("read_file", "Read a text file from a sandbox. Files over 5 MiB are refused; read them in parts with exec.", {
    sandboxId: sandboxIdProperty,
    path: { type: "string" },
  }, ["sandboxId", "path"], { readOnly: true }),
  tool("write_file", "Write a text file in a sandbox, replacing it if it exists.", {
    sandboxId: sandboxIdProperty,
    path: { type: "string" },
    content: { type: "string" },
  }, ["sandboxId", "path", "content"]),
  tool("list_files", "List a directory in a sandbox.", {
    sandboxId: sandboxIdProperty,
    path: { type: "string" },
  }, ["sandboxId"], { readOnly: true }),
  tool("host_port", "Get a private HTTPS URL for a port in a sandbox. The URL works only with the token it carries. Ports cannot be made public.", {
    sandboxId: sandboxIdProperty,
    port: { type: "integer", minimum: 1, maximum: 65_535 },
    title: { type: "string", maxLength: NAME_LIMIT },
    localhost: { type: "boolean", description: "True when the service listens on 127.0.0.1 only." },
  }, ["sandboxId", "port"]),
  tool("forward_port", "Make a port in a running sandbox reachable on the operator's computer at http://127.0.0.1:<localPort>, over SSH. Only this computer can reach it; for a browser elsewhere use host_port. Returns the local URL. It closes when the sandbox stops or resumes, or when this session ends; call it again afterwards.", {
    sandboxId: sandboxIdProperty,
    port: { type: "integer", minimum: 1, maximum: 65_535, description: "The port inside the sandbox." },
  }, ["sandboxId", "port"]),
  tool("close_port_forward", "Close a tunnel forward_port opened.", {
    sandboxId: sandboxIdProperty,
    port: { type: "integer", minimum: 1, maximum: 65_535, description: "The port inside the sandbox." },
  }, ["sandboxId", "port"]),
  tool("extend_sandbox", "Set how many minutes from now a sandbox auto-stops.", {
    sandboxId: sandboxIdProperty,
    ttlMinutes: { ...ttlProperty, description: "Minutes from now until auto-stop." },
  }, ["sandboxId", "ttlMinutes"]),
  tool("stop_sandbox", "Stop a sandbox and end its compute billing. Its disk is kept as a snapshot for at least 14 days.", { sandboxId: sandboxIdProperty }, ["sandboxId"]),
  tool("resume_sandbox", "Start a stopped sandbox from its latest snapshot. Billing starts again.", {
    sandboxId: sandboxIdProperty,
    type: typeProperty,
    ttlMinutes: ttlProperty,
  }, ["sandboxId"]),
  tool("fork_sandbox", "Create a new sandbox from another's last saved snapshot, not its live disk. Stop the source first to fork its current state; a source that is still saving is waited for. Returns the new sandbox and forkedFrom, the source's state when it was copied. Billing starts for the new one.", {
    sandboxId: sandboxIdProperty,
    type: typeProperty,
    ttlMinutes: ttlProperty,
  }, ["sandboxId"]),
  tool("delete_sandbox", "Permanently delete a sandbox and all of its data.", { sandboxId: sandboxIdProperty }, ["sandboxId"], { destructive: true }),
  tool("save_snapshot", "Save a sandbox's disk under a name, so later sandboxes can start from it with create_sandbox fromSnapshot. Asks the operator to approve: the snapshot stays in their Boat account after this thread ends and may cost a daily fee. Saving under a name that exists replaces it. Returns at once with status saving; poll get_snapshot until ready.", {
    sandboxId: sandboxIdProperty,
    name: snapshotNameProperty,
  }, ["sandboxId", "name"]),
  tool("get_snapshot", "Read one named snapshot: saving, ready or failed, its size and when it was saved.", { name: snapshotNameProperty }, ["name"], { readOnly: true }),
  tool("list_snapshots", "List the named snapshots in the operator's Boat account, and how many their plan includes.", {}, [], { readOnly: true }),
  tool("account_status", "Whether Boat can start a sandbox for this account now, how many are running, and how many named snapshots the plan includes.", {}, [], { readOnly: true }),
];

class Refusal extends Error {}

/** What a call asked for above a cap, for the one question it puts. */
type Asked = { over: Array<{ asks: string; limit: string; refusal: string }> };

const NOBODY_TO_ASK: BoatConfirm = async () => "unavailable";

type Args = Record<string, unknown>;

export class BoatTools {
  constructor(private readonly context: BoatToolsContext) {}

  list(): readonly Tool[] {
    return BOAT_TOOLS;
  }

  /** Never throws: a refusal or a Boat failure is an error result. */
  async call(
    name: string,
    args: Args | undefined,
    signal?: AbortSignal,
    confirm?: BoatConfirm,
  ): Promise<CallToolResult> {
    try {
      const result = await this.dispatch(name, args ?? {}, signal, confirm ?? NOBODY_TO_ASK);
      // Exact keys only: a result holds file contents and command output,
      // which a pattern would also rewrite.
      const text = this.context.api.redact(JSON.stringify(result));
      return {
        content: [{ type: "text", text }],
        structuredContent: JSON.parse(text) as Record<string, unknown>,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Refusal || error instanceof BoatApiError
        ? error.message
        : "PwrAgent's Boat server failed while handling this call.";
      return {
        isError: true,
        content: [{ type: "text", text: redactBoatApiKeys(this.context.api.redact(message)) }],
      };
    }
  }

  private async dispatch(
    name: string,
    args: Args,
    signal: AbortSignal | undefined,
    confirm: BoatConfirm,
  ): Promise<Record<string, unknown>> {
    const role = this.context.role;
    if (role === "none") {
      throw new Refusal("Boat tools run only for a thread that has Boat turned on.");
    }
    if (role === "cleanup" && !CLEANUP_TOOLS.has(name)) {
      throw new Refusal("PwrAgent's cleanup may only stop or delete a sandbox.");
    }
    const send = async (request: Omit<BoatApiRequest, "signal">): Promise<Record<string, unknown>> =>
      await this.context.api.request({ ...request, ...(signal ? { signal } : {}) });
    switch (name) {
      case "create_sandbox": {
        const from = args.fromSnapshot === undefined || args.fromSnapshot === null
          ? undefined
          : snapshotName(args.fromSnapshot, "fromSnapshot");
        // A snapshot carries its own size; only an asked-for size overrides it.
        const body: Record<string, unknown> = { ...await this.startFields(args, confirm, from === undefined) };
        if (from) {
          body.from = from;
          const ttl = this.context.policy().defaultTtlMinutes;
          if (body.ttlSeconds === undefined) body.ttlSeconds = ttl * 60;
        }
        const sandboxName = optionalString(args.name, "name", NAME_LIMIT);
        if (sandboxName) body.name = sandboxName;
        const env = readEnv(args.env);
        if (env) body.env = env;
        const setupScript = optionalString(args.setupScript, "setupScript", SETUP_SCRIPT_LIMIT);
        if (setupScript) body.setupScript = setupScript;
        const answer = await send({
          method: "POST", path: ["sandboxes"], body,
          headers: { "idempotency-key": this.idempotencyKey() },
        });
        return { sandbox: await this.adopt(answer.sandbox, send) };
      }
      case "list_sandboxes": {
        const ids = [...this.context.ownedSandboxIds()].slice(0, LIST_LIMIT);
        const described = await Promise.all(ids.map(async (sandboxId) => {
          try {
            return describeSandbox((await send({ method: "GET", path: ["sandboxes", sandboxId] })).sandbox);
          } catch (error) {
            if (!(error instanceof BoatApiError) || error.kind !== "not_found") throw error;
            this.context.forgetOwned(sandboxId);
            return undefined;
          }
        }));
        return { sandboxes: described.filter((sandbox) => sandbox !== undefined) };
      }
      case "get_sandbox": {
        const sandboxId = this.owned(args);
        return { sandbox: describeSandbox((await send({ method: "GET", path: ["sandboxes", sandboxId] })).sandbox) };
      }
      case "exec": {
        const sandboxId = this.owned(args);
        const timeoutSeconds = optionalInteger(args.timeoutSeconds, "timeoutSeconds", 1, 600);
        const cwd = optionalString(args.cwd, "cwd", PATH_LIMIT);
        const answer = await send({
          method: "POST", path: ["sandboxes", sandboxId, "commands"],
          body: {
            command: requiredString(args.command, "command", COMMAND_LIMIT),
            ...(cwd ? { cwd } : {}),
            ...(timeoutSeconds ? { timeoutSeconds } : {}),
            ...(args.detached === true ? { detached: true } : {}),
          },
          timeoutMs: ((timeoutSeconds ?? 30) + 30) * 1_000,
        });
        return pick(answer, [
          "success", "exitCode", "signal", "oomKilled", "stdout", "stderr",
          "stdoutTruncated", "stderrTruncated", "timedOut", "cwd", "processId", "logPath", "errLogPath",
        ]);
      }
      case "command_status": {
        const sandboxId = this.owned(args);
        const tailBytes = optionalInteger(args.tailBytes, "tailBytes", 1, 262_144);
        const answer = await send({
          method: "GET",
          path: ["sandboxes", sandboxId, "commands", String(requiredInteger(args.processId, "processId"))],
          query: { tailBytes: tailBytes ?? 16_384 },
        });
        return pick(answer, [
          "processId", "status", "running", "exitCode", "signal", "oomKilled",
          "stdout", "stderr", "stdoutTruncated", "stderrTruncated", "more",
        ]);
      }
      case "kill_command": {
        const sandboxId = this.owned(args);
        const answer = await send({
          method: "DELETE",
          path: ["sandboxes", sandboxId, "commands", String(requiredInteger(args.processId, "processId"))],
        });
        return pick(answer, ["processId", "running", "signaled"]);
      }
      case "read_file": {
        const sandboxId = this.owned(args);
        const answer = await send({
          method: "GET", path: ["sandboxes", sandboxId, "files"],
          query: { path: requiredString(args.path, "path", PATH_LIMIT) },
        });
        return pick(answer, ["path", "encoding", "size", "content"]);
      }
      case "write_file": {
        const sandboxId = this.owned(args);
        const content = typeof args.content === "string" ? args.content : undefined;
        if (content === undefined) throw new Refusal("content must be a string.");
        if (Buffer.byteLength(content) > WRITE_LIMIT_BYTES) {
          throw new Refusal("content is over 4 MiB. Write it in parts, or produce it with exec.");
        }
        const answer = await send({
          method: "PUT", path: ["sandboxes", sandboxId, "files"],
          body: { path: requiredString(args.path, "path", PATH_LIMIT), content, encoding: "utf8" },
        });
        return pick(answer, ["path", "size"]);
      }
      case "list_files": {
        const sandboxId = this.owned(args);
        const path = optionalString(args.path, "path", PATH_LIMIT);
        const answer = await send({
          method: "GET", path: ["sandboxes", sandboxId, "files", "list"],
          query: { path },
        });
        return pick(answer, ["path", "files", "truncated"]);
      }
      case "host_port": {
        const sandboxId = this.owned(args);
        const title = optionalString(args.title, "title", NAME_LIMIT);
        const answer = await send({
          method: "POST", path: ["sandboxes", sandboxId, "host"],
          body: {
            port: requiredInteger(args.port, "port", 1, 65_535),
            // Always private. No argument, approval or access mode changes this.
            public: false,
            ...(args.localhost === true ? { localhost: true } : {}),
            ...(title ? { title } : {}),
          },
        });
        if (answer.access === "public" || answer.isProtected === false) {
          throw new Refusal(
            "Boat reports this port as public, which PwrAgent never asks for. The URL is withheld; tell the operator to check the sandbox's hosted ports in the Boat dashboard.",
          );
        }
        return { ...pick(answer, ["port", "url", "localhost"]), access: "private" };
      }
      case "forward_port": {
        const sandboxId = this.owned(args);
        const port = requiredInteger(args.port, "port", 1, 65_535);
        const forwards = this.context.forwards;
        if (!forwards) throw new Refusal("A port forward can be opened only from a thread's session.");
        try {
          return {
            forward: await forwards.manager.open({
              session: forwards.session,
              sandboxId,
              port,
              register: async (publicKey) => readBoatTunnelTarget(await send({
                method: "POST", path: ["sandboxes", sandboxId, "sshkey"], body: { key: publicKey },
              })),
            }),
            access: "this computer only",
          };
        } catch (error) {
          if (error instanceof BoatTunnelError) throw new Refusal(error.message);
          throw error;
        }
      }
      case "close_port_forward": {
        const sandboxId = this.owned(args);
        const port = requiredInteger(args.port, "port", 1, 65_535);
        return { sandboxId, port, closed: await this.context.forwards?.manager.close(sandboxId, port) ?? false };
      }
      case "extend_sandbox": {
        const sandboxId = this.owned(args);
        const asked: Asked = { over: [] };
        const ttlSeconds = this.ttlSeconds(args.ttlMinutes, true, undefined, asked);
        await this.approveOver(asked, confirm, `keep sandbox ${sandboxId} running`);
        const answer = await send({ method: "PATCH", path: ["sandboxes", sandboxId], body: { ttlSeconds } });
        return { sandbox: describeSandbox(answer.sandbox) };
      }
      case "stop_sandbox": {
        const sandboxId = this.owned(args);
        await this.context.forwards?.manager.closeForSandbox(sandboxId);
        const answer = await send({ method: "POST", path: ["sandboxes", sandboxId, "stop"], body: {} });
        return { sandboxId, status: typeof answer.status === "string" ? answer.status : "stopping" };
      }
      case "resume_sandbox": {
        const sandboxId = this.owned(args);
        // A resumed sandbox is a new machine with a new address and host key.
        await this.context.forwards?.manager.closeForSandbox(sandboxId);
        const answer = await send({
          method: "POST", path: ["sandboxes", sandboxId, "resume"],
          body: await this.startFields(args, confirm, false),
        });
        return { sandboxId, status: typeof answer.status === "string" ? answer.status : "resuming" };
      }
      case "fork_sandbox": {
        const sandboxId = this.owned(args);
        const fields = await this.startFields(args, confirm, false);
        const source = await this.saved(sandboxId, send, signal);
        const answer = await send({
          method: "POST", path: ["sandboxes", sandboxId, "fork"],
          body: fields,
          headers: { "idempotency-key": this.idempotencyKey() },
        });
        const forked = answer.sandbox && typeof answer.sandbox === "object"
          ? answer.sandbox
          : { id: answer.id };
        return {
          sandbox: await this.adopt(forked, send),
          forkedFrom: pick(source, ["id", "state", "stoppedAt", "snapshotAvailable"]),
        };
      }
      case "delete_sandbox": {
        const sandboxId = this.owned(args);
        await this.context.forwards?.manager.closeForSandbox(sandboxId);
        try {
          await send({
            method: "DELETE", path: ["sandboxes", sandboxId],
            headers: { "x-ascii-confirm-delete": sandboxId },
          });
        } catch (error) {
          // Gone is what delete wanted. Cleanup reads "not found" as done.
          if (error instanceof BoatApiError && error.kind === "not_found") {
            this.context.forgetOwned(sandboxId);
          }
          throw error;
        }
        this.context.forgetOwned(sandboxId);
        return { sandboxId, deleted: true };
      }
      case "save_snapshot": {
        const sandboxId = this.owned(args);
        const name = snapshotName(args.name, "name");
        // What the operator is told. A key that cannot list snapshots still
        // asks, with less to say.
        const listed = await send({ method: "GET", path: ["saved-snapshots"] }).then(describeSnapshots, () => undefined);
        const replaces = listed?.snapshots.some((snapshot) => snapshot.name === name) === true;
        const answer = await confirm([
          `Save a named Boat snapshot "${name}" from sandbox ${sandboxId}?`,
          replaces ? `It replaces the snapshot already named "${name}".` : "",
          "It stays in your Boat account after this thread ends, until you delete it in Boat. PwrAgent never deletes it.",
          snapshotCostLine(listed?.allowance, replaces),
        ].filter(Boolean).join(" "));
        if (answer === "unavailable") {
          throw new Refusal(
            "Saving a named snapshot needs the operator's approval, and nobody can be asked from here. Ask the operator to save it with Boat's own tools, or go on without it: a stopped sandbox keeps its disk.",
          );
        }
        if (answer === "declined") {
          throw new Refusal("The operator declined to save that snapshot. Do not ask again unless they say to.");
        }
        const saved = await send({ method: "POST", path: ["saved-snapshots"], body: { sandboxId, name } });
        return {
          snapshot: describeSnapshot(saved.snapshot ?? { name }),
          status: typeof saved.status === "string" ? saved.status : "saving",
        };
      }
      case "get_snapshot": {
        const name = snapshotName(args.name, "name");
        const answer = await send({ method: "GET", path: ["saved-snapshots", name] });
        return { snapshot: describeSnapshot(answer.snapshot ?? answer) };
      }
      case "list_snapshots": {
        return describeSnapshots(await send({ method: "GET", path: ["saved-snapshots"] }));
      }
      case "account_status": {
        const [answer, snapshots] = await Promise.all([
          send({ method: "GET", path: ["limits"] }),
          // Extra, and needs an action an older key may lack.
          send({ method: "GET", path: ["saved-snapshots"] }).then(describeSnapshots, () => undefined),
        ]);
        return {
          ...pick(answer, ["canStart", "startBlockedReason", "activeSandboxes", "maxActiveSandboxes"]),
          ...(snapshots?.allowance ? { namedSnapshots: snapshots.allowance } : {}),
        };
      }
      default:
        throw new Refusal(`Boat has no tool named ${name.slice(0, 80)}.`);
    }
  }

  /** The id argument, when this session's thread holds that sandbox. */
  private owned(args: Args): string {
    const sandboxId = args.sandboxId;
    if (typeof sandboxId !== "string" || !SANDBOX_ID_PATTERN.test(sandboxId)) {
      throw new Refusal("sandboxId must be an id that create_sandbox returned.");
    }
    if (!this.context.ownedSandboxIds().has(sandboxId)) {
      throw new Refusal(
        "This thread did not create that sandbox, so it is out of reach. list_sandboxes shows the ones it did.",
      );
    }
    return sandboxId;
  }

  /**
   * Size, auto-stop and credentials for anything that starts a machine. A
   * value above a cap is sent only once the operator has approved this call.
   */
  private async startFields(args: Args, confirm: BoatConfirm, withDefaults = true): Promise<Record<string, unknown>> {
    const policy = this.context.policy();
    const fields: Record<string, unknown> = {};
    const asked: Asked = { over: [] };
    const type = this.sandboxType(args.type, withDefaults ? policy.defaultType : undefined, asked);
    if (type) fields.type = type;
    const ttlSeconds = this.ttlSeconds(args.ttlMinutes, false, withDefaults ? policy.defaultTtlMinutes : undefined, asked);
    if (ttlSeconds !== undefined) fields.ttlSeconds = ttlSeconds;
    if (policy.keepCredentialsOut) fields.noEnv = true;
    await this.approveOver(asked, confirm, "start a sandbox");
    return fields;
  }

  /**
   * One question for everything in a call that is above a cap. Approval
   * covers this call only: nothing is remembered for the next one.
   */
  private async approveOver(asked: Asked, confirm: BoatConfirm, purpose: string): Promise<void> {
    if (asked.over.length === 0) return;
    const answer = await confirm(
      `The agent asks Boat to ${purpose} above your limit: ${asked.over.map((entry) => entry.asks).join("; ")}. `
      + "Boat bills per second while a sandbox runs, and a larger size costs more. "
      + "Approving covers this one request; your limits in Settings → Plugins → Boat stay as they are.",
    );
    if (answer === "approved") return;
    throw new Refusal(answer === "declined"
      ? `The operator declined a request above their limit (${asked.over.map((entry) => entry.limit).join("; ")}). Stay within it.`
      : `${asked.over.map((entry) => entry.refusal).join(" ")} Nobody can be asked to approve more from here; the operator can raise the limit in Settings → Plugins → Boat.`);
  }

  private sandboxType(value: unknown, fallback: BoatSandboxType | undefined, asked: Asked): BoatSandboxType | undefined {
    if (value === undefined || value === null) return fallback;
    if (!isBoatSandboxType(value)) {
      throw new Refusal(`type must be one of ${BOAT_SANDBOX_TYPES.join(", ")}.`);
    }
    const max = this.context.policy().maxType;
    if (boatSandboxTypeRank(value) > boatSandboxTypeRank(max)) {
      asked.over.push({
        asks: `size ${value} (your limit is ${max})`,
        limit: `size up to ${max}`,
        refusal: `The operator allows sandboxes up to ${max}. Ask for ${max} or smaller.`,
      });
    }
    return value;
  }

  private ttlSeconds(
    value: unknown,
    required: boolean,
    fallbackMinutes: number | undefined,
    asked: Asked,
  ): number | undefined {
    if (value === undefined || value === null) {
      if (required) throw new Refusal("ttlMinutes is required.");
      return fallbackMinutes === undefined ? undefined : fallbackMinutes * 60;
    }
    const max = this.context.policy().maxTtlMinutes;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Refusal("ttlMinutes must be a whole number of minutes, 1 or more.");
    }
    if (value > TTL_CEILING_MINUTES) {
      throw new Refusal(`ttlMinutes can be at most ${TTL_CEILING_MINUTES} (one week).`);
    }
    if (value > max) {
      asked.over.push({
        asks: `auto-stop after ${value} minutes (your limit is ${max})`,
        limit: `auto-stop within ${max} minutes`,
        refusal: `The operator allows auto-stop up to ${max} minutes. Ask for ${max} or fewer.`,
      });
    }
    return value * 60;
  }

  /**
   * Records a new sandbox against the thread before the agent hears of it.
   * A sandbox that could not be recorded is out of every tool's reach, PR
   * cleanup included, so it is deleted at once instead of left to bill.
   */
  private async adopt(
    sandbox: unknown,
    send: (request: Omit<BoatApiRequest, "signal">) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const described = describeSandbox(sandbox);
    const sandboxId = described.id;
    if (typeof sandboxId !== "string" || !SANDBOX_ID_PATTERN.test(sandboxId)) {
      throw new Refusal("Boat started a sandbox but returned no usable id. Check the Boat dashboard.");
    }
    this.context.recordOwned({
      sandboxId,
      ...(typeof described.name === "string" && described.name ? { name: described.name.slice(0, 200) } : {}),
    });
    if (!this.context.ownedSandboxIds().has(sandboxId)) {
      const deleted = await send({
        method: "DELETE", path: ["sandboxes", sandboxId],
        headers: { "x-ascii-confirm-delete": sandboxId },
      }).then(() => true, () => false);
      throw new Refusal(deleted
        ? "PwrAgent could not record the new sandbox for this thread, so it deleted it. Nothing is running."
        : `PwrAgent could not record or delete the new sandbox ${sandboxId}. Tell the operator to delete it in the Boat dashboard.`);
    }
    return described;
  }

  /**
   * The source once Boat has finished saving it. While a stopped sandbox is
   * `stopping` or `archiving`, Boat already reports a snapshot and a fork
   * succeeds, but from the snapshot before the one being written: the fork
   * silently lacks the latest work. Waits a bounded time, then refuses.
   */
  private async saved(
    sandboxId: string,
    send: (request: Omit<BoatApiRequest, "signal">) => Promise<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const sleep = this.context.sleep ?? (async (ms: number, aborted?: AbortSignal) => {
      await delay(ms, undefined, aborted ? { signal: aborted } : undefined);
    });
    for (let waited = 0; ; waited += SAVING_POLL_MS) {
      const source = describeSandbox((await send({ method: "GET", path: ["sandboxes", sandboxId] })).sandbox);
      const state = typeof source.state === "string" ? source.state : "";
      if (!SAVING_STATES.has(state)) return source;
      if (waited >= SAVING_WAIT_MS) {
        throw new Refusal(
          `Sandbox ${sandboxId} is still saving its snapshot (state ${state}). A fork now would copy an older snapshot. `
          + "Wait until get_sandbox reports it archived, then fork again.",
        );
      }
      await sleep(SAVING_POLL_MS, signal);
    }
  }

  private idempotencyKey(): string {
    return (this.context.idempotencyKey ?? randomUUID)();
  }
}

/** A sandbox without who owns the account: no creator, team or address. */
function describeSandbox(sandbox: unknown): Record<string, unknown> {
  if (!sandbox || typeof sandbox !== "object") return {};
  const described = pick(sandbox as Record<string, unknown>, [
    "id", "name", "state", "error", "type", "vcpu", "memoryGB", "health",
    "createdAt", "stoppedAt", "archiveAfter", "ttlSeconds", "snapshotAvailable",
  ]);
  const cost = (sandbox as { cost?: unknown }).cost;
  if (cost && typeof cost === "object") {
    described.cost = pick(cost as Record<string, unknown>, ["since", "seconds", "dollars"]);
  }
  return described;
}

function snapshotName(value: unknown, argument: string): string {
  if (typeof value !== "string" || !SNAPSHOT_NAME_PATTERN.test(value) || RESERVED_SNAPSHOT_NAMES.has(value)) {
    throw new Refusal(
      `${argument} must be a snapshot name: lowercase letters, digits and hyphens, at most 63 characters, and not a reserved word. A share code is not accepted.`,
    );
  }
  return value;
}

/** A named snapshot without which sandbox or organization it came from. */
function describeSnapshot(snapshot: unknown): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== "object") return {};
  return pick(snapshot as Record<string, unknown>, ["name", "status", "error", "type", "sizeBytes", "createdAt"]);
}

type SnapshotAllowance = { included?: number; used?: number; pricePerExtraDailyDollars?: number };

function describeSnapshots(answer: Record<string, unknown>): {
  snapshots: Array<Record<string, unknown>>;
  allowance?: SnapshotAllowance;
} {
  const snapshots = Array.isArray(answer.snapshots)
    ? answer.snapshots.slice(0, SNAPSHOT_LIST_LIMIT).map(describeSnapshot)
    : [];
  const raw = answer.allowance;
  if (!raw || typeof raw !== "object") return { snapshots };
  const allowance: SnapshotAllowance = {};
  for (const key of ["included", "used", "pricePerExtraDailyDollars"] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) allowance[key] = value;
  }
  return { snapshots, allowance };
}

/** What saving one more costs, as far as Boat has said. */
function snapshotCostLine(allowance: SnapshotAllowance | undefined, replaces: boolean): string {
  const price = allowance?.pricePerExtraDailyDollars;
  const each = price === undefined ? "a daily fee" : `$${price} a day`;
  if (allowance?.included === undefined || allowance.used === undefined) {
    return `Boat charges ${each} for each named snapshot beyond the number your plan includes.`;
  }
  const counted = `Your plan includes ${allowance.included} and ${allowance.used} ${allowance.used === 1 ? "is" : "are"} in use.`;
  if (replaces) return `${counted} Replacing one does not add to that.`;
  return allowance.used >= allowance.included
    ? `${counted} This one is over that number, so Boat charges ${each} for it.`
    : `${counted} This one is within it, so it adds no charge.`;
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

function requiredString(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || !value) throw new Refusal(`${name} must be a non-empty string.`);
  if (value.length > limit) throw new Refusal(`${name} is too long.`);
  return value;
}

function optionalString(value: unknown, name: string, limit: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, name, limit);
}

function requiredInteger(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Refusal(`${name} must be a whole number${max === Number.MAX_SAFE_INTEGER ? "" : ` from ${min} to ${max}`}.`);
  }
  return value;
}

function optionalInteger(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredInteger(value, name, min, max);
}

function readEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Refusal("env must be an object of strings.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  if (entries.length > ENV_LIMIT) throw new Refusal(`env holds at most ${ENV_LIMIT} variables.`);
  let bytes = 0;
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, entry] of entries) {
    if (!ENV_NAME_PATTERN.test(name) || typeof entry !== "string") {
      throw new Refusal("env must map variable names to strings.");
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(entry);
    env[name] = entry;
  }
  if (bytes > ENV_BYTES_LIMIT) throw new Refusal("env is over 64 KB.");
  return env;
}
