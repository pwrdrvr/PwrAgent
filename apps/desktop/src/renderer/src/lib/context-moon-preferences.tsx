import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { DesktopAutoCompactionRule } from "@pwragent/shared/auto-compaction";
import {
  DESKTOP_CONTEXT_MOON_STYLE_DEFAULT,
  type DesktopContextMoonStyle,
} from "@pwragent/shared/contracts/settings";

type ContextMoonPreferences = {
  style: DesktopContextMoonStyle;
  /** Saved auto-compaction rules; the moon measures against their budget. */
  autoCompactionRules: readonly DesktopAutoCompactionRule[];
};

const NO_RULES: readonly DesktopAutoCompactionRule[] = [];

/** Settings → Appearance → Context moon. Waxes to full where no provider is
 *  mounted. */
const ContextMoonPreferencesContext = createContext<ContextMoonPreferences>({
  style: DESKTOP_CONTEXT_MOON_STYLE_DEFAULT,
  autoCompactionRules: NO_RULES,
});

export function ContextMoonPreferencesProvider(props: {
  children: ReactNode;
  style: DesktopContextMoonStyle;
  autoCompactionRules?: readonly DesktopAutoCompactionRule[];
}) {
  const rules = props.autoCompactionRules ?? NO_RULES;
  const value = useMemo(
    () => ({ style: props.style, autoCompactionRules: rules }),
    [props.style, rules],
  );
  return (
    <ContextMoonPreferencesContext.Provider value={value}>
      {props.children}
    </ContextMoonPreferencesContext.Provider>
  );
}

export function useContextMoonStyle(): DesktopContextMoonStyle {
  return useContext(ContextMoonPreferencesContext).style;
}

export function useAutoCompactionRules(): readonly DesktopAutoCompactionRule[] {
  return useContext(ContextMoonPreferencesContext).autoCompactionRules;
}
