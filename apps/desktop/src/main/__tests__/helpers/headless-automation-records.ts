import type { DesktopBackendRegistry } from "../../app-server/backend-registry";
import { registryModules } from "../../app-server/backend-registry-wiring";
import type { HeadlessAutomationTurns } from "../../app-server/headless-automation-turns";

type AutomationTurn = NonNullable<ReturnType<HeadlessAutomationTurns["findHeadlessAutomationForThread"]>>;

/** Seed a running automation in cross-domain tests that exercise its consumers. */
export function headlessAutomationRecords(registry: DesktopBackendRegistry): Map<string, Partial<AutomationTurn>> {
  return (registryModules(registry).headlessAutomation as unknown as {
    headlessAutomationTurns: Map<string, Partial<AutomationTurn>>;
  }).headlessAutomationTurns;
}
