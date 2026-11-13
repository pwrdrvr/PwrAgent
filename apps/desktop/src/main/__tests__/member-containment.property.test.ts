import fc from "fast-check";
import { containedFederationNotificationAllowed } from "@pwragent/federation/federation-backend-methods";
import { assertFederationEgress } from "@pwragent/federation/federation-egress";
import type { FederationProtocolEnvelope, FederationRequestEnvelope } from "@pwragent/shared";
import { expect, it, onTestFinished, vi } from "vitest";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { getOwnerHostServices, installOwnerHostServices } from "../owner-host";
import { createOutpostRuntimePolicy } from "../owner-runtime-policy";

// Rule: containment is a property of the federation member, set by its
// operator, and the same on a desktop and an Outpost. A contained member
// refuses its own outbound federation requests and gives its models only the
// allowed agent tools; a full member does neither. Whether the host is
// headless decides nothing.

const configuredMemberRole = vi.hoisted(() => ({ role: undefined as "full" | "contained" | undefined }));
const sentToCodex = vi.hoisted(() => [] as string[]);

vi.mock("../settings/config-store/desktop-config-store-singleton", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings/config-store/desktop-config-store-singleton")>();
  return {
    ...actual,
    getExistingDesktopConfigStore: () => configuredMemberRole.role
      ? { read: (section: string) => section === "federation" ? { memberRole: configuredMemberRole.role } : {} } as never
      : actual.getExistingDesktopConfigStore(),
  };
});

vi.mock("../codex-app-server/stdio-transport", () => ({
  StdioJsonRpcTransport: class {
    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    send(message: string): void { sentToCodex.push(message); }
    setMessageHandler(): void {}
    setCloseHandler(): void {}
  },
}));

vi.mock("@pwragent/federation/federation-refusal-audit", () => ({ appendFederationRefusalAudit: vi.fn() }));

type Host = "desktop" | "outpost";
type Role = "full" | "contained";

/** An Outpost reads its role from its environment, a desktop from config.toml. */
function installMember(host: Host, role: Role): void {
  const previous = getOwnerHostServices();
  onTestFinished(() => {
    installOwnerHostServices(previous);
    configuredMemberRole.role = undefined;
  });
  if (host === "outpost") {
    installOwnerHostServices({ ...previous, runtimePolicy: createOutpostRuntimePolicy({ PWRAGENT_OUTPOST_FEDERATION_ROLE: role }) });
    configuredMemberRole.role = undefined;
  } else {
    installOwnerHostServices({ ...previous, runtimePolicy: undefined });
    configuredMemberRole.role = role;
  }
}

const host = fc.constantFrom<Host>("desktop", "outpost");
const role = fc.constantFrom<Role>("full", "contained");

it("refuses outbound federation requests and notifications by the member's role alone, on every host", () => {
  fc.assert(fc.property(host, role,
    fc.constantFrom("backend.startThread", "backend.readThread", "messaging.destination", "pty.open", "file.push.begin", "unmapped.futureMethod"),
    fc.constantFrom("thread/started", "item/completed", "federation.peerDirectory", "unmapped/notification"),
    (hostKind, memberRole, method, notification) => {
      installMember(hostKind, memberRole);
      const runtime = Object.assign(new DesktopFederationRuntime(), { localInstanceId: "member" }) as unknown as {
        installEgressPolicy(connection: { sendEnvelope(envelope: FederationProtocolEnvelope): void }): void;
        canOriginateNotification(method: string): boolean;
      };
      const sent: unknown[] = [];
      const connection = { sendEnvelope: (envelope: FederationProtocolEnvelope) => { sent.push(envelope); } };
      runtime.installEgressPolicy(connection);
      const envelope: FederationRequestEnvelope = { id: "request", kind: "request", method, params: {},
        sourceInstanceId: "member", targetInstanceId: "peer", protocolVersion: 1, createdAt: 1 };
      let containedRefuses = false;
      try { assertFederationEgress("contained", envelope); } catch { containedRefuses = true; }
      const refused = memberRole === "contained" && containedRefuses;
      if (refused) expect(() => connection.sendEnvelope(envelope)).toThrow();
      else connection.sendEnvelope(envelope);
      expect(sent).toEqual(refused ? [] : [envelope]);
      expect(runtime.canOriginateNotification(notification))
        .toBe(memberRole === "full" || containedFederationNotificationAllowed(notification));
    },
  ));
});

function advertised(message: string): string[] {
  const specs = (JSON.parse(message) as { params: { dynamicTools: Array<{ type?: string; name: string; tools?: Array<{ name: string }> }> } }).params.dynamicTools;
  return specs.flatMap((spec) => spec.type === "namespace" ? (spec.tools ?? []).map((tool) => `${spec.name}/${tool.name}`) : [spec.name]);
}

it("advertises agent tools to Codex by the member's role alone, on every host", () => {
  const catalog = [
    { type: "namespace", name: "pwragent", description: "PwrAgent", tools: [
      { name: "read_tool_guide", description: "Guide" },
      { name: "get_thread_status", description: "Status" },
      { name: "send_message_to_thread", description: "Send" },
    ] },
    { type: "function", name: "outside_tool", description: "Not a PwrAgent tool" },
  ];
  const everyTool = ["pwragent/read_tool_guide", "pwragent/get_thread_status", "pwragent/send_message_to_thread", "outside_tool"];
  fc.assert(fc.property(host, role, fc.constantFrom("thread/start", "thread/resume", "turn/start"), (hostKind, memberRole, method) => {
    installMember(hostKind, memberRole);
    sentToCodex.length = 0;
    const client = new CodexAppServerClient({ command: "codex-fixture" });
    const transport = (client as unknown as { transport: { send(message: string): void } }).transport;
    transport.send(JSON.stringify({ id: 1, method, params: { threadId: "thread", dynamicTools: catalog } }));
    expect(sentToCodex).toHaveLength(1);
    expect(advertised(sentToCodex[0]!)).toEqual(memberRole === "full" ? everyTool : ["pwragent/read_tool_guide"]);
  }), { numRuns: 30 });
});

it("reads a desktop's member_role fail-closed and keeps it through a federation settings save", async () => {
  const { desktopSettingsPatchToEdits, parseDesktopSettingsToml } = await import("../settings/desktop-config");
  const { applyTomlEdits, parseTomlTables } = await import("../settings/toml-editor");
  fc.assert(fc.property(
    fc.option(fc.oneof(fc.constantFrom("full", " FULL ", "contained", "", "trusted", "ful", "none"), fc.string()), { nil: undefined }),
    (value) => {
      const toml = `[federation]\nmode = "client"\n${value === undefined ? "" : `member_role = ${JSON.stringify(value)}\n`}`;
      // Unset is a full member, as every desktop was. Anything set that is
      // not "full" contains the member rather than guess at a typo.
      const expected = value === undefined || value === "" ? undefined : value.trim().toLowerCase() === "full" ? "full" : "contained";
      expect(parseDesktopSettingsToml(toml, "test.toml").federation?.memberRole).toBe(expected);
      const saved = applyTomlEdits(toml, desktopSettingsPatchToEdits({ federation: { instanceLabel: "Invented label" } }, parseTomlTables(toml, "test.toml")));
      expect(parseDesktopSettingsToml(saved, "test.toml").federation?.memberRole).toBe(expected);
    },
  ));
});
