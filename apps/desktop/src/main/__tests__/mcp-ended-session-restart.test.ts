import type { McpConnectionKind } from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import { endedLocalSessionRestart } from "../mcp-connections/mcp-connection-gateway-service";

const KINDS: McpConnectionKind[] = ["remote", "pwrsnap", "pwrgit", "sandboxer", "stdio"];
// Every request a bridge can send for a grant, plus shapes it never sends.
const OPERATIONS: unknown[] = [
  "tools/call",
  "gateway/tools/call",
  "tools/list",
  "gateway/tools/list",
  "resources/list",
  "resources/read",
  "resources/subscribe",
  "prompts/list",
  "describe",
  undefined,
  "TOOLS/CALL",
];

/**
 * Oracle, written from the rule rather than the code. Restarting a relay
 * opens its app's approval window, so it may happen only when all of these
 * hold: the session is a PwrSnap or PwrGit relay (an operator's command that
 * exited may exit again on every start), the request is the thread's own
 * tool call (nothing else may raise a window), and the app answers.
 */
function expected(kind: McpConnectionKind, operation: unknown, delegated: boolean, listening: boolean) {
  const relay = kind === "pwrsnap" || kind === "pwrgit";
  const ownToolCall = !delegated && (operation === "tools/call" || operation === "gateway/tools/call");
  if (!relay || !ownToolCall) return { outcome: "ended", probes: 0 };
  return { outcome: listening ? "restart" : "app_closed", probes: 1 };
}

describe("restarting a thread's ended local session", () => {
  const cases = KINDS.flatMap((kind) => OPERATIONS.flatMap((operation) =>
    [false, true].flatMap((delegated) => [false, true].map((listening) => ({ kind, operation, delegated, listening })))));

  it.each(cases)(
    "$kind $operation (delegated $delegated, app listening $listening)",
    async ({ kind, operation, delegated, listening }) => {
      const isAppListening = vi.fn(async () => listening);
      const outcome = await endedLocalSessionRestart({ kind, operation, delegated, isAppListening });
      const want = expected(kind, operation, delegated, listening);
      expect(outcome).toBe(want.outcome);
      // The probe opens a connection to the app, so only a restartable
      // request may make it.
      expect(isAppListening).toHaveBeenCalledTimes(want.probes);
    },
  );
});
