import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagingProviderSetupStore } from "@pwragent/messaging-interface";
import { LINE_RICH_MENU_LAYOUT } from "../line-rich-menu-design.ts";
import {
  createLineRichMenuApi,
  LineRichMenuSetup,
  type LineRichMenuApi,
  type LineRichMenuDefault,
  type LineRichMenuOwnership,
} from "../line-rich-menu.ts";

type Mutation = "create" | "upload" | "setDefault" | "clearDefault" | "delete";

function fixture() {
  const menus = new Map<string, { name: string; image: boolean }>();
  const mutations: Mutation[] = [];
  const state = new Map<string, LineRichMenuOwnership>();
  const empty: LineRichMenuDefault = { kind: "empty" };
  let current: LineRichMenuDefault = empty;
  let serial = 0;
  let fault: { type: Mutation; afterCommit: boolean } | undefined;
  let afterUpload: (() => void) | undefined;
  let accountId = "account-a";
  const store: MessagingProviderSetupStore<LineRichMenuOwnership> = {
    async withAccount(id, run) {
      return await run(state.get(id) ?? {}, async (next) => { state.set(id, next); }, () => {});
    },
  };
  function mutate<Result>(type: Mutation, apply: () => Result): Result {
    mutations.push(type);
    const injection = fault?.type === type ? fault : undefined;
    if (injection) fault = undefined;
    if (injection && !injection.afterCommit) throw new Error("LINE request failed");
    const result = apply();
    if (injection?.afterCommit) throw new Error("LINE response lost");
    return result;
  }
  const api: LineRichMenuApi = {
    async accountId() { return accountId; },
    async getDefault() { return current; },
    async list() { return [...menus].map(([id, { name }]) => ({ id, name })); },
    async create(menu) {
      return mutate("create", () => {
        const id = `menu-${++serial}`;
        menus.set(id, { name: menu.name ?? "", image: false });
        return id;
      });
    },
    async upload(id) {
      mutate("upload", () => {
        menus.get(id)!.image = true;
        afterUpload?.();
      });
    },
    async setDefault(id) {
      mutate("setDefault", () => {
        if (!menus.get(id)?.image) throw new Error("LINE requires an uploaded image");
        current = { kind: "api", id };
      });
    },
    async clearDefault() {
      mutate("clearDefault", () => { current = empty; });
    },
    async delete(id) {
      mutate("delete", () => {
        if (current.kind === "api" && current.id === id) throw new Error("Deleting a visible menu");
        menus.delete(id);
      });
    },
  };
  return {
    setup(revision = "v1") {
      const setup = new LineRichMenuSetup(api, store, { revision, menu: {}, image: new Blob() });
      const expectedAccountId = accountId;
      return {
        inspect: () => setup.inspect(),
        install: () => setup.install(expectedAccountId),
        remove: () => setup.remove(expectedAccountId),
      };
    },
    setCurrent: (next: LineRichMenuDefault) => { current = next; },
    setAccount: (next: string) => { accountId = next; },
    fail: (type: Mutation, afterCommit: boolean) => { fault = { type, afterCommit }; },
    onUpload: (callback: () => void) => { afterUpload = callback; },
    current: () => current,
    state: () => state.get(accountId),
    menus,
    mutations,
  };
}

describe("LINE rich-menu ownership", () => {
  it("uses the approved image and maps its whole surface to the five existing commands", () => {
    const image = readFileSync(new URL("../../assets/pwragent-line-rich-menu.png", import.meta.url));
    expect(image.length).toBeLessThan(1_000_000);
    expect(createHash("sha256").update(image).digest("hex")).toBe("9356732cdcacfc7c3c1476483cdb31435d58f106cef7f22479d4d872eaf96bd0");
    expect(LINE_RICH_MENU_LAYOUT.size).toEqual({ width: image.readUInt32BE(16), height: image.readUInt32BE(20) });
    expect(LINE_RICH_MENU_LAYOUT.areas?.map(({ action }) => action)).toEqual([
      { type: "message", label: "Resume", text: "/resume" },
      { type: "message", label: "New thread", text: "/resume --new" },
      { type: "message", label: "Status", text: "/status" },
      { type: "message", label: "Detach", text: "/detach" },
      { type: "message", label: "Help", text: "/help" },
    ]);
    const bounds = (LINE_RICH_MENU_LAYOUT.areas ?? []).map((area) => area.bounds);
    let y = 0;
    for (const top of new Set(bounds.map((cell) => cell.y))) {
      expect(top).toBe(y);
      const row = bounds.filter((cell) => cell.y === top);
      const rowHeight = row[0]?.height ?? 0;
      let x = 0;
      for (const cell of row) {
        expect(cell.x).toBe(x);
        expect(cell.height).toBe(rowHeight);
        x += cell.width;
      }
      expect(x).toBe(image.readUInt32BE(16));
      y += rowHeight;
    }
    expect(y).toBe(image.readUInt32BE(20));
  });

  it("performs no mutations while an Official Account Manager or unowned API menu is default", async () => {
    await fc.assert(fc.asyncProperty(
      fc.boolean(), fc.array(fc.constantFrom("inspect", "install", "remove"), { minLength: 1 }),
      async (administrator, actions) => {
        const line = fixture();
        const original: LineRichMenuDefault = administrator
          ? { kind: "administrator" }
          : { kind: "api", id: "external" };
        line.setCurrent(original);
        const setup = line.setup();
        for (const action of actions) {
          if (action === "inspect") expect(await setup.inspect()).toMatchObject({ kind: "blocked" });
          else await expect(setup[action]()).rejects.toThrow();
          expect(line.current()).toEqual(original);
          expect(line.mutations).toEqual([]);
        }
      },
    ));
  });

  it("converges to one owned default for the current revision or to no owned menu after removal", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.oneof(fc.constant(null), fc.constantFrom("v1", "v2", "v3")), { minLength: 1 }),
      async (revisions) => {
        const line = fixture();
        for (const revision of revisions) {
          const before = line.current();
          const setup = line.setup(revision ?? "v1");
          if (revision === null) {
            await setup.remove();
            expect(line.current()).toEqual({ kind: "empty" });
            expect(line.menus.size).toBe(0);
          } else {
            const wasCurrent = line.state()?.active?.revision === revision;
            await setup.install();
            expect(line.current()).toEqual({ kind: "api", id: line.state()?.active?.id });
            expect(line.state()?.active?.revision).toBe(revision);
            expect(line.menus.size).toBe(1);
            if (wasCurrent) expect(line.current()).toEqual(before);
          }
          expect(line.state()?.staged).toBeUndefined();
        }
      },
    ));
  });

  it("preserves the old default unless activation committed and rolls back incomplete candidates", async () => {
    await fc.assert(fc.asyncProperty(
      fc.boolean(), fc.constantFrom("create", "upload", "setDefault"), fc.boolean(),
      async (updating, failingCall, afterCommit) => {
        const line = fixture();
        if (updating) await line.setup("v1").install();
        const before = line.current();
        line.fail(failingCall, afterCommit);
        const install = line.setup("v2").install();
        if (failingCall === "setDefault" && afterCommit) {
          await install;
          expect(line.current()).toEqual({ kind: "api", id: line.state()?.active?.id });
          expect(line.current()).not.toEqual(before);
          expect(line.menus.size).toBe(1);
        } else {
          await expect(install).rejects.toThrow();
          expect(line.current()).toEqual(before);
          expect(line.menus.size).toBe(updating ? 1 : 0);
        }
      },
    ));
  });

  it("rechecks the shared default after uploading and rolls back when an administrator intervenes", async () => {
    const line = fixture();
    const administrator = { kind: "administrator" } as const;
    line.onUpload(() => line.setCurrent(administrator));
    await expect(line.setup().install()).rejects.toThrow();
    expect(line.current()).toEqual(administrator);
    expect(line.mutations).toEqual(["create", "upload", "delete"]);
    expect(line.menus.size).toBe(0);
  });

  it("keeps a committed replacement and retries cleanup after restarting", async () => {
    const line = fixture();
    await line.setup("v1").install();
    line.fail("delete", false);
    await expect(line.setup("v2").install()).rejects.toThrow();
    const committed = line.current();
    expect(line.state()?.staged).toBeDefined();
    expect(line.menus.size).toBe(2);
    await line.setup("v2").install();
    expect(line.current()).toEqual(committed);
    expect(line.menus.size).toBe(1);
  });

  it("scopes ownership to the authenticated bot account", async () => {
    const line = fixture();
    const oldSetup = line.setup();
    await oldSetup.install();
    const original = line.current();
    line.setAccount("account-b");
    await expect(oldSetup.remove()).rejects.toMatchObject({ code: "changed" });
    await expect(line.setup().remove()).rejects.toThrow();
    expect(line.current()).toEqual(original);
  });

  it("deletes a superseded owned menu by ID while preserving an external default", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (administrator) => {
      const line = fixture();
      const setup = line.setup();
      await setup.install();
      const external: LineRichMenuDefault = administrator
        ? { kind: "administrator" }
        : { kind: "api", id: "external" };
      line.setCurrent(external);
      const mutationCount = line.mutations.length;
      expect(await setup.inspect()).toMatchObject({ kind: "blocked", cleanupRequired: true });
      await setup.remove();
      expect(line.current()).toEqual(external);
      expect(line.menus.size).toBe(0);
      expect(line.mutations.slice(mutationCount)).toEqual(["delete"]);
    }));
  });

  it("resumes removal after a failed clear or delete and preserves the ID until deletion is confirmed", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("clearDefault", "delete"), fc.boolean(),
      async (failingCall, afterCommit) => {
        const line = fixture();
        await line.setup().install();
        const original = line.state()?.active;
        line.fail(failingCall, afterCommit);
        const remove = line.setup().remove();
        if (failingCall === "clearDefault" && afterCommit) {
          await remove;
        } else {
          await expect(remove).rejects.toThrow();
          expect(line.state()?.active).toEqual(original);
        }
        await line.setup().remove();
        expect(line.current()).toEqual({ kind: "empty" });
        expect(line.menus.size).toBe(0);
        expect(line.state()).toEqual({});
      },
    ));
  });
});

describe("LINE rich-menu SDK transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("distinguishes an empty default from an administrator default and an authentication error", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(Response.json({}, { status: 403 }))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const api = createLineRichMenuApi("contrived-access-token");
    await expect(api.getDefault()).resolves.toEqual({ kind: "empty" });
    await expect(api.getDefault()).resolves.toEqual({ kind: "administrator" });
    await expect(api.getDefault()).rejects.toMatchObject({ status: 401 });
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.line.me/v2/bot/user/all/richmenu");
    expect(options.headers.authorization).toBe("Bearer contrived-access-token");
  });

  it("uses the LINE content host for the image and the Messaging API host for assignment", async () => {
    const id = `richmenu-${"b".repeat(32)}`;
    const image = new Blob(["contrived image bytes"], { type: "image/png" });
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetch);
    const api = createLineRichMenuApi("contrived-access-token");
    await api.upload(id, image);
    await api.setDefault(id);
    expect(fetch).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ href: `https://api-data.line.me/v2/bot/richmenu/${id}/content` }),
      expect.objectContaining({ method: "POST", body: image }),
    );
    expect(fetch).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ href: `https://api.line.me/v2/bot/user/all/richmenu/${id}` }),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
