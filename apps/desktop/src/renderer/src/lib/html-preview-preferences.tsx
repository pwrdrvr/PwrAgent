import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { DesktopApi } from "./desktop-api";

/**
 * Whether an HTML file preview opens with the page's scripts running. Off is
 * the default for untrusted code: the operator turns scripts on per page.
 *
 * The main window provides the live setting. Any other window (detached
 * files, sub-agent transcripts, changelog) has no provider, and the hook reads
 * the setting itself from the config projection.
 */
const HtmlPreviewRunScriptsContext = createContext<boolean | undefined>(undefined);

export function HtmlPreviewPreferencesProvider(props: {
  children: ReactNode;
  runScripts: boolean;
}) {
  return (
    <HtmlPreviewRunScriptsContext.Provider value={props.runScripts}>
      {props.children}
    </HtmlPreviewRunScriptsContext.Provider>
  );
}

/** The setting, or false until a window without a provider has read it. */
export function useHtmlPreviewRunScripts(
  desktopApi?: Pick<DesktopApi, "readConfigBootstrap">,
): boolean {
  const provided = useContext(HtmlPreviewRunScriptsContext);
  const [read, setRead] = useState(false);
  const readConfigBootstrap = provided === undefined ? desktopApi?.readConfigBootstrap : undefined;
  useEffect(() => {
    if (!readConfigBootstrap) return undefined;
    let cancelled = false;
    void readConfigBootstrap()
      .then((response) => {
        if (!cancelled) setRead(response.snapshot.htmlPreviewRunScripts);
      })
      .catch(() => {
        // Keep the safe default.
      });
    return () => {
      cancelled = true;
    };
  }, [readConfigBootstrap]);
  return provided ?? read;
}
