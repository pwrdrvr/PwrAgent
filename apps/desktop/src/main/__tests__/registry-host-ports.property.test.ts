import type { CodexRuntimeSupervisorHost } from "../app-server/codex-runtime-supervisor";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, expectTypeOf, it } from "vitest";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { ArchiveCleanupInventoryHost } from "../app-server/archive-cleanup-inventory";
import type { RegistryHandlers } from "../app-server/backend-registry-handlers";
import type { ForgeToolBridgeHost } from "../app-server/forge-tool-bridge";
import type { HeadlessAutomationTurnsHost } from "../app-server/headless-automation-turns";
import type { ManagedReviewServiceHost } from "../app-server/managed-review-service";
import type { RegistryHostPorts, RegistryHostQueryResult } from "../app-server/registry-host-ports";
import type { SubAgentMonitorServiceHost } from "../app-server/subagent-monitor-service";
import type { ThreadArchiveCoordinatorHost } from "../app-server/thread-archive-coordinator";
import type { ThreadDirectoryServiceHost } from "../app-server/thread-directory-service";
import type { ThreadInspectionToolsHost } from "../app-server/thread-inspection-tools";
import type { ThreadMcpConnectionsHost } from "../app-server/thread-mcp-connections";
import type { ThreadUsageLedgerHost } from "../app-server/thread-usage-ledger";
import type { ThreadWorkspaceServiceHost } from "../app-server/thread-workspace-service";

type Hosts = {
  ArchiveCleanupInventoryHost: ArchiveCleanupInventoryHost;
  CodexRuntimeSupervisorHost: CodexRuntimeSupervisorHost;
  ForgeToolBridgeHost: ForgeToolBridgeHost;
  HeadlessAutomationTurnsHost: HeadlessAutomationTurnsHost;
  ManagedReviewServiceHost: ManagedReviewServiceHost;
  SubAgentMonitorServiceHost: SubAgentMonitorServiceHost;
  ThreadArchiveCoordinatorHost: ThreadArchiveCoordinatorHost;
  ThreadDirectoryServiceHost: ThreadDirectoryServiceHost;
  ThreadInspectionToolsHost: ThreadInspectionToolsHost;
  ThreadMcpConnectionsHost: ThreadMcpConnectionsHost;
  ThreadUsageLedgerHost: ThreadUsageLedgerHost;
  ThreadWorkspaceServiceHost: ThreadWorkspaceServiceHost;
};

type SharedMembers = {
  [Host in keyof Hosts]: Pick<Hosts[Host], Extract<keyof Hosts[Host], keyof RegistryHostPorts>>;
};

// Forge reads smaller results from these two queries. Their inputs still come
// from the same declarations as every other caller's.
type ForgePorts = Omit<RegistryHostPorts, "findHeadlessAutomationTurnForRequest" | "getActiveTurnForThread"> & {
  findHeadlessAutomationTurnForRequest: RegistryHostQueryResult<"findHeadlessAutomationTurnForRequest", "executionMode", true>;
  getActiveTurnForThread: RegistryHostQueryResult<"getActiveTurnForThread", "turnId">;
};

type ExpectedMembers = {
  [Host in keyof Hosts]: Pick<
    Host extends "ForgeToolBridgeHost" ? ForgePorts : RegistryHostPorts,
    Extract<keyof Hosts[Host], keyof RegistryHostPorts>
  >;
};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2)
    ? true : false;

it("shares the complete signature with every host that uses an operation", () => {
  expectTypeOf<SharedMembers>().toEqualTypeOf<ExpectedMembers>();
});

it("requires registry parameter additions to reach the shared declarations", () => {
  type ConstructionPorts = ReturnType<DesktopBackendRegistry["constructionPorts"]>;
  type ParameterMatches = {
    [Operation in keyof RegistryHostPorts]: Equal<
      Parameters<ConstructionPorts[Operation]>, Parameters<RegistryHostPorts[Operation]>
    >;
  };
  // Assignability alone accepts a registry with extra optional parameters.
  // Exact tuples reject that drift, including private operations exposed here.
  expectTypeOf<ParameterMatches>().toEqualTypeOf<Record<keyof RegistryHostPorts, true>>();
  expectTypeOf<Pick<ConstructionPorts, keyof RegistryHostPorts>>().toExtend<RegistryHostPorts>();
});

it("keeps handler fields on the handler contract", () => {
  type Handlers = Pick<ThreadInspectionToolsHost,
    "agentThreadActions" | "federationHandler" | "federatedThreadInspectionHandler"
    | "threadDependencyToolHandler" | "threadPrAutoDispatchHandler"
  >;
  expectTypeOf<Handlers>().toEqualTypeOf<{
    readonly [Name in keyof Handlers]: RegistryHandlers[Name];
  }>();
});

it("declares no operation separately in multiple module hosts", () => {
  const directory = new URL("../app-server/", import.meta.url);
  const declarations = new Map<string, string[]>();
  const hosts: string[] = [];
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
    const url = new URL(name, directory);
    const file = ts.createSourceFile(fileURLToPath(url), readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of file.statements) {
      if (ts.isTypeAliasDeclaration(node) && node.name.text.endsWith("Host")
        && ts.isTypeReferenceNode(node.type)
        && node.type.typeName.getText(file) === "Pick"
        && node.type.typeArguments?.[0]?.getText(file) === "RegistryHostPorts") {
        hosts.push(node.name.text);
      }
      if (!ts.isInterfaceDeclaration(node) || !node.name.text.endsWith("Host")) continue;
      hosts.push(node.name.text);
      for (const member of node.members) {
        if (!ts.isMethodSignature(member)) continue;
        const operation = member.name.getText(file);
        const users = declarations.get(operation) ?? [];
        users.push(node.name.text);
        declarations.set(operation, users);
      }
    }
  }
  // Keep the type-level inventory above exhaustive as modules are extracted.
  const checkedHosts: Record<keyof Hosts, true> = {
    ArchiveCleanupInventoryHost: true,
    CodexRuntimeSupervisorHost: true,
    ForgeToolBridgeHost: true,
    HeadlessAutomationTurnsHost: true,
    ManagedReviewServiceHost: true,
    SubAgentMonitorServiceHost: true,
    ThreadArchiveCoordinatorHost: true,
    ThreadDirectoryServiceHost: true,
    ThreadInspectionToolsHost: true,
    ThreadMcpConnectionsHost: true,
    ThreadUsageLedgerHost: true,
    ThreadWorkspaceServiceHost: true,
  };
  expect(hosts.sort()).toEqual(Object.keys(checkedHosts).sort());
  expect(Object.fromEntries([...declarations].filter(([, users]) => users.length > 1))).toEqual({});
});
