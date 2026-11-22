import { randomUUID } from "node:crypto";
import { HTTPFetchError, messagingApi } from "@line/bot-sdk";
import type { MessagingProviderSetupStore } from "@pwragent/messaging-interface";
import { validateLineUserId } from "./validate-ids.ts";

export type LineRichMenuDefault =
  | { kind: "empty" }
  | { kind: "administrator" }
  | { kind: "api"; id: string };

export type LineRichMenuApi = {
  accountId(): Promise<string>;
  getDefault(): Promise<LineRichMenuDefault>;
  list(): Promise<{ id: string; name: string }[]>;
  create(menu: messagingApi.RichMenuRequest): Promise<string>;
  upload(id: string, image: Blob): Promise<void>;
  setDefault(id: string): Promise<void>;
  delete(id: string): Promise<void>;
};

type OwnedMenu = { id: string; revision: string };
type StagedMenu = { name: string; revision: string; id?: string };

export type LineRichMenuOwnership = {
  active?: OwnedMenu;
  staged?: StagedMenu;
};

export type LineRichMenuDesign = {
  revision: string;
  menu: Omit<messagingApi.RichMenuRequest, "name">;
  image: Blob;
};

export type LineRichMenuStatus =
  | { kind: "blocked"; reason: "administrator" | "different-menu"; cleanupRequired: boolean }
  | { kind: "available"; cleanupRequired: boolean }
  | { kind: "installed"; revision: string; updateAvailable: boolean; cleanupRequired: boolean };

export class LineRichMenuSetupError extends Error {
  constructor(readonly code: "administrator" | "busy" | "different-menu" | "changed" | "recovery-required" | "request-failed" | "rolled-back") {
    super(`LINE rich menu setup: ${code}`);
  }
}

// An explicit rejection from the create endpoint means there is no candidate to recover.
class CreateRejected extends Error {}

type SaveOwnership = (next: LineRichMenuOwnership) => Promise<void>;
type MutationScope = { save: SaveOwnership; assertCurrent: () => void };

export class LineRichMenuSetup {
  constructor(
    private readonly api: LineRichMenuApi,
    private readonly store: MessagingProviderSetupStore<LineRichMenuOwnership>,
    private readonly design: LineRichMenuDesign,
  ) {}

  async inspect(): Promise<LineRichMenuStatus & { accountId: string }> {
    const accountId = await this.api.accountId();
    return await this.store.withAccount(accountId, async (state) => {
      return { ...this.status(await this.api.getDefault(), state), accountId };
    });
  }

  async install(expectedAccountId: string): Promise<void> {
    const accountId = await this.verifyAccount(expectedAccountId);
    await this.store.withAccount(accountId, async (record, save, assertCurrent) => {
      const scope = { save, assertCurrent };
      const { state, current } = await this.prepare(record, scope);
      if (current.kind === "api" && state.active?.revision === this.design.revision) return;

      let staged: StagedMenu = { name: `PwrAgent setup ${randomUUID()}`, revision: this.design.revision };
      await save({ ...state, staged });
      try {
        assertCurrent();
        const id = await this.api.create({ ...this.design.menu, name: staged.name });
        staged = { ...staged, id };
        await save({ ...state, staged });
        assertCurrent();
        await this.api.upload(id, this.design.image);
        // LINE's set-default endpoint is unconditional. Read as close as possible to the write.
        if (!sameDefault(current, await this.api.getDefault())) throw new LineRichMenuSetupError("changed");
        assertCurrent();
        await this.api.setDefault(id);
      } catch (error) {
        if (error instanceof CreateRejected) {
          await save(state);
        } else if (await this.finishStaged(state, staged, scope)) {
          // The activation response can be lost after LINE commits it.
          return;
        }
        throw error instanceof LineRichMenuSetupError ? error : new LineRichMenuSetupError("rolled-back");
      }
      if (!await this.finishStaged(state, staged, scope)) throw new LineRichMenuSetupError("changed");
    });
  }

  async remove(expectedAccountId: string): Promise<void> {
    const accountId = await this.verifyAccount(expectedAccountId);
    await this.store.withAccount(accountId, async (record, save, assertCurrent) => {
      const { state } = await this.prepare(record, { save, assertCurrent }, "remove");
      if (!state.active) return;
      // The account-wide clear endpoint could clear a different menu after our read.
      assertCurrent();
      await this.api.delete(state.active.id);
      await save({});
    });
  }

  private async verifyAccount(expectedAccountId: string): Promise<string> {
    const accountId = await this.api.accountId();
    if (accountId !== expectedAccountId) throw new LineRichMenuSetupError("changed");
    return accountId;
  }

  private async prepare(record: LineRichMenuOwnership, scope: MutationScope, action: "install" | "remove" = "install") {
    let current = await this.api.getDefault();
    if (action === "install" || (!record.active && !record.staged)) this.assertManageable(current, record);
    if (!record.staged) return { state: record, current };

    const active = await this.finishStaged(record, record.staged, scope);
    const state = { active: active ?? record.active };
    current = await this.api.getDefault();
    if (action === "install") this.assertManageable(current, state);
    return { state, current };
  }

  private async finishStaged(
    state: LineRichMenuOwnership, staged: StagedMenu, { save, assertCurrent }: MutationScope,
  ): Promise<OwnedMenu | undefined> {
    try {
      // Create lacks a retry key. The durable, random name identifies its result
      // if the response was lost before LINE returned the assigned ID.
      const id = staged.id ?? await this.findStagedId(staged.name);
      if (id === undefined) {
        await save({ active: state.active });
        return undefined;
      }
      const current = await this.api.getDefault();
      assertCurrent();
      if (current.kind === "api" && current.id === id) {
        const active = { id, revision: staged.revision };
        if (state.active && state.active.id !== id) await this.api.delete(state.active.id);
        await save({ active });
        return active;
      }
      await this.api.delete(id);
      await save({ active: state.active });
      return undefined;
    } catch {
      throw new LineRichMenuSetupError("recovery-required");
    }
  }

  private async findStagedId(name: string): Promise<string | undefined> {
    const matches = (await this.api.list()).filter((menu) => menu.name === name);
    if (matches.length > 1) throw new LineRichMenuSetupError("recovery-required");
    return matches[0]?.id;
  }

  private assertManageable(current: LineRichMenuDefault, state: LineRichMenuOwnership): void {
    const status = this.status(current, state);
    if (status.kind === "blocked") throw new LineRichMenuSetupError(status.reason);
  }

  private status(current: LineRichMenuDefault, state: LineRichMenuOwnership): LineRichMenuStatus {
    const cleanupRequired = Boolean(state.active || state.staged);
    if (current.kind === "administrator") return { kind: "blocked", reason: "administrator", cleanupRequired };
    if (current.kind === "empty") return { kind: "available", cleanupRequired };
    const owned = current.id === state.active?.id ? state.active
      : current.id === state.staged?.id ? state.staged : undefined;
    return owned
      ? { kind: "installed", revision: owned.revision, updateAvailable: owned.revision !== this.design.revision, cleanupRequired: Boolean(state.staged) }
      : { kind: "blocked", reason: "different-menu", cleanupRequired };
  }
}

function sameDefault(left: LineRichMenuDefault, right: LineRichMenuDefault): boolean {
  return left.kind === right.kind && (left.kind !== "api" || (right.kind === "api" && left.id === right.id));
}

function checkedRichMenuId(id: unknown): string {
  if (typeof id !== "string" || id.length !== 41 || !/^richmenu-[0-9a-f]{32}$/.test(id)) {
    throw new LineRichMenuSetupError("request-failed");
  }
  return id;
}

export function readLineRichMenuOwnership(raw: string | undefined): LineRichMenuOwnership {
  if (raw === undefined) return {};
  const record = ownershipObject(JSON.parse(raw));
  const result: LineRichMenuOwnership = {};
  if (record.active !== undefined) {
    const active = ownershipObject(record.active);
    result.active = { id: checkedRichMenuId(active.id), revision: ownershipString(active.revision) };
  }
  if (record.staged !== undefined) {
    const staged = ownershipObject(record.staged);
    result.staged = {
      name: ownershipString(staged.name),
      revision: ownershipString(staged.revision),
      ...(staged.id === undefined ? {} : { id: checkedRichMenuId(staged.id) }),
    };
  }
  return result;
}

function ownershipObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LineRichMenuSetupError("recovery-required");
  }
  return value as Record<string, unknown>;
}

function ownershipString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new LineRichMenuSetupError("recovery-required");
  return value;
}

export function createLineRichMenuApi(channelAccessToken: string): LineRichMenuApi {
  const client = new messagingApi.MessagingApiClient({ channelAccessToken });
  const blobClient = new messagingApi.MessagingApiBlobClient({ channelAccessToken });
  return {
    async accountId() {
      const { userId } = await client.getBotInfo();
      if (!validateLineUserId(userId).ok) throw new LineRichMenuSetupError("request-failed");
      return userId;
    },
    async getDefault() {
      try {
        const response = await client.getDefaultRichMenuId();
        return { kind: "api", id: checkedRichMenuId(response.richMenuId) };
      } catch (error) {
        if (error instanceof HTTPFetchError && error.status === 403) return { kind: "administrator" };
        if (error instanceof HTTPFetchError && error.status === 404) return { kind: "empty" };
        throw error;
      }
    },
    async list() {
      const response = await client.getRichMenuList();
      return response.richmenus.map((menu) => ({ id: checkedRichMenuId(menu.richMenuId), name: menu.name }));
    },
    async create(menu) {
      try {
        const response = await client.createRichMenu(menu);
        return checkedRichMenuId(response.richMenuId);
      } catch (error) {
        if (error instanceof HTTPFetchError && [400, 401, 403, 429].includes(error.status)) {
          throw new CreateRejected();
        }
        throw error;
      }
    },
    async upload(id, image) { await blobClient.setRichMenuImage(checkedRichMenuId(id), image); },
    async setDefault(id) { await client.setDefaultRichMenu(checkedRichMenuId(id)); },
    async delete(id) {
      try {
        await client.deleteRichMenu(checkedRichMenuId(id));
      } catch (error) {
        if (!(error instanceof HTTPFetchError && error.status === 404)) throw error;
      }
    },
  };
}
