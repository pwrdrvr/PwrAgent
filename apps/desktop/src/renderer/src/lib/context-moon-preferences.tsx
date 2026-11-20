import { createContext, useContext, type ReactNode } from "react";
import {
  DESKTOP_CONTEXT_MOON_STYLE_DEFAULT,
  type DesktopContextMoonStyle,
} from "@pwragent/shared/contracts/settings";

/** Settings → Appearance → Context moon. Waxes to full where no provider is
 *  mounted. */
const ContextMoonStyleContext = createContext<DesktopContextMoonStyle>(
  DESKTOP_CONTEXT_MOON_STYLE_DEFAULT,
);

export function ContextMoonPreferencesProvider(props: {
  children: ReactNode;
  style: DesktopContextMoonStyle;
}) {
  return (
    <ContextMoonStyleContext.Provider value={props.style}>
      {props.children}
    </ContextMoonStyleContext.Provider>
  );
}

export function useContextMoonStyle(): DesktopContextMoonStyle {
  return useContext(ContextMoonStyleContext);
}
