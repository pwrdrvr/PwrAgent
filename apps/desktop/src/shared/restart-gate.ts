/**
 * What the quiet-restart gate is doing, for the main window's notice. See
 * `main/app-server/restart-continuation-gate.ts`.
 */
export type RestartGateStatus =
  | { phase: "open" }
  | { phase: "quieting" }
  | {
      phase: "resuming";
      /** Continuations not yet started. */
      waiting: number;
      /** The next continuation's start time, once dispatch is scheduled. */
      nextAt?: number;
      /** When the gate opens regardless, once dispatch is scheduled. */
      releaseBy?: number;
    };
