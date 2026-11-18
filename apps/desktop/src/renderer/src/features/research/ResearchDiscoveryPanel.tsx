import { useState } from "react";
import type { ResearchDiscoverySnapshot } from "@pwragent/shared";

export function ResearchDiscoveryPanel({ snapshot }: { snapshot: ResearchDiscoverySnapshot }) {
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [layout, setLayout] = useState<"list" | "graph">("list");
  const nodes = snapshot.tree?.nodes.filter((node) => `${node.id} ${node.parent ?? "root"} ${node.excerpt}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const visible = nodes.slice(page * 20, (page + 1) * 20);
  const positions = new Map(visible.map((node, i) => [node.id, i * 64 + 22]));
  return <section aria-label="Discovery observation">
    <p className="research-muted">Source state: {snapshot.state} · {snapshot.finished} finished · {snapshot.solved} reported solved · observed {new Date(snapshot.observedAt).toLocaleString()}</p>
    <p className="research-muted">Reported usage: {snapshot.tokensIn} input tokens · {snapshot.tokensOut} output tokens · {snapshot.usd === undefined ? "dollar spend unknown" : `$${snapshot.usd} reported`}. Coverage may be incomplete; no hard spend cap.</p>
    <p className="research-muted">Source verification is retained as an observation. PwrAgent has not independently verified these candidates. This snapshot may be a partial tree; source work may continue.</p>
    <details open><summary>{snapshot.problems.length} recorded problems</summary>
      <ul>{snapshot.problems.map((problem) => <li key={problem.id}>{problem.id} · {problem.state} · {problem.nodes} nodes · {problem.rounds} rounds{problem.stop ? ` · ${problem.stop}` : ""}</li>)}</ul>
    </details>
    {snapshot.tree && <>
      <p className="research-muted">Problem {snapshot.tree.problem} · {snapshot.tree.state} · {snapshot.tree.truncated ? "Source tree truncated; only the returned prefix is retained" : "Complete returned tree snapshot"}</p>
      <label>Filter discovery nodes<input type="search" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(0); }} /></label>
      <p className="research-muted">{nodes.length} matching nodes · page {page + 1} of {Math.max(1, Math.ceil(nodes.length / 20))}</p>
      <div className="research-switch" role="group" aria-label="Discovery layout"><button type="button" aria-pressed={layout === "list"} onClick={() => setLayout("list")}>Node list</button>
        <button type="button" aria-pressed={layout === "graph"} onClick={() => setLayout("graph")}>Ancestry graph</button></div>
      {layout === "graph" && <svg role="img" aria-label="Recorded discovery ancestry graph" viewBox={`0 0 360 ${Math.max(64, visible.length * 64)}`} width="100%">
        <title>Recorded parent edges. Left boxes name parents outside the filtered page.</title>
        {visible.map((node) => {
          const y = positions.get(node.id)!;
          const parentY = node.parent === null ? undefined : positions.get(node.parent);
          return <g key={node.id} data-node-id={node.id} data-parent-id={node.parent ?? "root"}>
            <title>{node.parent === null ? "Root" : `Parent ${node.parent}`} → Node {node.id}: {node.excerpt}</title>
            {node.parent !== null && (parentY === undefined ? <>
              <rect x="2" y={y - 14} width="102" height="28" fill="none" stroke="currentColor" />
              <text x="6" y={y + 4} fill="currentColor" fontSize="11">Parent {node.parent} ↗</text>
              <path d={`M104 ${y} H150`} fill="none" stroke="currentColor" />
            </> : <path d={`M280 ${parentY} H${300 + (node.id % 4) * 12} V${y} H280`} fill="none" stroke="currentColor" />)}
            <rect x="150" y={y - 14} width="130" height="28" fill="none" stroke="currentColor" />
            <text x="156" y={y + 4} fill="currentColor" fontSize="11">Node {node.id} · round {node.round}</text>
          </g>;
        })}
      </svg>}
      {layout === "list" && <ol aria-label="Recorded candidate ancestry" className="research-activity">{visible.map((node) => <li key={node.id}>
        <span>Node {node.id} · {node.parent === null ? "root" : `parent ${node.parent}`} · round {node.round} · score {node.score}</span>
        <p>{node.excerpt}</p><p className="research-muted">Source verification: {node.sourceVerified === null ? "not reported" : node.sourceVerified ? "passed (source report)" : "failed (source report)"} · {node.elapsedMs} ms from source rollout start</p>
      </li>)}</ol>}
      <div className="research-actions"><button type="button" className="research-button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous nodes</button>
        <button type="button" className="research-button" disabled={(page + 1) * 20 >= nodes.length} onClick={() => setPage(page + 1)}>Next nodes</button></div>
    </>}
    {!snapshot.tree && <p className="research-muted">Import again with a problem ID to retain its candidate tree.</p>}
  </section>;
}
