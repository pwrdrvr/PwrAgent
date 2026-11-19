import { useCallback, useRef, useState } from "react";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export type ClaudeSignInControls = { onSignIn?: () => void; signingIn: boolean };

export function useClaudeSignIn(
  signIn: (() => Promise<void>) | undefined,
  openSettings: () => void,
) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<AppNoticeToastNotice>();
  const running = useRef(false);
  const dismissNotice = useCallback(() => setNotice(undefined), []);
  const start = useCallback(() => {
    if (!signIn || running.current) return;
    running.current = true;
    setPending(true);
    const id = "claude-sign-in";
    const actions = [{ label: "Open Claude settings", onClick: openSettings }];
    setNotice({
      id, title: "Claude Code sign-in", message: "Finish signing in through your browser.",
      tone: "neutral", autoDismiss: false, actions,
    });
    void signIn().then(
      () => setNotice({ id, title: "Signed in to Claude", message: "", tone: "success" }),
      () => setNotice({
        id, title: "Claude Code sign-in did not finish",
        message: "Try again or run the sign-in command from Claude settings in your terminal.",
        tone: "error", autoDismiss: false, actions,
      }),
    ).finally(() => {
      running.current = false;
      setPending(false);
    });
  }, [signIn, openSettings]);

  const controls: ClaudeSignInControls = { onSignIn: signIn ? start : undefined, signingIn: pending };
  return { controls, notice, dismissNotice };
}
