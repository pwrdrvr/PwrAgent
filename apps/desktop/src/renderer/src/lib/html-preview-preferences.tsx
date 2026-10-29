import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether an HTML file preview opens with the page's scripts running. Off is
 * the default for untrusted code: the operator turns scripts on per page.
 */
const HtmlPreviewRunScriptsContext = createContext(false);

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

export function useHtmlPreviewRunScripts(): boolean {
  return useContext(HtmlPreviewRunScriptsContext);
}
