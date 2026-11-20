import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { resolveBackendErrorNotice, type BackendErrorSignal } from "../backend-error-notice";

const expiredLogin = "Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs";

it("offers Claude sign-in only for a local recovery scoped by the Claude backend", () => {
  fc.assert(fc.property(
    fc.constantFrom("claude", "codex", "acp:grok"),
    fc.option(fc.uuid(), { nil: undefined }),
    fc.boolean(),
    fc.boolean(),
    (backend, instanceId, expired, defaultAccount) => {
      const onClaudeLogin = vi.fn();
      const signal = {
        kind: "turn-failed", backend, instanceId, onClaudeLogin,
        threadId: "thread", turnId: "turn", threadLabel: "Fixture thread",
        errorMessage: expired ? expiredLogin : "Connection timed out",
        recovery: expired && defaultAccount ? "claudeSignIn" : undefined,
      } satisfies BackendErrorSignal;
      const notice = resolveBackendErrorNotice(signal, undefined);
      const signIn = notice?.actions?.find(({ label }) => label === "Sign in to Claude");
      if (backend === "claude" && !instanceId && expired && defaultAccount) {
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

const hardwareKeyMessage =
  "You’re approved for Daybreak Blue, but this response cannot be shown as this session"
  + " was not authenticated with one of your authorized hardware keys. Please"
  + " re-authenticate with your hardware key and try your request again.";

it("offers a fresh Codex sign-in beside the provider's hardware-key instruction only on the owner", () => {
  fc.assert(fc.property(
    fc.constantFrom("codex", "claude", "acp:grok"),
    fc.option(fc.uuid(), { nil: undefined }),
    fc.constantFrom(undefined, "codexHardwareKeySignIn", "claudeSignIn"),
    fc.boolean(),
    (backend, instanceId, recovery, callback) => {
      const onCodexReauthenticate = callback ? vi.fn() : undefined;
      const onCodexLogin = vi.fn();
      const signal = {
        kind: "turn-failed", backend, instanceId, onCodexLogin, onCodexReauthenticate,
        threadId: "thread", turnId: "turn", threadLabel: "Fixture thread",
        errorMessage: hardwareKeyMessage,
        recovery,
      } satisfies BackendErrorSignal;
      const notice = resolveBackendErrorNotice(signal, undefined);
      const tagged = backend === "codex" && recovery === "codexHardwareKeySignIn";
      const signIn = notice?.actions?.find(({ label }) => label === "Sign in again");
      if (tagged && !instanceId && callback) {
        expect(signIn).toBeDefined();
        signIn?.onClick();
        expect(onCodexReauthenticate).toHaveBeenCalledOnce();
      } else {
        expect(signIn).toBeUndefined();
      }
      // Not the logged-out Login: the account is signed in.
      expect(notice?.actions?.some(({ label }) => label === "Login")).not.toBe(true);
      // The provider's instruction is the message, unedited.
      expect(notice?.message).toBe(hardwareKeyMessage);
      expect(notice?.title).toBe(tagged ? "Codex sign-in required" : "Turn failed");
    },
  ));
});
