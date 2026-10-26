import { describe, expect, it } from "vitest";
import { CodexConfigTomlError, parseCodexConfigToml } from "../settings/codex-config-toml";

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("parseCodexConfigToml", () => {
  it("reads what Codex writes, including quoted table names", () => {
    const config = parseCodexConfigToml([
      "\uFEFFmodel = \"/models/Bonsai-2-27B.gguf\" # local",
      "model_provider = \"bonsai\"",
      "model_context_window = 65_536",
      "",
      "[model_providers.bonsai]",
      "name = \"PrismML Bonsai (local)\"",
      "base_url = \"http://127.0.0.1:18080/v1\"",
      "wire_api = \"responses\"",
      "supports_websockets = false",
      "",
      "[projects.\"/private/tmp\"]",
      "trust_level = \"trusted\"",
      "",
      "[mcp_servers.docs]",
      "command = 'npx'",
      "args = [",
      "  \"-y\", # the package",
      "  \"docs-mcp\",",
      "]",
      "env = { DOCS_TOKEN = \"x\", nested.key = 1 }",
    ].join("\r\n"));
    expect(plain(config)).toEqual({
      model: "/models/Bonsai-2-27B.gguf",
      model_provider: "bonsai",
      model_context_window: 65536,
      model_providers: {
        bonsai: {
          name: "PrismML Bonsai (local)",
          base_url: "http://127.0.0.1:18080/v1",
          wire_api: "responses",
          supports_websockets: false,
        },
      },
      projects: { "/private/tmp": { trust_level: "trusted" } },
      mcp_servers: {
        docs: {
          command: "npx",
          args: ["-y", "docs-mcp"],
          env: { DOCS_TOKEN: "x", nested: { key: 1 } },
        },
      },
    });
  });

  it("reads dotted keys, inline tables and arrays of tables", () => {
    const config = parseCodexConfigToml([
      "model_providers.gpu.base_url = \"http://gpu.lan/v1\"",
      "model_providers.\"two words\" = { name = \"Two\", base_url = \"https://two.example/v1\" }",
      "[[hooks.items]]",
      "name = \"first\"",
      "[[hooks.items]]",
      "name = \"second\"",
      "[hooks.items.detail]",
      "on = true",
    ].join("\n"));
    expect(plain(config)).toEqual({
      model_providers: {
        gpu: { base_url: "http://gpu.lan/v1" },
        "two words": { name: "Two", base_url: "https://two.example/v1" },
      },
      hooks: { items: [{ name: "first" }, { name: "second", detail: { on: true } }] },
    });
  });

  it("reads every string form and escape", () => {
    const config = parseCodexConfigToml([
      "basic = \"tab\\there \\u00e9 \\U0001F600 \\\"q\\\"\"",
      "literal = 'C:\\Users\\me'",
      "multi = \"\"\"",
      "one \\",
      "    two\"\"\"\"",
      "raw = '''",
      "keep \\n as is'''",
      "after = 1",
    ].join("\n"));
    expect(config.basic).toBe("tab\there \u00e9 \u{1F600} \"q\"");
    expect(config.literal).toBe("C:\\Users\\me");
    expect(config.multi).toBe("one two\"");
    expect(config.raw).toBe("keep \\n as is");
    expect(config.after).toBe(1);
  });

  it("reads numbers, booleans and dates", () => {
    const config = parseCodexConfigToml([
      "hex = 0xff",
      "octal = 0o17",
      "binary = 0b101",
      "float = -1.5e3",
      "big = inf",
      "on = true",
      "day = 1979-05-27",
      "stamp = 1979-05-27 07:32:00Z",
      "offset = 1979-05-27T00:32:00-07:00",
    ].join("\n"));
    expect(plain(config)).toEqual({
      hex: 255,
      octal: 15,
      binary: 5,
      float: -1500,
      big: null,
      on: true,
      day: "1979-05-27",
      stamp: "1979-05-27 07:32:00Z",
      offset: "1979-05-27T00:32:00-07:00",
    });
    expect(config.big).toBe(Infinity);
  });

  it("treats __proto__ as an ordinary key", () => {
    const config = parseCodexConfigToml("[__proto__]\npolluted = true\n");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(config)).toEqual(["__proto__"]);
  });

  it.each([
    ["model = ", 1],
    ["a = 1\nb = \"unterminated", 2],
    ["a = 1 b = 2", 1],
    ["a = 1\na = 2", 2],
    ["a = 1\n[a]", 2],
    ["x = nope", 1],
    ["[unclosed", 1],
  ])("reports the line of %j", (source, line) => {
    let thrown: unknown;
    try {
      parseCodexConfigToml(source);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CodexConfigTomlError);
    expect((thrown as CodexConfigTomlError).line).toBe(line);
  });
});
