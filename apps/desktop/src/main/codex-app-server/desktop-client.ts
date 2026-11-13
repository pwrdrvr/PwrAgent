import { getOwnerHostServices } from "../owner-host";
import {
  CodexAppServerClient as OwnerCodexAppServerClient,
  type CodexClientOptions,
} from "@pwragent/owner-core/codex-app-server/client";
import { listingDiagnostics } from "../diagnostics/listing-diagnostics";
import { prependBundledToolsToPath } from "../bundled-tools";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { CODEX_SIGN_IN_REQUIRED, codexAuthState } from "../codex-auth-state";
import { getMainLogger } from "../log";
import { enrichThreadDirectory } from "../app-server/thread-directory-enricher";
import { collectDescendants, countOpenFileDescriptors, readProcessTable } from "../process-descendants";
import { StdioJsonRpcTransport, type StdioJsonRpcTransportOptions } from "./stdio-transport";
import { createOutpostCodexMessageRewriter } from "../headless/outpost-codex-sandbox";
import { createOutpostAgentToolMessageRewriter } from "../headless/outpost-agent-tools";
import { localAgentToolAllowlist } from "../member-containment";
import { isCodexInvalidResponseMessageIdError, repairCodexInvalidResponseMessageIds } from "./invalid-response-message-id-recovery";

export * from "@pwragent/owner-core/codex-app-server/client";

type DesktopCodexClientOptions = CodexClientOptions & Partial<Pick<StdioJsonRpcTransportOptions,
  "command" | "args" | "resolveArgs" | "resolveCommand"
>>;

/** Desktop owns process launch, profile state, diagnostics, and rollout repair. */
export class CodexAppServerClient extends OwnerCodexAppServerClient {
  constructor(options: DesktopCodexClientOptions = {}) {
    const runtimePolicy = getOwnerHostServices().runtimePolicy;
    super({ ...options, ...(runtimePolicy ? { helperExecutionPolicy: { approvalPolicy: "never" as const, sandbox: "read-only" as const } } : {}) }, {
      createTransport: (callbacks) => {
        const transport = new StdioJsonRpcTransport({
          ...options,
          command: options.command?.trim() || "codex",
          args: options.args ?? [],
          ...callbacks,
        });
        // Every outbound request is the one place no path can skip: on an
        // Outpost a legacy sandbox would let model commands read its state,
        // and on a contained member of either kind an unlisted agent tool
        // runs in the owner, outside the sandbox. Containment is read per
        // message, so a desktop that changes it needs no new client.
        const sandbox = runtimePolicy
          ? createOutpostCodexMessageRewriter(runtimePolicy.codexProtectedRoots, {
            readOnlyRoots: runtimePolicy.codexReadOnlyRoots,
            allowFullAccess: runtimePolicy.executionModes.includes("full-access"),
          })
          : (message: string) => message;
        const agentTools = createOutpostAgentToolMessageRewriter(localAgentToolAllowlist);
        // The class's own send, looked up per message, so the rewrite stays
        // the only layer this adds.
        transport.send = (message) => StdioJsonRpcTransport.prototype.send.call(transport, agentTools(sandbox(message)));
        return transport;
      },
      clientInfo: { name: "pwragent-desktop", title: "PwrAgent" },
      logger: getMainLogger("pwragent:codex-client"),
      rpcLogger: getMainLogger("pwragent:json-rpc"),
      listingDiagnostics,
      authState: codexAuthState,
      signInRequiredMessage: CODEX_SIGN_IN_REQUIRED,
      buildShellEnvironment: (env, directory) => prependBundledToolsToPath(
        buildPwrAgentChildProcessEnv(env), directory ? { directory } : {},
      ),
      enrichThreadDirectory,
      sampleAppServerProcessTree: async (process) => {
        const [table, openFdCount] = await Promise.all([
          readProcessTable().catch(() => undefined),
          countOpenFileDescriptors(process.pid),
        ]);
        return {
          ...(table ? { childProcessCount: collectDescendants(table, process.pid).length } : {}),
          ...(openFdCount !== undefined ? { openFdCount } : {}),
        };
      },
      invalidResponseMessageIdRecovery: {
        isFailure: isCodexInvalidResponseMessageIdError,
        repair: repairCodexInvalidResponseMessageIds,
      },
    });
  }
}
