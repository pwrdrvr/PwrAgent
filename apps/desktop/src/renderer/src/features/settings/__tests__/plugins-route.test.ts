import { describe, expect, it } from "vitest";
import { pluginsConnectionRoute, pluginsRouteConnectionId } from "../plugins-route";

describe("Plugins connection routes", () => {
  it("names a connection and reads it back, colons and all", () => {
    expect(pluginsRouteConnectionId(pluginsConnectionRoute("builtin:boat"))).toBe("builtin:boat");
  });

  it("reads no connection from a section route or an empty one", () => {
    expect(pluginsRouteConnectionId("managed-mcp-connections")).toBeUndefined();
    expect(pluginsRouteConnectionId("connection:")).toBeUndefined();
    expect(pluginsRouteConnectionId(undefined)).toBeUndefined();
  });
});
