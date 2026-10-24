import { SandboxerConnection } from "../../mcp-connections/sandboxer-connection";

/** A CLI missing from the fixture machine; never probe the operator's sbx. */
export function sandboxerStub(): SandboxerConnection {
  return new SandboxerConnection(async () => {
    throw Object.assign(new Error("Fixture CLI missing"), { code: "ENOENT" });
  });
}
