import { createContext, useContext, type ReactNode } from "react";

/** The contrast floor xterm holds text to when the operator turns it on:
 *  WCAG AA, and VS Code's default. */
export const TERMINAL_MINIMUM_CONTRAST_RATIO = 4.5;

/** Settings → Appearance → "Raise low-contrast terminal text". Off where no
 *  provider is mounted, so a theme's ANSI colors render as published. */
const TerminalMinimumContrastContext = createContext(false);

export function TerminalPreferencesProvider(props: {
  children: ReactNode;
  minimumContrast: boolean;
}) {
  return (
    <TerminalMinimumContrastContext.Provider value={props.minimumContrast}>
      {props.children}
    </TerminalMinimumContrastContext.Provider>
  );
}

export function useTerminalMinimumContrast(): boolean {
  return useContext(TerminalMinimumContrastContext);
}
