import { useEffect, useState } from "react";
import type { InspectTokenMiserOutputRequest, InspectTokenMiserOutputResponse } from "@pwragent/shared";
import { useDesktopApi } from "../../lib/desktop-api";

type Props = Omit<InspectTokenMiserOutputRequest, "source" | "offset">;

/** Explicit reads only: never load private output as part of savings refresh. */
export function TokenMiserOutputInspector(props: Props) {
  const api = useDesktopApi();
  const [selection, setSelection] = useState<{ source: "original" | "summary"; offsets: number[] }>();
  const [page, setPage] = useState<InspectTokenMiserOutputResponse>();
  const [error, setError] = useState<string>();
  const { backend, threadId, objectId, federationTarget } = props;
  const inspect = api?.inspectTokenMiserOutput;
  useEffect(() => {
    let active = true;
    setPage(undefined);
    setError(undefined);
    if (!selection) return;
    if (!inspect) {
      setError("Output inspection is unavailable on this instance.");
      return;
    }
    void inspect({ backend, threadId, objectId, federationTarget, source: selection.source, offset: selection.offsets.at(-1)! })
      .then((result) => { if (active) setPage(result); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { active = false; };
  }, [backend, threadId, objectId, federationTarget, inspect, selection]);

  return (
    <section aria-label="Retained tool output">
      <div className="incident-explorer__actions">
        <button className="incident-explorer__button" type="button"
          aria-pressed={selection?.source === "original"}
          onClick={() => setSelection({ source: "original", offsets: [0] })}>View original</button>
        <button className="incident-explorer__button" type="button"
          aria-pressed={selection?.source === "summary"}
          onClick={() => setSelection({ source: "summary", offsets: [0] })}>View summary</button>
        {selection ? <button className="incident-explorer__button" type="button"
          onClick={() => setSelection(undefined)}>Close output</button> : null}
      </div>
      {selection ? <>
        {error ? <p role="alert">{error}</p> : !page ? <p role="status">Loading output…</p> : null}
        {page?.available === false ? <p role="status">
          This output is no longer available. It may have been released when the next turn started,
          on archive or restart, or under memory pressure.
        </p> : null}
        {page?.available ? <>
          <pre className="incident-explorer__output-lines" aria-label={selection.source === "original" ? "Original output" : "Summary"}>
            <code>{page.text}</code>
          </pre>
          <div className="incident-explorer__actions">
            <span>{page.totalCharacters === 0 ? "Empty output" : `Characters ${(page.offset + 1).toLocaleString()}–${(page.offset + page.text.length).toLocaleString()} of ${page.totalCharacters.toLocaleString()}`}</span>
            <button className="incident-explorer__button" type="button" disabled={selection.offsets.length === 1}
              onClick={() => setSelection({ ...selection, offsets: selection.offsets.slice(0, -1) })}>Previous page</button>
            <button className="incident-explorer__button" type="button" disabled={page.nextOffset === undefined}
              onClick={() => setSelection({ ...selection, offsets: [...selection.offsets, page.nextOffset!] })}>Next page</button>
          </div>
        </> : null}
      </> : null}
    </section>
  );
}
