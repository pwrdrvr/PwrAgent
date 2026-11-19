/** Claude Code's CLI diagnostics that ask the operator to sign in again. */
export function isClaudeAuthenticationFailure(message: string): boolean {
  const text = message.trim();
  return /^failed to authenticate:\s*this login reached its time limit and cannot be renewed\b/i.test(text)
    || /^(?:Claude Code sign-in required\b|(?:please )?(?:run|sign in with) `?claude auth login\b)/i.test(text);
}
