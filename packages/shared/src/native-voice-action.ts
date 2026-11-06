/** A PwrAgent tool the voice session's thread ran, reported as it settled. */
export type NativeVoiceAction = {
  tool: string;
  ok: boolean;
  /** The thread the tool acted on, when its result names one. */
  target?: string;
  /** The machine that owns `target`, when it is a peer. */
  instance?: string;
  /** What the tool reported doing: queued, steered, started, stopped. */
  outcome?: string;
  /** The tool's namespace, for the invocation the receipt expands to. */
  namespace?: string;
  /** The arguments Codex passed, when they serialize within the receipt bound. */
  arguments?: Record<string, unknown>;
  /** The tool's text result, bounded; the end of a longer result is cut. */
  output?: string;
};
