import type { BackendModelOption } from "@pwragent/shared";

export type BackendModelCatalogBackend = "codex" | "grok";

export type BackendModelCatalogCallerReason =
  | "backend-summary"
  | "launchpad-defaults"
  | "thread-start-defaults"
  | "settings-refresh"
  | (string & {});

export type BackendModelCatalogClient = {
  listModels?(diagnostics?: {
    callerReason?: string;
    ownerId?: string;
  }): Promise<BackendModelOption[]>;
};

type ModelState = {
  models?: BackendModelOption[];
  promise?: Promise<BackendModelOption[]>;
};

let catalogSequence = 0;

export class BackendModelCatalog {
  private readonly ownerId = `backend-model-catalog-${++catalogSequence}`;
  private readonly states: Record<BackendModelCatalogBackend, ModelState> = {
    codex: {},
    grok: {},
  };

  constructor(
    private readonly clients: Record<BackendModelCatalogBackend, BackendModelCatalogClient>,
  ) {}

  readModels(
    backend: BackendModelCatalogBackend,
    callerReason: BackendModelCatalogCallerReason,
  ): Promise<BackendModelOption[]> {
    const state = this.states[backend];
    if (state.models) {
      return Promise.resolve(state.models);
    }
    if (state.promise) {
      return state.promise;
    }

    const client = this.clients[backend];
    if (!client.listModels) {
      state.models = [];
      return Promise.resolve(state.models);
    }

    state.promise = client
      .listModels({
        callerReason,
        ownerId: this.ownerId,
      })
      .then((models) => {
        state.models = models;
        state.promise = undefined;
        return models;
      })
      .catch((error) => {
        state.promise = undefined;
        throw error;
      });

    return state.promise;
  }

  invalidate(backend?: BackendModelCatalogBackend): void {
    if (backend) {
      this.states[backend] = {};
      return;
    }

    this.states.codex = {};
    this.states.grok = {};
  }
}
