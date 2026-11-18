/** A refusal the agent can act on; the tool returns its message unchanged. */
export class AgentFollowUpRefusal extends Error {
  constructor(
    readonly code: "invalid_arguments" | "not_found" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "AgentFollowUpRefusal";
  }
}
