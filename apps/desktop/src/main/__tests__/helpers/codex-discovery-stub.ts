// Shared `@pwrdrvr/codex-discovery` stub for tests that build a real
// `DesktopSettingsService` without injecting a `codexDiscoveryCoordinator`.
//
// The service constructs a real `CodexDiscoveryCoordinator` in that case, whose
// probe runs `codex --version` against every install location on the machine
// running the suite (ChatGPT.app ships one). That is both a process storm and a
// host-dependent result. Use this from a test file's `vi.mock` factory:
//
//   vi.mock("@pwrdrvr/codex-discovery", async (importOriginal) => {
//     const { stubbedCodexDiscovery } = await import(
//       "./helpers/codex-discovery-stub"
//     );
//     return stubbedCodexDiscovery(await importOriginal());
//   });
//
// Tests that assert on discovery inject their own coordinator and are
// unaffected by this stub.
//
// Every import below MUST stay `import type`. A runtime import of
// `@pwrdrvr/codex-discovery` here deadlocks: the `vi.mock` factory awaits this
// module, which would re-enter the factory for the module it is mocking. Read
// runtime values off the `actual` module passed in instead.
import type {
  CodexCandidateSource,
  CodexDiscoverySnapshot,
} from "@pwrdrvr/codex-discovery";

type CodexDiscoveryModule = {
  CODEX_COMMAND_ENV: string;
};

/**
 * Reproduces what real discovery returns on a machine with no Codex CLI: no
 * selection, and one non-executable candidate per explicitly requested command.
 *
 * The `env` / `config` candidates matter — real `discoverCodexCommands` keeps a
 * fixed candidate for a command the caller named even when it is not
 * executable, and only drops the auto-discovered ones. A stub that always
 * returned `[]` would answer differently from CI for exactly the tests that
 * write `models.codex.path`.
 */
export function stubbedCodexDiscovery<Actual extends CodexDiscoveryModule>(
  actual: Actual,
): Actual {
  return {
    ...actual,
    discoverCodexCommands: async (params?: {
      configuredCommand?: string | undefined;
      env?: NodeJS.ProcessEnv | undefined;
    }): Promise<CodexDiscoverySnapshot> => ({
      candidates: [
        fixedCandidate(params?.env?.[actual.CODEX_COMMAND_ENV], "env"),
        fixedCandidate(params?.configuredCommand, "config"),
      ].filter((candidate) => candidate !== undefined),
    }),
  };
}

function fixedCandidate(
  command: string | undefined,
  source: CodexCandidateSource,
):
  | {
      command: string;
      executable: boolean;
      selected: boolean;
      source: CodexCandidateSource;
    }
  | undefined {
  const trimmed = command?.trim();
  return trimmed
    ? { command: trimmed, executable: false, selected: false, source }
    : undefined;
}
