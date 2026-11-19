import { useId, useMemo, useState } from "react";
import type { ResearchDiscoverySnapshot } from "@pwragent/shared";
import { plural } from "./research-view-model";

type DiscoveryNode = NonNullable<ResearchDiscoverySnapshot["tree"]>["nodes"][number];
export type DiscoveryOutlineRow = { node: DiscoveryNode; depth: number; children: number; orphan: boolean };

const PAGE = 25;
const PLOT = { width: 360, height: 168, left: 30, right: 12, top: 10, bottom: 26 };

/**
 * The recorded ancestry in tree order: each node after its parent, children by
 * ID. Depth comes only from recorded parent IDs. A node whose parent is not in
 * the snapshot starts its own branch and says so; a parent loop cannot recurse.
 */
export function discoveryOutline(nodes: readonly DiscoveryNode[]): DiscoveryOutlineRow[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<number, DiscoveryNode[]>();
  const roots: DiscoveryNode[] = [];
  for (const node of nodes) {
    if (node.parent === null || !byId.has(node.parent) || node.parent === node.id) roots.push(node);
    else children.set(node.parent, [...children.get(node.parent) ?? [], node]);
  }
  const rows: DiscoveryOutlineRow[] = [];
  const placed = new Set<number>();
  const walk = (start: DiscoveryNode) => {
    const stack: Array<{ node: DiscoveryNode; depth: number }> = [{ node: start, depth: 0 }];
    while (stack.length) {
      const { node, depth } = stack.pop()!;
      if (placed.has(node.id)) continue;
      placed.add(node.id);
      // A loop's entry node was already placed at the top; it is not nested again under its recorded parent.
      const kids = (children.get(node.id) ?? []).filter((kid) => !placed.has(kid.id)).toSorted((a, b) => a.id - b.id);
      rows.push({ node, depth, children: kids.length, orphan: node.parent !== null && !byId.has(node.parent) });
      for (const kid of kids.toReversed()) stack.push({ node: kid, depth: depth + 1 });
    }
  };
  for (const root of roots.toSorted((a, b) => a.id - b.id)) walk(root);
  // Nodes only reachable through a parent loop still appear exactly once.
  for (const node of nodes.toSorted((a, b) => a.id - b.id)) if (!placed.has(node.id)) walk(node);
  return rows;
}

function score(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(2); }
function verification(value: boolean | null): string { return value === null ? "not reported" : value ? "passed (source report)" : "failed (source report)"; }

export function ResearchDiscoveryPanel({ snapshot }: { snapshot: ResearchDiscoverySnapshot }) {
  const id = useId();
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<number>();
  const tree = snapshot.tree;
  const outline = useMemo(() => tree ? discoveryOutline(tree.nodes) : [], [tree]);
  const query = filter.trim().toLowerCase();
  const rows = query ? outline.filter(({ node }) => `#${node.id} ${node.excerpt}`.toLowerCase().includes(query)) : outline;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const visible = rows.slice(page * PAGE, (page + 1) * PAGE);
  const chosen = selected === undefined ? undefined : outline.find(({ node }) => node.id === selected);
  const select = (nodeId: number) => {
    setSelected(nodeId);
    const index = rows.findIndex(({ node }) => node.id === nodeId);
    if (index >= 0) setPage(Math.floor(index / PAGE));
  };

  const plot = useMemo(() => {
    if (!tree?.nodes.length) return undefined;
    const rounds = Math.max(1, ...tree.nodes.map((node) => node.round));
    const scores = tree.nodes.map((node) => node.score);
    const low = Math.min(0, ...scores), high = Math.max(1, ...scores);
    const x = (round: number) => PLOT.left + (round / rounds) * (PLOT.width - PLOT.left - PLOT.right);
    const y = (value: number) => PLOT.top + (1 - (value - low) / (high - low || 1)) * (PLOT.height - PLOT.top - PLOT.bottom);
    const at = new Map(tree.nodes.map((node) => [node.id, { x: x(node.round), y: y(node.score) }]));
    return { rounds, low, high, at };
  }, [tree]);
  const matches = useMemo(() => new Set(rows.map(({ node }) => node.id)), [rows]);

  return <section className="research-discovery" aria-label="Discovery observation">
    <dl className="research-stats">
      <div><dt>Source state</dt><dd>{snapshot.state}</dd></div>
      <div><dt>Reported solved</dt><dd>{snapshot.solved} of {snapshot.finished} finished</dd></div>
      <div><dt>Reported usage</dt><dd>{(snapshot.tokensIn + snapshot.tokensOut).toLocaleString()} tokens
        <span className="research-muted">{snapshot.usd === undefined ? "dollars unknown" : `$${snapshot.usd.toFixed(2)} reported`}</span></dd></div>
    </dl>
    <p className="research-muted">As reported by the source when observed. Coverage may be incomplete, there is no hard spend cap, and source work may continue.</p>

    <table className="research-table" aria-label="Recorded problems">
      <thead><tr><th scope="col">Problem</th><th scope="col">State</th><th scope="col" className="is-number">Nodes</th><th scope="col" className="is-number">Rounds</th></tr></thead>
      <tbody>{snapshot.problems.map((entry) => <tr key={entry.id} className={entry.id === tree?.problem ? "is-selected" : undefined}>
        <td><code className="research-code">{entry.id}</code>{entry.id === tree?.problem && <> <span className="research-chip">tree kept</span></>}</td>
        <td><span className={`research-chip${entry.solved ? " research-chip--done" : ""}`}>{entry.solved ? "reported solved" : entry.state}</span>{entry.stop && !(entry.solved && entry.stop === "solved") && <span className="research-muted"> {entry.stop}</span>}</td>
        <td className="is-number">{entry.nodes.toLocaleString()}</td><td className="is-number">{entry.rounds}</td>
      </tr>)}</tbody>
    </table>

    {!tree && <p className="research-muted">No tree was kept. Take a new snapshot with a problem ID to keep one problem’s tree.</p>}
    {tree && <>
      <h4 className="research-group">Problem {tree.problem} · {tree.state} · {plural(tree.nodes.length, "node")}</h4>
      {tree.truncated && <p className="research-notice">The source truncated this tree. Only the nodes it returned are kept; the rest are not drawn or inferred.</p>}
      <div className="research-discovery__split">
        <div className="research-discovery__overview">
          {plot && <figure className="research-plot">
            <svg role="img" aria-labelledby={`${id}-plot`} viewBox={`0 0 ${PLOT.width} ${PLOT.height}`} width="100%">
              <title id={`${id}-plot`}>Score by round for {plural(tree.nodes.length, "recorded node")}; lines join recorded parents and children. The ancestry list below has the same nodes.</title>
              <path className="research-plot__axis" d={`M${PLOT.left} ${PLOT.top} V${PLOT.height - PLOT.bottom} H${PLOT.width - PLOT.right}`} />
              <text className="research-plot__label" x={2} y={PLOT.top + 8}>{score(plot.high)}</text>
              <text className="research-plot__label" x={2} y={PLOT.height - PLOT.bottom}>{score(plot.low)}</text>
              <text className="research-plot__label" x={PLOT.left} y={PLOT.height - 8}>round 0</text>
              <text className="research-plot__label" x={PLOT.width - PLOT.right} y={PLOT.height - 8} textAnchor="end">{plot.rounds}</text>
              {tree.nodes.map((node) => {
                const from = node.parent === null ? undefined : plot.at.get(node.parent), to = plot.at.get(node.id)!;
                return from && <path key={`e${node.id}`} className={`research-plot__edge${matches.has(node.id) ? "" : " is-dim"}`} d={`M${from.x} ${from.y} L${to.x} ${to.y}`} />;
              })}
              {tree.nodes.map((node) => {
                const { x, y } = plot.at.get(node.id)!;
                const className = `research-plot__node${node.sourceVerified ? " is-verified" : ""}${matches.has(node.id) ? "" : " is-dim"}`;
                return <g key={node.id} data-node-id={node.id} data-parent-id={node.parent ?? "root"} className={className} onClick={() => select(node.id)}>
                  {node.sourceVerified ? <path d={`M${x} ${y - 5} L${x + 5} ${y} L${x} ${y + 5} L${x - 5} ${y} Z`} /> : <circle cx={x} cy={y} r={3.25} />}
                </g>;
              })}
              {chosen && plot.at.get(chosen.node.id) && <circle className="research-plot__ring" cx={plot.at.get(chosen.node.id)!.x} cy={plot.at.get(chosen.node.id)!.y} r={8} />}
            </svg>
            <figcaption className="research-legend"><span>● candidate</span><span className="research-ok">◆ source reports verified</span><span>score ↑ · round →</span></figcaption>
          </figure>}
          {chosen && <section className="research-card" aria-label={`Discovery node ${chosen.node.id}`}>
            <div className="research-card__top"><span className="research-chip">Node #{chosen.node.id}</span>
              <button type="button" className="research-button research-button--ghost" onClick={() => setSelected(undefined)}>Close</button></div>
            <p className="research-text">{chosen.node.excerpt}</p>
            <dl className="research-dl">
              <dt>Parent</dt><dd>{chosen.node.parent === null ? "Root" : <button type="button" className="research-link" onClick={() => select(chosen.node.parent!)}>#{chosen.node.parent}</button>}</dd>
              <dt>Round</dt><dd>{chosen.node.round}</dd>
              <dt>Score</dt><dd>{chosen.node.score}</dd>
              <dt>Verification</dt><dd>{verification(chosen.node.sourceVerified)}</dd>
              <dt>Elapsed</dt><dd>{(chosen.node.elapsedMs / 1000).toFixed(1)} s from the source’s rollout start</dd>
            </dl>
          </section>}
        </div>
        <div className="research-discovery__tree">
          <input className="research-filter" type="search" aria-label="Filter discovery nodes" placeholder="Filter by node ID or text" value={filter}
            onChange={(event) => { setFilter(event.target.value); setPage(0); }} />
          <p className="research-muted" role="status">{query ? `${plural(rows.length, "matching node")}` : plural(rows.length, "node")} · page {Math.min(page + 1, pages)} of {pages}</p>
          <ol className="research-outline" aria-label="Recorded candidate ancestry">{visible.map(({ node, depth, children, orphan }) => <li key={node.id}
            data-node-id={node.id} data-parent-id={node.parent ?? "root"} style={{ ["--depth" as string]: Math.min(depth, 12) }}>
            <button type="button" className="research-outline__row" aria-current={selected === node.id ? "true" : undefined} onClick={() => select(node.id)}>
              <span className="research-outline__id">#{node.id}</span>
              <span className="research-outline__text">{node.excerpt}</span>
              <span className="research-outline__score" title={`Score ${node.score}`}><span className="research-bar" aria-hidden="true"><i style={{ width: `${Math.round(Math.max(0, Math.min(1, (node.score - (plot?.low ?? 0)) / ((plot?.high ?? 1) - (plot?.low ?? 0) || 1))) * 100)}%` }} /></span>{score(node.score)}</span>
              <span className="research-outline__meta">{node.parent === null ? "root" : orphan ? `parent #${node.parent} not in snapshot` : `parent #${node.parent}`} · round {node.round}{children ? ` · ${plural(children, "child", "children")}` : ""}
                {node.sourceVerified !== null && <> · <span className={node.sourceVerified ? "research-ok" : "research-bad"}>{verification(node.sourceVerified)}</span></>}</span>
            </button>
          </li>)}</ol>
          {pages > 1 && <div className="research-actions">
            <button type="button" className="research-button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous nodes</button>
            <button type="button" className="research-button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next nodes</button>
          </div>}
        </div>
      </div>
    </>}
    <p className="research-notice">Source verification is reported by the source. PwrAgent has not independently verified these candidates.</p>
  </section>;
}
