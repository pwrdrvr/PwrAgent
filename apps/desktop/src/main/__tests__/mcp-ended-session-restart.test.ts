import type { McpConnectionKind } from "@pwragent/shared/contracts/mcp-connections";
import { describe, expect, it, vi } from "vitest";
import { endedLocalSessionRestart } from "../mcp-connections/mcp-connection-gateway-service";

const RELAY_KINDS = ["pwrsnap", "pwrgit"] as const;
const KINDS: McpConnectionKind[] = ["remote", ...RELAY_KINDS, "sandboxer", "stdio"];
const REFERENCE_OPERATION = "tools/call";
// Every request a bridge can send for a grant, plus shapes it never sends.
const OTHER_OPERATIONS: unknown[] = [
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
 * Oracle, written from the rule rather than the code. Every thread shares one
 * pool of PwrSnap or PwrGit sessions, so once the app is back any thread's
 * own request reopens it: a new thread's discovery has to work after an
 * update. It reopens only when all of these hold: the session is a PwrSnap
 * or PwrGit relay (an operator's command that exited may exit again on every
 * start), the request is not a delegated Job Monitor's (an app that predates
 * prompt-free relays still asks, and nobody is watching), and the app answers.
 */
function expected(kind: McpConnectionKind, delegated: boolean, listening: boolean) {
  const relay = kind === "pwrsnap" || kind === "pwrgit";
  if (!relay || delegated) return { outcome: "ended", probes: 0 };
  return { outcome: listening ? "restart" : "app_closed", probes: 1 };
}

describe("reopening an ended local session", () => {
  // Delegated requests can only reach this decision through the gateway.
  const kindCases = KINDS.flatMap((kind) => [false, true].flatMap((delegated) =>
    [false, true].map((listening) => ({
      kind, operation: delegated ? "gateway/tools/call" : REFERENCE_OPERATION, delegated, listening,
    }))));
  // Discovery must also leave an ended relay alone even when the app is up.
  const delegatedListCases = RELAY_KINDS.map((kind) =>
    ({ kind, operation: "gateway/tools/list", delegated: true, listening: true }));
  // An eligible relay reopens for any operation. Check the other request
  // shapes here, where an operation filter would incorrectly block a restart.
  const operationCases = RELAY_KINDS.flatMap((kind) => OTHER_OPERATIONS.map((operation) =>
    ({ kind, operation, delegated: false, listening: true })));

  it.each([...kindCases, ...delegatedListCases, ...operationCases])(
    "$kind $operation (delegated $delegated, app listening $listening)",
    async ({ kind, operation, delegated, listening }) => {
      const isAppListening = vi.fn(async () => listening);
      const outcome = await endedLocalSessionRestart({ kind, operation, delegated, isAppListening });
      const want = expected(kind, delegated, listening);
      expect(outcome).toBe(want.outcome);
      // The probe opens a connection to the app, so only a restartable
      // request may make it.
      expect(isAppListening).toHaveBeenCalledTimes(want.probes);
    },
  );
});
