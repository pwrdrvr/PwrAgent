import { describe, expect, it, vi } from "vitest";
import { resolveContact } from "../resolve-contact.ts";

describe("Telegram resolveContact", () => {
  it("formats user names from getChat", async () => {
    const bot = {
      api: {
        getChat: vi.fn(async () => ({
          first_name: "Harold",
          last_name: "Hunt",
          type: "private",
          username: "huntharo",
        })),
      },
    };

    const result = await resolveContact(
      { botToken: "12345:abcdef" },
      { id: "8460800771", kind: "user" },
      { bot },
    );

    expect(result).toMatchObject({
      status: "ok",
      id: "8460800771",
      displayName: "Harold Hunt (@huntharo)",
      handle: "@huntharo",
      detail: "private",
    });
    expect(bot.api.getChat).toHaveBeenCalledExactlyOnceWith("8460800771");
  });

  it("returns unset without a bot token", async () => {
    const result = await resolveContact(
      { botToken: "" },
      { id: "8460800771", kind: "user" },
    );

    expect(result).toEqual({ status: "unset", id: "8460800771" });
  });
});
