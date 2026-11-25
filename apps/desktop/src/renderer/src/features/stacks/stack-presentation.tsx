import { createContext } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";

export const StackRailContext = createContext<((thread: NavigationThreadSummary) => void) | undefined>(undefined);

export { stackHoldForPr } from "./stack-pr-data";
