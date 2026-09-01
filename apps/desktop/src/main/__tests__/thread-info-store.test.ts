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
});
