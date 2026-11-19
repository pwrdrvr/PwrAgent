import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { resolveBackendErrorNotice, type BackendErrorSignal } from "../backend-error-notice";

const expiredLogin = "Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs";

it("offers Claude sign-in exactly when Claude rejects a login on this machine", () => {
  fc.assert(fc.property(
    fc.constantFrom("claude", "codex", "acp:grok"),
    fc.option(fc.uuid(), { nil: undefined }),
    fc.boolean(),
    (backend, instanceId, expired) => {
      const onClaudeLogin = vi.fn();
      const signal = {
        kind: "turn-failed", backend, instanceId, onClaudeLogin,
        threadId: "thread", turnId: "turn", threadLabel: "Fixture thread",
        errorMessage: expired ? expiredLogin : "Connection timed out",
      } satisfies BackendErrorSignal;
      const notice = resolveBackendErrorNotice(signal, undefined);
      const signIn = notice?.actions?.find(({ label }) => label === "Sign in to Claude");
      if (backend === "claude" && !instanceId && expired) {
        expect(signIn).toBeDefined();
        signIn?.onClick();
        expect(onClaudeLogin).toHaveBeenCalledOnce();
      } else {
        expect(signIn).toBeUndefined();
      }
      expect(notice?.copyText).toBe(signal.errorMessage);
    },
  ));
});
