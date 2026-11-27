import { splitSubAgentActivity } from "../lib/sub-agent-activity";

/**
 * A running sub-agent's current activity, muted under its name. One line: a
 * line that names a path loses its middle, so the file or command end stays.
 */
export function SubAgentActivityLine(props: { activity: string; className?: string }) {
  const { head, tail } = splitSubAgentActivity(props.activity);
  return (
    <span className={`sub-agent-activity${props.className ? ` ${props.className}` : ""}`}>
      <span className="sub-agent-activity__head">{head}</span>
      {tail ? <span className="sub-agent-activity__tail">{tail}</span> : null}
    </span>
  );
}
