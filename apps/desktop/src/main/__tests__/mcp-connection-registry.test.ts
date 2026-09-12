import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  McpConnectionRegistry,
  normalizeMcpServerUrl,
} from "../mcp-connections/mcp-connection-registry";

const temporaryDirectories: string[] = [];

function configPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mcp-registry-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "config.toml");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("McpConnectionRegistry", () => {
  it("reserves PwrGit's routing ID when creating a custom connection", () => {
    const registry = new McpConnectionRegistry({
      configPath: configPath(),
      randomId: () => "custom",
    });
    const created = registry.create({
      displayName: "PwrGit",
      serverUrl: "https://mcp.example.com/mcp",
    });
    expect(created.id).toBe("pwrgit-custom");
    expect(registry.get(created.id)?.serverUrl).toBe("https://mcp.example.com/mcp");
  });

  it("refuses a second connection for an address that already has one", () => {
    // `uniqueId` only keeps the slug distinct, so the same endpoint could be
    // registered repeatedly -- each row needing its own consent and showing
    // up separately in every thread's picker. The agent tool reaches this
    // without a person: a model retrying a `create` it never saw the answer
    // to would write the second row.
    const registry = new McpConnectionRegistry({ configPath: configPath() });
    registry.create({
      displayName: "Datadog",
      serverUrl: "https://mcp.example.com/mcp",
    });
    expect(() =>
      registry.create({
        displayName: "Datadog again",
        serverUrl: "https://mcp.example.com/mcp",
      }),
    ).toThrow("Datadog is already registered for that address.");
    expect(registry.list().filter((entry) => entry.kind === "remote")).toHaveLength(1);
  });

  it("refuses a connection that shadows a built-in's address", () => {
    const registry = new McpConnectionRegistry({ configPath: configPath() });
    expect(() =>
      registry.create({
        displayName: "Not PwrSnap",
        serverUrl: "http://127.0.0.1:51729/mcp",
      }),
    ).toThrow("PwrSnap is already registered for that address.");
  });

  it("re-points a connection in place instead of forcing remove-and-retype", () => {
    // `create` persists before authorization is attempted, so a single
    // mistyped character used to leave a dead row whose only exit was Remove
    // and retype.
    const registry = new McpConnectionRegistry({
      configPath: configPath(),
      randomId: () => "custom",
    });
    const created = registry.create({
      displayName: "Datadog",
      serverUrl: "https://mcp.exmaple.com/mcp",
    });
    const { connection, serverUrlChanged } = registry.update({
      connectionId: created.id,
      serverUrl: "https://mcp.example.com/mcp",
    });
    expect(serverUrlChanged).toBe(true);
    expect(connection.serverUrl).toBe("https://mcp.example.com/mcp");
    expect(registry.get(created.id)?.serverUrl).toBe(
      "https://mcp.example.com/mcp",
    );
  });

  it("reports a rename as no change of target, so credentials survive it", () => {
    const registry = new McpConnectionRegistry({
      configPath: configPath(),
      randomId: () => "custom",
    });
    const created = registry.create({
      displayName: "Datadog",
      serverUrl: "https://mcp.example.com/mcp",
    });
    const { connection, serverUrlChanged } = registry.update({
      connectionId: created.id,
      displayName: "Datadog (prod)",
    });
    expect(serverUrlChanged).toBe(false);
    expect(connection.displayName).toBe("Datadog (prod)");
  });

  it("refuses to edit a built-in connection", () => {
    // PwrSnap and PwrGit are synthesized from fixed local endpoints; an
    // operator-supplied URL for them would point the bridge at something the
    // app does not serve.
    const registry = new McpConnectionRegistry({ configPath: configPath() });
    expect(() =>
      registry.update({
        connectionId: "pwrsnap",
        serverUrl: "https://elsewhere.example.com/mcp",
      }),
    ).toThrow(/cannot be edited/i);
  });

  it("preserves unrelated TOML while adding and removing a connection", () => {
    const target = configPath();
    fs.writeFileSync(target, [
      "# operator comment",
      "[general]",
      "theme = \"dark\"",
      "",
    ].join("\n"));
    const registry = new McpConnectionRegistry({
      configPath: target,
      now: () => 1_723_456_789_000,
    });

    const created = registry.create({
      displayName: "Atlassian Rovo",
      serverUrl: "https://mcp.atlassian.com/v1/mcp",
    });

    expect(created.id).toBe("atlassian-rovo");
    expect(registry.list()).toMatchObject([
      { id: "pwrsnap", kind: "pwrsnap" },
      { id: "pwrgit", kind: "pwrgit" },
      {
        id: "atlassian-rovo",
        kind: "remote",
        serverUrl: "https://mcp.atlassian.com/v1/mcp",
      },
    ]);
    expect(fs.readFileSync(target, "utf8")).toContain("# operator comment");

    expect(registry.remove(created.id)).toBe(true);
    expect(registry.list().map((connection) => connection.id)).toEqual([
      "pwrsnap",
      "pwrgit",
    ]);
    expect(fs.readFileSync(target, "utf8")).toContain("theme = \"dark\"");
  });

  it("parks and restores a connection without discarding it", () => {
    const target = configPath();
    const registry = new McpConnectionRegistry({
      configPath: target,
      now: () => 1_723_456_789_000,
    });
    const created = registry.create({
      displayName: "Datadog",
      serverUrl: "https://mcp.datadoghq.com/mcp",
    });
    expect(created.enabled).toBe(true);

    expect(registry.setEnabled(created.id, false).enabled).toBe(false);
    // Parking withholds a connection from threads; it must not behave like
    // `remove`, which discards the record and its credentials.
    expect(registry.get(created.id)).toMatchObject({
      id: created.id,
      enabled: false,
      serverUrl: "https://mcp.datadoghq.com/mcp",
    });

    expect(registry.setEnabled(created.id, true).enabled).toBe(true);
    expect(
      new McpConnectionRegistry({ configPath: target }).get(created.id)
        ?.enabled,
    ).toBe(true);
  });

  it("parks the built-in PwrSnap connection through its own key", () => {
    const target = configPath();
    const registry = new McpConnectionRegistry({ configPath: target });

    // PwrSnap has no stored row, so its availability lives in a scalar. The
    // default has to be on: an absent key is not a decision to turn it off.
    expect(registry.get("pwrsnap")?.enabled).toBe(true);
    expect(registry.setEnabled("pwrsnap", false).enabled).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toContain("pwrsnap_enabled");
    expect(
      new McpConnectionRegistry({ configPath: target }).get("pwrsnap")?.enabled,
    ).toBe(false);
  });

  it("keeps rows it cannot parse when an unrelated connection is toggled", () => {
    const target = configPath();
    fs.writeFileSync(target, [
      "[[mcp_connections.connections]]",
      "id = \"acme\"",
      "display_name = \"Acme\"",
      "server_url = \"https://mcp.acme.example/mcp\"",
      "auth_mode = \"oauth\"",
      "enabled = true",
      "created_at = 1",
      "updated_at = 1",
      "",
      "[[mcp_connections.connections]]",
      "id = \"corp-tools\"",
      "display_name = \"Corp Tools\"",
      // Plain HTTP on a non-loopback host: this build rejects the row.
      "server_url = \"http://tools.corp.example/mcp\"",
      "",
    ].join("\n"));
    const registry = new McpConnectionRegistry({
      configPath: target,
      now: () => 2,
    });

    expect(registry.list().map((connection) => connection.id))
      .toEqual(["pwrsnap", "pwrgit", "acme"]);

    registry.setEnabled("acme", false);

    const written = fs.readFileSync(target, "utf8");
    expect(written).toContain("corp-tools");
    expect(written).toContain("http://tools.corp.example/mcp");
  });

  it("keeps fields it does not recognize on a row it rewrites", () => {
    const target = configPath();
    fs.writeFileSync(target, [
      "[[mcp_connections.connections]]",
      "id = \"acme\"",
      "display_name = \"Acme\"",
      "server_url = \"https://mcp.acme.example/mcp\"",
      "auth_mode = \"oauth\"",
      "enabled = true",
      "created_at = 1",
      "updated_at = 1",
      // A field a newer build wrote. Downgrading must not discard it.
      "transport = \"streamable-http\"",
      "",
    ].join("\n"));
    const registry = new McpConnectionRegistry({
      configPath: target,
      now: () => 2,
    });

    registry.setEnabled("acme", false);

    const written = fs.readFileSync(target, "utf8");
    expect(written).toContain("transport = \"streamable-http\"");
    expect(written).toContain("enabled = false");
  });

  it("does not resurrect a removed connection from a duplicate row", () => {
    const target = configPath();
    const row = (updatedAt: number): string[] => [
      "[[mcp_connections.connections]]",
      "id = \"acme\"",
      "display_name = \"Acme\"",
      "server_url = \"https://mcp.acme.example/mcp\"",
      "auth_mode = \"oauth\"",
      "enabled = true",
      "created_at = 1",
      `updated_at = ${updatedAt}`,
      "",
    ];
    fs.writeFileSync(target, [...row(1), ...row(2)].join("\n"));
    const registry = new McpConnectionRegistry({ configPath: target });

    expect(registry.remove("acme")).toBe(true);
    expect(registry.list().map((connection) => connection.id))
      .toEqual(["pwrsnap", "pwrgit"]);
    expect(fs.readFileSync(target, "utf8")).not.toContain("acme");
  });

  it("refuses to park a connection that no longer exists", () => {
    const registry = new McpConnectionRegistry({ configPath: configPath() });
    expect(() => registry.setEnabled("ghost", false))
      .toThrow("no longer exists");
  });

  it("accepts HTTPS and loopback HTTP but rejects unsafe remote URLs", () => {
    expect(normalizeMcpServerUrl("https://example.com/mcp"))
      .toBe("https://example.com/mcp");
    expect(normalizeMcpServerUrl("http://127.0.0.1:3000/mcp"))
      .toBe("http://127.0.0.1:3000/mcp");
    expect(() => normalizeMcpServerUrl("http://example.com/mcp"))
      .toThrow("must use HTTPS");
    expect(() => normalizeMcpServerUrl("https://user:secret@example.com/mcp"))
      .toThrow("cannot contain credentials");
    expect(() => normalizeMcpServerUrl("https://example.com/mcp#token"))
      .toThrow("cannot contain fragments");
  });
});
