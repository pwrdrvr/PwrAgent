import type { DesktopApplicationDiscoveryCandidate } from "@pwragent/shared/contracts/settings";

/** One way the thread card opens a thread, named as its tooltip reads. */
export type ThreadCardOpenTarget =
  | {
      kind: "application";
      id: string;
      /** "Open in VS Code". */
      label: string;
      application: DesktopApplicationDiscoveryCandidate;
    }
  | { kind: "integrated-terminal"; id: "integrated-terminal"; label: string }
  | { kind: "file-manager"; id: "file-manager"; label: string };

/** How many open icons the card's row holds before the rest go to "Open in…". */
export const THREAD_CARD_OPEN_ICON_LIMIT = 4;

export const INTEGRATED_TERMINAL_LABEL = "Open terminal here";

/**
 * The card's open icons, in the row's order: the preferred editor, the
 * preferred terminal app, the integrated terminal, the file manager, then
 * the other editors and terminal apps. The first four make the row; the rest
 * are `more`, for the ⋯ menu's "Open in…". Only apps that can open a folder
 * are passed in, so only configured or discovered apps appear.
 */
export function threadCardOpenTargets(input: {
  editors: readonly DesktopApplicationDiscoveryCandidate[];
  preferredEditorId?: string;
  terminals: readonly DesktopApplicationDiscoveryCandidate[];
  preferredTerminalId?: string;
  integratedTerminal: boolean;
  /** "Show in Finder"; absent where the folder cannot be shown. */
  fileManagerLabel?: string;
}): { row: ThreadCardOpenTarget[]; more: ThreadCardOpenTarget[] } {
  const editor = input.editors.find((app) => app.id === input.preferredEditorId) ?? input.editors[0];
  const terminal = input.terminals.find((app) => app.id === input.preferredTerminalId) ?? input.terminals[0];
  const seen = new Set<string>();
  const ordered: ThreadCardOpenTarget[] = [];
  const addApplication = (application: DesktopApplicationDiscoveryCandidate | undefined): void => {
    if (!application || seen.has(application.id)) return;
    seen.add(application.id);
    ordered.push({
      kind: "application",
      id: application.id,
      label: `Open in ${application.name}`,
      application,
    });
  };
  addApplication(editor);
  addApplication(terminal);
  if (input.integratedTerminal) {
    ordered.push({ kind: "integrated-terminal", id: "integrated-terminal", label: INTEGRATED_TERMINAL_LABEL });
  }
  if (input.fileManagerLabel) {
    ordered.push({ kind: "file-manager", id: "file-manager", label: input.fileManagerLabel });
  }
  input.editors.forEach(addApplication);
  input.terminals.forEach(addApplication);
  return {
    row: ordered.slice(0, THREAD_CARD_OPEN_ICON_LIMIT),
    more: ordered.slice(THREAD_CARD_OPEN_ICON_LIMIT),
  };
}
