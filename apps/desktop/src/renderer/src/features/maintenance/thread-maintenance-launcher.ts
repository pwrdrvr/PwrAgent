import { createContext } from "react";

/** Opens the Thread maintenance dialog. App provides it; a surface with no
 * provider (another window, a test) hides its entry point. */
export type OpenThreadMaintenance = (request?: { projectKey?: string }) => void;

export const ThreadMaintenanceLauncherContext = createContext<OpenThreadMaintenance | undefined>(undefined);
