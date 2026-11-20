import { randomUUID } from "node:crypto";
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
 * - Size and auto-stop never exceed the operator's caps. A larger request is
 *   refused, not clamped, so the agent knows what it did not get.
 * - Every sandbox id must be one this thread created or forked. PwrAgent's
 *   own cleanup session may only stop and delete, and only such ids.
 * - No result or error contains anything shaped like a Boat API key.
 */

export const BOAT_SERVER_INSTRUCTIONS = [
  "Boat sandboxes are cloud Ubuntu VMs that bill the operator per second while they run.",
  "Create one with create_sandbox, wait until get_sandbox reports state ready, then use exec and the file tools.",
  "A command that may take longer than 30 seconds needs timeoutSeconds (up to 600) or detached: true with command_status to poll.",
  "Sandboxes start with none of the operator's credentials: no GitHub token, model keys or secrets. Write files in with write_file.",
  "host_port returns a private URL that works only with its token. Ports cannot be made public from here.",
  "Only sandboxes this thread created are reachable. Call stop_sandbox or delete_sandbox when you are done; auto-stop is a backstop, not a spending cap.",
].join(" ");

export type BoatToolRole = "thread" | "cleanup" | "none";

export type BoatOwnedSandbox = { sandboxId: string; name?: string };

export type BoatToolsContext = {
  api: Pick<BoatApi, "request">;
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
};

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
const CLEANUP_TOOLS: ReadonlySet<string> = new Set(["stop_sandbox", "delete_sandbox"]);

const sandboxIdProperty = { type: "string", description: "A sandbox this thread created, as create_sandbox returned it." } as const;
const typeProperty = { type: "string", enum: [...BOAT_SANDBOX_TYPES], description: "Machine size. Omit for the operator's default." } as const;
const ttlProperty = { type: "integer", minimum: 1, description: "Minutes until auto-stop. Omit for the operator's default." } as const;

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
  tool("create_sandbox", "Create a cloud Ubuntu VM. Billing starts now and runs until it stops. Returns its id; poll get_sandbox until state is ready.", {
    name: { type: "string", maxLength: NAME_LIMIT },
    type: typeProperty,
    ttlMinutes: ttlProperty,
    env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables for this sandbox only." },
    setupScript: { type: "string", description: "A script run once in the background after boot." },
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
  tool("fork_sandbox", "Create a new sandbox from another's latest snapshot. Billing starts for the new one.", {
    sandboxId: sandboxIdProperty,
    type: typeProperty,
    ttlMinutes: ttlProperty,
  }, ["sandboxId"]),
  tool("delete_sandbox", "Permanently delete a sandbox and all of its data.", { sandboxId: sandboxIdProperty }, ["sandboxId"], { destructive: true }),
  tool("account_status", "Whether Boat can start a sandbox for this account now, and how many are running.", {}, [], { readOnly: true }),
];

class Refusal extends Error {}

type Args = Record<string, unknown>;

export class BoatTools {
  constructor(private readonly context: BoatToolsContext) {}

  list(): readonly Tool[] {
    return BOAT_TOOLS;
  }

  /** Never throws: a refusal or a Boat failure is an error result. */
  async call(name: string, args: Args | undefined, signal?: AbortSignal): Promise<CallToolResult> {
    try {
      const result = await this.dispatch(name, args ?? {}, signal);
      const text = redactBoatApiKeys(JSON.stringify(result));
      return {
        content: [{ type: "text", text }],
        structuredContent: JSON.parse(text) as Record<string, unknown>,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Refusal || error instanceof BoatApiError
        ? error.message
        : "PwrAgent's Boat server failed while handling this call.";
      return { isError: true, content: [{ type: "text", text: redactBoatApiKeys(message) }] };
    }
  }

  private async dispatch(name: string, args: Args, signal?: AbortSignal): Promise<Record<string, unknown>> {
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
        const body: Record<string, unknown> = { ...this.startFields(args) };
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
        return { sandbox: this.adopt(answer.sandbox) };
      }
      case "list_sandboxes": {
        const ids = [...this.context.ownedSandboxIds()].slice(0, LIST_LIMIT);
        const sandboxes: unknown[] = [];
        for (const sandboxId of ids) {
          try {
            sandboxes.push(describeSandbox((await send({ method: "GET", path: ["sandboxes", sandboxId] })).sandbox));
          } catch (error) {
            if (!(error instanceof BoatApiError) || error.kind !== "not_found") throw error;
            this.context.forgetOwned(sandboxId);
          }
        }
        return { sandboxes };
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
      case "extend_sandbox": {
        const sandboxId = this.owned(args);
        const ttlSeconds = this.ttlSeconds(args.ttlMinutes, true);
        const answer = await send({ method: "PATCH", path: ["sandboxes", sandboxId], body: { ttlSeconds } });
        return { sandbox: describeSandbox(answer.sandbox) };
      }
      case "stop_sandbox": {
        const sandboxId = this.owned(args);
        const answer = await send({ method: "POST", path: ["sandboxes", sandboxId, "stop"], body: {} });
        return { sandboxId, status: typeof answer.status === "string" ? answer.status : "stopping" };
      }
      case "resume_sandbox": {
        const sandboxId = this.owned(args);
        const answer = await send({
          method: "POST", path: ["sandboxes", sandboxId, "resume"],
          body: this.startFields(args, false),
        });
        return { sandboxId, status: typeof answer.status === "string" ? answer.status : "resuming" };
      }
      case "fork_sandbox": {
        const sandboxId = this.owned(args);
        const answer = await send({
          method: "POST", path: ["sandboxes", sandboxId, "fork"],
          body: this.startFields(args, false),
          headers: { "idempotency-key": this.idempotencyKey() },
        });
        const forked = answer.sandbox && typeof answer.sandbox === "object"
          ? answer.sandbox
          : { id: answer.id };
        return { sandbox: this.adopt(forked) };
      }
      case "delete_sandbox": {
        const sandboxId = this.owned(args);
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
      case "account_status": {
        const answer = await send({ method: "GET", path: ["limits"] });
        return pick(answer, ["canStart", "startBlockedReason", "activeSandboxes", "maxActiveSandboxes"]);
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

  /** Size, auto-stop and credentials for anything that starts a machine. */
  private startFields(args: Args, withDefaults = true): Record<string, unknown> {
    const policy = this.context.policy();
    const fields: Record<string, unknown> = {};
    const type = this.sandboxType(args.type, withDefaults ? policy.defaultType : undefined);
    if (type) fields.type = type;
    const ttlSeconds = this.ttlSeconds(args.ttlMinutes, false, withDefaults ? policy.defaultTtlMinutes : undefined);
    if (ttlSeconds !== undefined) fields.ttlSeconds = ttlSeconds;
    if (policy.keepCredentialsOut) fields.noEnv = true;
    return fields;
  }

  private sandboxType(value: unknown, fallback?: BoatSandboxType): BoatSandboxType | undefined {
    if (value === undefined || value === null) return fallback;
    if (!isBoatSandboxType(value)) {
      throw new Refusal(`type must be one of ${BOAT_SANDBOX_TYPES.join(", ")}.`);
    }
    const max = this.context.policy().maxType;
    if (boatSandboxTypeRank(value) > boatSandboxTypeRank(max)) {
      throw new Refusal(
        `The operator allows sandboxes up to ${max}. Ask for ${max} or smaller, or ask the operator to raise the limit in Settings → Plugins → Boat.`,
      );
    }
    return value;
  }

  private ttlSeconds(value: unknown, required: boolean, fallbackMinutes?: number): number | undefined {
    if (value === undefined || value === null) {
      if (required) throw new Refusal("ttlMinutes is required.");
      return fallbackMinutes === undefined ? undefined : fallbackMinutes * 60;
    }
    const max = this.context.policy().maxTtlMinutes;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Refusal("ttlMinutes must be a whole number of minutes, 1 or more.");
    }
    if (value > max) {
      throw new Refusal(
        `The operator allows auto-stop up to ${max} minutes. Ask for ${max} or fewer, or ask the operator to raise the limit in Settings → Plugins → Boat.`,
      );
    }
    return value * 60;
  }

  /** Records a new sandbox against the thread before the agent hears of it. */
  private adopt(sandbox: unknown): Record<string, unknown> {
    const described = describeSandbox(sandbox);
    const sandboxId = described.id;
    if (typeof sandboxId !== "string" || !SANDBOX_ID_PATTERN.test(sandboxId)) {
      throw new Refusal("Boat started a sandbox but returned no usable id. Check the Boat dashboard.");
    }
    this.context.recordOwned({
      sandboxId,
      ...(typeof described.name === "string" && described.name ? { name: described.name.slice(0, 200) } : {}),
    });
    return described;
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
