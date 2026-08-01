import type { AppServerBackendKind } from "./normalized-app-server";

/**
 * Opens the dedicated, read-only transcript window for a delegated agent.
 *
 * A native Codex child has a transcript addressable through `thread/read`,
 * but is not necessarily a durable PwrAgent navigation thread. Keeping this
 * request separate prevents the viewer from accidentally gaining normal
 * thread navigation or composer controls.
 */
export type OpenSubAgentTranscriptWindowRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  title: string;
};

export type OpenSubAgentTranscriptWindowResponse = {
  opened: true;
};
