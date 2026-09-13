import path from "node:path";

export const CODEX_SIGN_IN_REQUIRED =
  "Codex is logged out. Please sign in again to resume operations.";

export { isCodexAuthenticationFailure } from "@pwragent/shared";

/** Runtime evidence overrides credential-file discovery. No timer or SQLite writes. */
export class CodexAuthState {
  private readonly blocked = new Set<string>();
  private readonly listeners = new Set<(home: string) => void>();

  isBlocked(home: string): boolean {
    return this.blocked.has(path.resolve(home));
  }

  assertAvailable(home: string): void {
    if (this.isBlocked(home)) throw new Error(CODEX_SIGN_IN_REQUIRED);
  }

  reject(home: string): void {
    const key = path.resolve(home);
    if (this.blocked.has(key)) return;
    this.blocked.add(key);
    for (const listener of this.listeners) listener(key);
  }

  verified(home: string): void {
    const key = path.resolve(home);
    if (!this.blocked.delete(key)) return;
    for (const listener of this.listeners) listener(key);
  }

  subscribe(listener: (home: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export const codexAuthState = new CodexAuthState();
