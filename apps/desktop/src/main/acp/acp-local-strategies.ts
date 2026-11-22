import os from "node:os";
import path from "node:path";
import {
  BUILT_IN_ACP_STRATEGIES,
  type AcpAgentStrategy,
} from "@pwrdrvr/agent-acp/strategies";

const antigravity: AcpAgentStrategy = {
  id: "antigravity",
  backendId: "acp:antigravity",
  displayName: "Antigravity CLI",
  authors: ["Google LLC"],
  repositoryUrl: "https://github.com/google-antigravity/antigravity-cli",
  discoveryProbe: {
    command: "agy",
    versionArgs: ["--version"],
    helpArgs: ["acp", "--help"],
    // Earlier versions and unrelated executables can exit successfully after
    // printing global help. Require the ACP subcommand's own usage line.
    helpMatches: /^Usage: (?:agy|antigravity)(?:\.exe)? acp \[flags\]$/m,
    fallbackCommands: [
      path.join(os.homedir(), ".local", "bin", "agy"),
      "/opt/homebrew/bin/agy",
      "/usr/local/bin/agy",
    ],
  },
  spawn: {
    command: "agy",
    // Google's ACP server requires a session worker for HTTP MCP servers
    // supplied by the client. Permissions still use ACP requestPermission.
    args: ["acp", "--process-per-session"],
  },
  quirks: { surfaceThoughts: true, titleFrom: "topic-update" },
};

export const ACP_LOCAL_AGENT_STRATEGIES: readonly AcpAgentStrategy[] = [
  ...BUILT_IN_ACP_STRATEGIES,
  antigravity,
];
