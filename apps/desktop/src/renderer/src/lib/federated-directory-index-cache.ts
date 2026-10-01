import type { AgentEvent } from "@pwragent/shared";
import {
  navigationInvalidationMayChangeMembership,
  navigationQueryEventRequiresRefresh,
} from "@pwragent/shared";
import {
  findPeerCounterpartDirectory,
  type ProjectIdentity,
} from "./federation-project-match";

/** The fields that recognize a project across machines, and nothing else. */
export type FederatedDirectoryIdentity = ProjectIdentity & {
  key: string;
  localAvailability?: "unconfigured";
};

/** Issued before an owner read so its result can be refused if the peer changed meanwhile. */
export type FederatedDirectoryIndexRead = {
  instanceId: string;
  epoch: number;
  sequence: number;
};

/**
 * Each peer's directory index as this window last read it, kept only to
 * answer "does this machine have the project?" in the machine menus.
 *
 * A cached index proves presence, never absence. Registering a launchpad on
 * the owner publishes no event, and a viewer hears a peer's navigation
 * events only while it holds a subscription to them, so nothing here can
 * show that a project is still missing. A cached "present" can be stale; the
 * open after a machine is chosen reads the owner again and reports a real
 * miss, the same as a failed check does.
 *
 * An index is dropped when the peer's connection status or event stream
 * changes, and on any peer event that can change its directory set. Only a
 * complete index is ever recorded: the owner read throws for one the owner
 * is still loading.
 */
export class FederatedDirectoryIndexCache {
  private readonly entries = new Map<string, {
    directories: FederatedDirectoryIdentity[];
    sequence: number;
  }>();
  private readonly epochs = new Map<string, number>();
  private readonly loads = new Map<string, {
    epoch: number;
    promise: Promise<readonly FederatedDirectoryIdentity[]>;
  }>();
  private nextSequence = 0;

  begin(instanceId: string): FederatedDirectoryIndexRead {
    return {
      instanceId,
      epoch: this.epochs.get(instanceId) ?? 0,
      sequence: ++this.nextSequence,
    };
  }

  /**
   * Keep a complete owner index, unless the peer changed after the read
   * began or a read that began later has already landed.
   */
  record(
    read: FederatedDirectoryIndexRead,
    directories: readonly FederatedDirectoryIdentity[],
  ): void {
    if ((this.epochs.get(read.instanceId) ?? 0) !== read.epoch) {
      return;
    }
    const current = this.entries.get(read.instanceId);
    if (current && current.sequence > read.sequence) {
      return;
    }
    this.entries.set(read.instanceId, {
      directories: directories.map((directory) => ({
        key: directory.key,
        kind: directory.kind,
        label: directory.label,
        ...(directory.path !== undefined ? { path: directory.path } : {}),
        ...(directory.repositoryKey !== undefined
          ? { repositoryKey: directory.repositoryKey }
          : {}),
        ...(directory.localAvailability !== undefined
          ? { localAvailability: directory.localAvailability }
          : {}),
      })),
      sequence: read.sequence,
    });
  }

  /**
   * Whether the peer has the project. `read` returns the owner's complete
   * index. Overlapping checks of one peer share a read, unless the peer
   * changed after it began.
   */
  async hasProject(
    instanceId: string,
    project: ProjectIdentity,
    read: (indexRead: FederatedDirectoryIndexRead) => Promise<readonly FederatedDirectoryIdentity[]>,
  ): Promise<boolean> {
    const cached = this.entries.get(instanceId);
    if (cached && findPeerCounterpartDirectory(project, cached.directories)) {
      return true;
    }
    const epoch = this.epochs.get(instanceId) ?? 0;
    let load = this.loads.get(instanceId);
    if (!load || load.epoch !== epoch) {
      const indexRead = this.begin(instanceId);
      const promise = read(indexRead).then((directories) => {
        this.record(indexRead, directories);
        return directories;
      }).finally(() => {
        if (this.loads.get(instanceId)?.promise === promise) {
          this.loads.delete(instanceId);
        }
      });
      load = { epoch, promise };
      this.loads.set(instanceId, load);
    }
    return Boolean(findPeerCounterpartDirectory(project, await load.promise));
  }

  invalidate(instanceId: string): void {
    this.epochs.set(instanceId, (this.epochs.get(instanceId) ?? 0) + 1);
    this.entries.delete(instanceId);
  }

  /** Drop a peer's index for any event that can change what it would answer. */
  observe(event: AgentEvent): void {
    const target = event.federationTarget;
    if (target?.scope !== "remote") {
      return;
    }
    const method = event.notification.method as string;
    if (
      method === "federation/peerStatus/changed"
      || method === "federation/eventStream/changed"
    ) {
      this.invalidate(target.instanceId);
      return;
    }
    const params = event.notification.params as { sourceMethod?: unknown } | undefined;
    if (!navigationQueryEventRequiresRefresh(method, params)) {
      return;
    }
    // The same rule the main process applies to remote pin membership: only
    // events known to touch a single row leave the collection alone.
    if (navigationInvalidationMayChangeMembership(
      method === "navigation/invalidated" ? params?.sourceMethod : method,
    )) {
      this.invalidate(target.instanceId);
    }
  }
}
