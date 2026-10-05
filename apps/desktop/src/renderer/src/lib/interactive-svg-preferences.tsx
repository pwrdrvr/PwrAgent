import { createContext, useContext, type ReactNode } from "react";

export type InteractiveSvgPreferencePatch = {
  interactiveSvgSkipNotice?: boolean;
  interactiveSvgAutoOpen?: boolean;
};

export type InteractiveSvgPreferences = {
  /** Run an SVG's scripts on request without the notice first. */
  skipNotice: boolean;
  /** Open an SVG with scripts straight into its interactive frame. */
  autoOpen: boolean;
  /** Absent where the profile's settings cannot be written; the notice then
   *  offers only Run Once, never an Always Run it could not keep. */
  save?: (patch: InteractiveSvgPreferencePatch) => Promise<boolean>;
};

/** Ask every time, open the static preview: the defaults for untrusted code. */
const DEFAULT_PREFERENCES: InteractiveSvgPreferences = {
  skipNotice: false,
  autoOpen: false,
};

const InteractiveSvgPreferencesContext =
  createContext<InteractiveSvgPreferences>(DEFAULT_PREFERENCES);

export function InteractiveSvgPreferencesProvider(props: {
  children: ReactNode;
  value: InteractiveSvgPreferences;
}) {
  return (
    <InteractiveSvgPreferencesContext.Provider value={props.value}>
      {props.children}
    </InteractiveSvgPreferencesContext.Provider>
  );
}

export function useInteractiveSvgPreferences(): InteractiveSvgPreferences {
  return useContext(InteractiveSvgPreferencesContext);
}
