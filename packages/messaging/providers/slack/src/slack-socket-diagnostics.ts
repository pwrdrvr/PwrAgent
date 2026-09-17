import { LogLevel, type Logger } from "@slack/socket-mode";
import type { SlackProviderLogger } from "./slack-adapter";

/** Observe the SDK without changing its retry or connection ownership. */
export class SlackSocketDiagnostics {
  private connected = false;
  private hasConnected = false;
  private startedAt: number | undefined;
  private attempts = 0;
  private failures = 0;

  constructor(
    private readonly logger: SlackProviderLogger,
    private readonly secrets: readonly string[],
    private readonly now: () => number = Date.now,
  ) {}

  readonly sdkLogger: Logger = {
    // SDK debug output can contain inbound messages and connection URLs. Only
    // forward the retry delay, which is not exposed by a lifecycle event.
    debug: (...messages: unknown[]) => {
      const match = typeof messages[0] === "string"
        ? /^Before trying to reconnect, this client will wait for (\d+) milliseconds$/.exec(messages[0])
        : null;
      if (match) {
        this.beginAttempt();
        this.logger.info?.("Slack socket retry scheduled", {
          ...this.context(),
          retryDelayMs: Number(match[1]),
        });
      }
    },
    info: () => {},
    warn: (...messages: unknown[]) => {
      if (messages[0] === "Peer did not complete the close handshake in time; forcing cleanup.") {
        this.logger.warn?.("Slack socket close handshake timed out; cleaning up a closing socket", {
          currentConnectionHealthy: this.connected,
          cleanupTimeoutMs: 25_000,
        });
        return;
      }
      this.logSdk("warn", messages);
    },
    error: (...messages: unknown[]) => {
      // These SDK strings discard the cause. The error event below retains it.
      if (typeof messages[0] === "string"
        && /^(WebSocket error occurred:|WebSocket error!)/.test(messages[0])) return;
      this.logSdk("error", messages);
    },
    setLevel: () => {},
    getLevel: () => LogLevel.DEBUG,
    setName: () => {},
  };

  attach(client: { on(event: string, listener: (error?: unknown) => void): unknown }): void {
    client.on("connecting", () => {
      this.beginAttempt();
      this.attempts += 1;
      this.logger.info?.("Slack socket connecting", this.context());
    });
    client.on("reconnecting", () => this.beginAttempt());
    client.on("error", (error) => {
      this.beginAttempt();
      this.failures += 1;
      this.logger.error?.("Slack socket connection failed", {
        ...this.context(),
        error: this.describeError(error),
      });
    });
    client.on("connected", () => {
      this.connected = true;
      this.logger.info?.("Slack socket connected", this.context());
      this.hasConnected = true;
      this.startedAt = undefined;
      this.attempts = 0;
      this.failures = 0;
    });
    client.on("disconnecting", () => {
      this.connected = false;
      this.logger.info?.("Slack socket disconnect requested");
    });
    client.on("disconnected", () => {
      this.connected = false;
      this.logger.info?.("Slack socket disconnected", this.context());
      this.startedAt = undefined;
      this.attempts = 0;
      this.failures = 0;
    });
  }

  private beginAttempt(): void {
    this.connected = false;
    this.startedAt ??= this.now();
  }

  private context(): Record<string, unknown> {
    return {
      phase: this.hasConnected ? "reconnect" : "startup",
      attempts: this.attempts,
      failures: this.failures,
      elapsedMs: this.startedAt === undefined ? 0 : this.now() - this.startedAt,
    };
  }

  private redact(value: string): string {
    let result = value;
    for (const secret of this.secrets) {
      if (secret) result = result.split(secret).join("[redacted]");
    }
    return result
      .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, "[redacted URL]")
      .replace(/\b(?:xox[a-z]|xapp)-[\w-]+/gi, "[redacted token]")
      .replace(/[\r\n\t]/g, " ")
      .slice(0, 280);
  }

  private describeError(error: unknown): string {
    const seen = new Set<unknown>();
    const parts: string[] = [];
    const visit = (value: unknown): void => {
      if (parts.length >= 5 || seen.has(value)) return;
      seen.add(value);
      if (typeof value !== "object" || value === null) {
        if (value !== undefined) parts.push(this.redact(String(value)));
        return;
      }
      const record = value as Record<string, unknown>;
      const fields = ["name", "code", "message", "syscall"]
        .flatMap((key) => typeof record[key] === "string" ? [`${key}=${record[key]}`] : []);
      parts.push(this.redact(fields.join(" ") || "Error without message"));
      visit(record.cause);
      visit(record.original);
      if (Array.isArray(record.errors)) {
        for (const child of record.errors.slice(0, 5)) visit(child);
      }
    };
    visit(error);
    // Keep the useful leaf cause visible through the desktop log's string cap.
    return parts.reverse().join(" <- ").slice(0, 300) || "Error without details";
  }

  private logSdk(level: "warn" | "error", messages: unknown[]): void {
    this.logger[level]?.("Slack socket SDK diagnostic", {
      ...this.context(),
      error: messages.slice(0, 4).map((message) => this.describeError(message)).join("; ").slice(0, 300),
    });
  }
}
