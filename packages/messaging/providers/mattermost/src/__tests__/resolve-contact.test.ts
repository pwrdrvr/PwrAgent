import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContact } from "../resolve-contact.ts";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
});

describe("Mattermost resolveContact", () => {
  it("formats user names from the REST API", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "user-1",
          username: "huntharo",
          first_name: "Harold",
          last_name: "Hunt",
        }),
        { status: 200 },
      ),
    );

    const result = await resolveContact(
      {
        botToken: "token",
        serverUrl: "https://chat.example.com",
      },
      { id: "user-1", kind: "user" },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(result).toMatchObject({
      status: "ok",
      id: "user-1",
      displayName: "Harold Hunt (@huntharo)",
      handle: "@huntharo",
      detail: "user",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://chat.example.com/api/v4/users/user-1");
    expect(init.headers.Authorization).toBe("Bearer token");
  });

  it("returns unset without complete connection settings", async () => {
    const result = await resolveContact(
      { botToken: "", serverUrl: "https://chat.example.com" },
      { id: "user-1", kind: "user" },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(result).toEqual({ status: "unset", id: "user-1" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
