import { describe, expect, it } from "vitest";
import { ThreadInfoStore } from "../app-server/thread-info-store";

const local = (threadId: string) => ({ backend: "codex" as const, threadId });

function storeWithTitle(title = "Known name"): ThreadInfoStore {
  const store = new ThreadInfoStore();
  store.observe({
    identity: local("t1"),
    observationSequence: store.reserveObservationSequence(),
    source: "provider-list",
    title,
    titleSource: "explicit",
  });
  return store;
}

describe("ThreadInfoStore", () => {
  describe("unknown is distinguishable from unobserved", () => {
    it("returns undefined for a thread it has never seen", () => {
      expect(new ThreadInfoStore().get(local("never-seen"))).toBeUndefined();
    });

    it("returns undefined rather than guessing from another backend", () => {
      const store = new ThreadInfoStore();
      store.observe({
        identity: { backend: "codex", threadId: "shared-id" },
        observationSequence: store.reserveObservationSequence(),
        source: "provider-list",
        title: "Codex thread",
        titleSource: "explicit",
      });
      expect(store.getTitle({ backend: "acp:claude-code", threadId: "shared-id" }))
        .toBeUndefined();
    });

    it("returns undefined rather than guessing across instances", () => {
      const store = new ThreadInfoStore();
      store.observe({
        identity: { backend: "codex", instanceId: "peer-a", threadId: "shared-id" },
        observationSequence: store.reserveObservationSequence(),
        source: "remote-navigation",
        title: "Peer A thread",
        titleSource: "explicit",
      });
      expect(store.getTitle({ backend: "codex", instanceId: "peer-b", threadId: "shared-id" }))
        .toBeUndefined();
      expect(store.getTitle(local("shared-id"))).toBeUndefined();
      expect(store.getTitle({ backend: "codex", instanceId: "peer-a", threadId: "shared-id" }))
        .toBe("Peer A thread");
    });
  });

  describe("a known title cannot be downgraded", () => {
    it("ignores an observation that omits the title", () => {
      const store = storeWithTitle();
      store.observe({
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        source: "provider-list",
        updatedAt: 42,
      });
      expect(store.getTitle(local("t1"))).toBe("Known name");
      expect(store.get(local("t1"))?.updatedAt).toBe(42);
    });

    it("ignores an empty title", () => {
      const store = storeWithTitle();
      store.observe({
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        source: "provider-list",
        title: "   ",
        titleSource: "explicit",
      });
      expect(store.getTitle(local("t1"))).toBe("Known name");
    });

    it("ignores a fallback title even when it is newer", () => {
      const store = storeWithTitle();
      store.observe({
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        source: "provider-list",
        title: "t1",
        titleSource: "fallback",
      });
      expect(store.getTitle(local("t1"))).toBe("Known name");
      expect(store.get(local("t1"))?.titleSource).toBe("explicit");
    });

    it("ignores a fallback source arriving without its title", () => {
      const store = storeWithTitle();
      store.observe({
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        source: "provider-list",
        titleSource: "fallback",
      });
      expect(store.get(local("t1"))?.titleSource).toBe("explicit");
    });
  });

  describe("a newer positive observation wins", () => {
    it("accepts an explicit rename over a provider title", () => {
      const store = storeWithTitle();
      store.observe({
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        source: "local-rename",
        title: "Operator's name",
        titleSource: "explicit",
      });
      expect(store.getTitle(local("t1"))).toBe("Operator's name");
    });

    it("accepts a derived title over an earlier derived title", () => {
      const store = new ThreadInfoStore();
      for (const title of ["First guess", "Second guess"]) {
        store.observe({
          identity: local("t1"),
          observationSequence: store.reserveObservationSequence(),
          source: "provider-list",
          title,
          titleSource: "derived",
        });
      }
      expect(store.getTitle(local("t1"))).toBe("Second guess");
    });
  });

  describe("late completions cannot revert a newer observation", () => {
    it("drops a stale list that reserved its sequence before a rename", () => {
      const store = storeWithTitle("Provider title");
      // A list starts here and reserves its place in the ordering.
      const staleListSequence = store.reserveObservationSequence();
      store.observe({
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        source: "lifecycle-notification",
        title: "Renamed while listing",
        titleSource: "explicit",
      });
      // The list finally completes, still carrying its older rows.
      store.observe({
        identity: local("t1"),
        observationSequence: staleListSequence,
        source: "provider-list",
        title: "Provider title",
        titleSource: "explicit",
      });
      expect(store.getTitle(local("t1"))).toBe("Renamed while listing");
    });

    it("lets a list started after a rename reconcile the title", () => {
      const store = new ThreadInfoStore();
      store.observe({
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        source: "lifecycle-notification",
        title: "Renamed",
        titleSource: "explicit",
      });
      const freshListSequence = store.reserveObservationSequence();
      store.observe({
        identity: local("t1"),
        observationSequence: freshListSequence,
        source: "provider-list",
        title: "Server agrees, with an edit",
        titleSource: "explicit",
      });
      expect(store.getTitle(local("t1"))).toBe("Server agrees, with an edit");
    });

    it("orders per field, so a stale title cannot block a newer archived flag", () => {
      const store = storeWithTitle();
      const staleSequence = store.reserveObservationSequence();
      store.observe({
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        source: "lifecycle-notification",
        title: "Newer title",
        titleSource: "explicit",
      });
      store.observe({
        identity: local("t1"),
        observationSequence: staleSequence,
        source: "provider-list",
        archived: true,
        title: "Older title",
        titleSource: "explicit",
      });
      expect(store.getTitle(local("t1"))).toBe("Newer title");
      expect(store.get(local("t1"))?.archived).toBe(true);
    });
  });

  describe("change reporting", () => {
    it("reports only the fields an observation actually changed", () => {
      const store = storeWithTitle();
      expect(
        store.observe({
          identity: local("t1"),
          observationSequence: store.reserveObservationSequence(),
          source: "provider-list",
          title: "Known name",
          titleSource: "explicit",
          updatedAt: 7,
        }),
      ).toEqual(["updatedAt"]);
    });

    it("reports nothing when a refresh only confirms what is known", () => {
      const store = storeWithTitle();
      expect(
        store.observe({
          identity: local("t1"),
          observationSequence: store.reserveObservationSequence(),
          source: "provider-list",
          title: "Known name",
          titleSource: "explicit",
        }),
      ).toEqual([]);
    });
  });

  describe("removal is explicit", () => {
    it("forgets a single thread without touching its neighbours", () => {
      const store = storeWithTitle();
      store.observe({
        identity: local("t2"),
        observationSequence: store.reserveObservationSequence(),
        source: "provider-list",
        title: "Sibling",
        titleSource: "explicit",
      });
      store.forget(local("t1"));
      expect(store.get(local("t1"))).toBeUndefined();
      expect(store.getTitle(local("t2"))).toBe("Sibling");
    });

    it("forgets one peer's threads and keeps local and other-peer entries", () => {
      const store = new ThreadInfoStore();
      const seed = (instanceId: string | undefined, title: string) =>
        store.observe({
          identity: { backend: "codex", threadId: "t1", ...(instanceId ? { instanceId } : {}) },
          observationSequence: store.reserveObservationSequence(),
          source: instanceId ? "remote-navigation" : "provider-list",
          title,
          titleSource: "explicit",
        });
      seed(undefined, "Mine");
      seed("peer-a", "Theirs");
      seed("peer-b", "Someone else's");
      store.forgetInstance("peer-a");
      expect(store.getTitle(local("t1"))).toBe("Mine");
      expect(store.getTitle({ backend: "codex", instanceId: "peer-a", threadId: "t1" }))
        .toBeUndefined();
      expect(store.getTitle({ backend: "codex", instanceId: "peer-b", threadId: "t1" }))
        .toBe("Someone else's");
    });
  });

  describe("input hygiene", () => {
    it("ignores a blank thread id instead of creating a phantom entry", () => {
      const store = new ThreadInfoStore();
      store.observe({
        identity: local("   "),
        observationSequence: store.reserveObservationSequence(),
        source: "provider-list",
        title: "Nowhere",
        titleSource: "explicit",
      });
      expect(store.size).toBe(0);
    });

    it("matches a padded thread id to the entry it created", () => {
      const store = storeWithTitle();
      expect(store.getTitle({ backend: "codex", threadId: "  t1  " })).toBe("Known name");
    });

    it("trims stored titles", () => {
      const store = new ThreadInfoStore();
      store.observe({
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        source: "provider-list",
        title: "  Padded  ",
        titleSource: "explicit",
      });
      expect(store.getTitle(local("t1"))).toBe("Padded");
    });
  });

  describe("ordering does not read the clock", () => {
    it("issues strictly increasing sequences", () => {
      const store = new ThreadInfoStore();
      const sequences = Array.from({ length: 5 }, () =>
        store.reserveObservationSequence(),
      );
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      expect(new Set(sequences).size).toBe(sequences.length);
    });
  });
  // The store keeps two lanes: notifications write fields, listings write the
  // whole row. Handing the row back verbatim let this store answer with a
  // title it already knew was stale.
  describe("the row is reconciled with what the fields know", () => {
    const rowFor = (
      title: string,
      titleSource: "explicit" | "derived" | "fallback" = "explicit",
    ) =>
      ({
        id: "t1",
        source: "codex" as const,
        title,
        titleSource,
        linkedDirectories: [],
      }) as unknown as Parameters<ThreadInfoStore["observeSummary"]>[0]["summary"];

    function storeWithRow(title = "Old Name"): ThreadInfoStore {
      const store = new ThreadInfoStore();
      const seq = store.reserveObservationSequence();
      store.observe({
        identity: local("t1"),
        observationSequence: seq,
        source: "provider-list",
        title,
        titleSource: "explicit",
      });
      store.observeSummary({
        enriched: false,
        identity: local("t1"),
        observationSequence: seq,
        summary: rowFor(title),
      });
      return store;
    }

    it("serves a rename that arrived after the row", () => {
      const store = storeWithRow();
      store.observe({
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        source: "lifecycle-notification",
        title: "New Name",
        titleSource: "explicit",
      });

      expect(store.getTitle(local("t1"))).toBe("New Name");
      expect(store.getSummary(local("t1"))?.title).toBe("New Name");
      expect(store.findLocalSummary({ threadId: "t1" })?.title).toBe("New Name");
    });

    // A provider that lost its title index sends a newer row whose title IS
    // the thread id. The field lane already rejects it; the row must not be a
    // way around that.
    it("does not let a newer fallback row overwrite a known name", () => {
      const store = storeWithRow("Real Name");
      const seq = store.reserveObservationSequence();
      store.observe({
        identity: local("t1"),
        observationSequence: seq,
        source: "provider-list",
        title: "t1",
        titleSource: "fallback",
      });
      store.observeSummary({
        enriched: false,
        identity: local("t1"),
        observationSequence: seq,
        summary: rowFor("t1", "fallback"),
      });

      expect(store.getTitle(local("t1"))).toBe("Real Name");
      expect(store.getSummary(local("t1"))?.title).toBe("Real Name");
    });

    // Archival is membership, not a field. A caller asking for the row is
    // asking about a thread the provider still serves.
    it("stops serving a row once the thread is archived", () => {
      const store = storeWithRow();
      expect(store.getSummary(local("t1"))).toBeDefined();

      store.observe({
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        source: "lifecycle-notification",
        archived: true,
      });

      expect(store.getSummary(local("t1"))).toBeUndefined();
      expect(store.findLocalSummary({ threadId: "t1" })).toBeUndefined();
      // The name is still known — only the row is withheld.
      expect(store.getTitle(local("t1"))).toBe("Old Name");
    });

    it("serves the row again once the thread is restored", () => {
      const store = storeWithRow();
      store.observe({
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        source: "lifecycle-notification",
        archived: true,
      });
      store.observe({
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        source: "lifecycle-notification",
        archived: false,
      });

      expect(store.getSummary(local("t1"))?.id).toBe("t1");
    });

    // Enrichment is a property of the listing, not of the thread, and the
    // most frequent listing is unenriched.
    it("keeps the enriched row when a newer unenriched one arrives", () => {
      const store = new ThreadInfoStore();
      store.observeSummary({
        enriched: true,
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        summary: rowFor("Enriched"),
      });
      store.observeSummary({
        enriched: false,
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        summary: rowFor("Unenriched"),
      });

      expect(store.getSummary(local("t1"), { requireEnriched: true })?.title)
        .toBe("Enriched");
      expect(store.getSummary(local("t1"))?.title).toBe("Unenriched");
    });

    // Thread ids are unique per backend, not across them, and an ACP adapter
    // picks its own.
    it("refuses an ambiguous backend-less lookup", () => {
      const store = new ThreadInfoStore();
      for (const backend of ["codex", "acp:claude-code"] as const) {
        store.observeSummary({
          enriched: false,
          identity: { backend, threadId: "shared-id" },
          observationSequence: store.reserveObservationSequence(),
          summary: {
            ...rowFor("Either one"),
            id: "shared-id",
          },
        });
      }

      expect(store.findLocalSummary({ threadId: "shared-id" })).toBeUndefined();
      expect(
        store.findLocalSummary({ backend: "codex", threadId: "shared-id" })?.id,
      ).toBe("shared-id");
    });

    // Withholding is not absence. A second thread wearing this id is a second
    // thread whether or not this store will currently answer for it.
    it("refuses an ambiguous lookup when one match is withheld", () => {
      const store = new ThreadInfoStore();
      for (const backend of ["codex", "acp:claude-code"] as const) {
        store.observeSummary({
          enriched: false,
          identity: { backend, threadId: "shared-id" },
          observationSequence: store.reserveObservationSequence(),
          summary: { ...rowFor("Either one"), id: "shared-id" },
        });
      }
      store.observe({
        archived: true,
        identity: { backend: "acp:claude-code", threadId: "shared-id" },
        observationSequence: store.reserveObservationSequence(),
        source: "lifecycle-notification",
      });

      expect(
        store.getSummary({ backend: "acp:claude-code", threadId: "shared-id" }),
      ).toBeUndefined();
      expect(store.findLocalSummary({ threadId: "shared-id" })).toBeUndefined();
    });

    // The key joins its parts with `::` and an instance id is peer-supplied
    // text, so a prefix scan claims more than it was asked for.
    it("forgets one peer without taking a peer whose id extends it", () => {
      const store = new ThreadInfoStore();
      for (const instanceId of ["peer-a", "peer-a::b"] as const) {
        store.observe({
          identity: { backend: "codex", instanceId, threadId: "t1" },
          observationSequence: store.reserveObservationSequence(),
          source: "provider-list",
          title: `Thread on ${instanceId}`,
          titleSource: "explicit",
        });
      }

      store.forgetInstance("peer-a");

      expect(
        store.getTitle({ backend: "codex", instanceId: "peer-a", threadId: "t1" }),
      ).toBeUndefined();
      expect(
        store.getTitle({ backend: "codex", instanceId: "peer-a::b", threadId: "t1" }),
      ).toBe("Thread on peer-a::b");
    });

    // Names outlive invalidation; a resolved directory set does not.
    it("drops enriched rows on invalidation and keeps everything else", () => {
      const store = new ThreadInfoStore();
      store.observeSummary({
        enriched: true,
        identity: local("t1"),
        observationSequence: store.reserveObservationSequence(),
        summary: rowFor("Enriched"),
      });

      store.forgetEnrichedSummaries();

      expect(store.getSummary(local("t1"), { requireEnriched: true }))
        .toBeUndefined();
      expect(store.getSummary(local("t1"))?.title).toBe("Enriched");
    });

    it("forgets an entry whose id needed normalizing", () => {
      const store = new ThreadInfoStore();
      store.observe({
        identity: local(" padded "),
        observationSequence: store.reserveObservationSequence(),
        source: "provider-list",
        title: "Padded",
        titleSource: "explicit",
      });
      expect(store.size).toBe(1);

      store.forget(local(" padded "));

      expect(store.size).toBe(0);
    });
  });
});
