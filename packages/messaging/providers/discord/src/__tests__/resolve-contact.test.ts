import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const setTokenMock = vi.fn();

vi.mock("discord.js", () => {
  class MockREST {
    setToken(token: string) {
      setTokenMock(token);
      return this;
    }
    get(route: string) {
      return getMock(route);
    }
  }
  return {
    REST: MockREST,
    Routes: {
      guild: (id: string) => `/guilds/${id}`,
      user: (id: string) => `/users/${id}`,
    },
  };
});

import { resolveContact } from "../resolve-contact.ts";

beforeEach(() => {
  getMock.mockReset();
  setTokenMock.mockReset();
});

describe("Discord resolveContact", () => {
  it("formats user names from the REST API", async () => {
    getMock.mockResolvedValue({
      id: "1177378744822943744",
      username: "huntharo",
      global_name: "Harold",
      discriminator: "0",
    });

    const result = await resolveContact(
      { botToken: "BotTokenABC" },
      { id: "1177378744822943744", kind: "user" },
    );

    expect(result).toMatchObject({
      status: "ok",
      id: "1177378744822943744",
      displayName: "Harold (@huntharo)",
      handle: "@huntharo",
      detail: "user",
    });
    expect(setTokenMock).toHaveBeenCalledExactlyOnceWith("BotTokenABC");
    expect(getMock).toHaveBeenCalledExactlyOnceWith(
      "/users/1177378744822943744",
    );
  });

  it("resolves guild names from the REST API", async () => {
    getMock.mockResolvedValue({
      id: "1480554271907905731",
      name: "PwrAgent Ops",
    });

    const result = await resolveContact(
      { botToken: "BotTokenABC" },
      { id: "1480554271907905731", kind: "guild" },
    );

    expect(result).toMatchObject({
      status: "ok",
      displayName: "PwrAgent Ops",
      detail: "guild",
    });
    expect(getMock).toHaveBeenCalledExactlyOnceWith(
      "/guilds/1480554271907905731",
    );
  });
});
