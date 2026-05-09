import { beforeEach, describe, expect, it, vi } from "vitest";

const authTestMock = vi.fn();
const usersInfoMock = vi.fn();

vi.mock("@slack/web-api", () => {
  class MockWebClient {
    auth = {
      test: authTestMock,
    };
    users = {
      info: usersInfoMock,
    };

    constructor(readonly token: string) {}
  }

  return {
    WebClient: MockWebClient,
  };
});

vi.mock("@slack/socket-mode", () => ({
  SocketModeClient: class MockSocketModeClient {},
}));

import { resolveContact } from "../resolve-contact.ts";

beforeEach(() => {
  authTestMock.mockReset();
  usersInfoMock.mockReset();
});

describe("Slack resolveContact", () => {
  it("formats user names from users.info", async () => {
    usersInfoMock.mockResolvedValue({
      user: {
        id: "U079K80HTGS",
        name: "hhunt",
        profile: {
          display_name: "Harold Hunt",
          real_name: "Harold",
        },
      },
    });

    const result = await resolveContact(
      { botToken: "xoxb-token" },
      { id: "U079K80HTGS", kind: "user" },
    );

    expect(result).toMatchObject({
      status: "ok",
      id: "U079K80HTGS",
      displayName: "Harold Hunt",
      handle: "@hhunt",
      detail: "user",
    });
    expect(usersInfoMock).toHaveBeenCalledExactlyOnceWith({
      user: "U079K80HTGS",
    });
  });

  it("resolves the configured workspace through auth.test", async () => {
    authTestMock.mockResolvedValue({
      team: "PwrDrvr",
      team_id: "T012ABCDEF0",
    });

    const result = await resolveContact(
      { botToken: "xoxb-token" },
      { id: "T012ABCDEF0", kind: "workspace" },
    );

    expect(result).toMatchObject({
      status: "ok",
      id: "T012ABCDEF0",
      displayName: "PwrDrvr",
      detail: "workspace",
    });
    expect(authTestMock).toHaveBeenCalledOnce();
  });

  it("does not label a different workspace as found", async () => {
    authTestMock.mockResolvedValue({
      team: "PwrDrvr",
      team_id: "T012ABCDEF0",
    });

    const result = await resolveContact(
      { botToken: "xoxb-token" },
      { id: "TOTHER12345", kind: "workspace" },
    );

    expect(result).toMatchObject({
      status: "not_found",
      id: "TOTHER12345",
    });
  });
});
