import { replacementPages, type FederationReplacementPage } from "./federation-replacement-pages";

export type FederationBootstrapCursor = {
  protocol: 1;
  generation?: string;
  nextPage?: number;
};

/** One bounded immutable baseline, shared by subscribers, never persisted. */
export class FederationMergeBootstrap<T> {
  private epoch = 0;
  private cached?: { expiresAt: number; pages: FederationReplacementPage<T>[] };
  private inFlight?: Promise<FederationReplacementPage<T>[]>;

  invalidate(): void {
    this.epoch += 1;
    this.cached = undefined;
    this.inFlight = undefined;
  }

  async read(
    load: () => Promise<T[]>,
    cursor: FederationBootstrapCursor,
    now = Date.now(),
  ): Promise<FederationReplacementPage<T>[]> {
    let pages = this.cached && now < this.cached.expiresAt ? this.cached.pages : undefined;
    if (!pages) {
      const epoch = this.epoch;
      if (!this.inFlight) {
        this.inFlight = load().then((entries) => {
          const loaded = replacementPages(entries);
          if (epoch === this.epoch) this.cached = { pages: loaded, expiresAt: now + 60_000 };
          return loaded;
        }).finally(() => {
          if (epoch === this.epoch) this.inFlight = undefined;
        });
      }
      pages = await this.inFlight;
    }
    const next = cursor.nextPage;
    return cursor.generation === pages[0]!.generation
      && typeof next === "number" && Number.isInteger(next) && next >= 0 && next <= pages.length
      ? pages.slice(next)
      : pages;
  }
}
