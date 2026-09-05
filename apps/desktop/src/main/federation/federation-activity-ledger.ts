import type {
  ReadFederationActivityRequest,
  FederationActivityCounts,
  FederationActivityTotals,
  FederationActivitySeries,
  FederationActivitySnapshot,
  FederationProtocolEnvelope,
} from "@pwragent/shared";

const SECOND = 1_000;
const HOUR = 3_600;
// Retain at most 32 attributed peers per view; overflow remains counted.
const MAX_PEERS = 32;
const OTHER = "Other peers (attribution limit)";
const counts = (): FederationActivityCounts => ({
  requests: 0, responses: 0, notifications: 0, other: 0,
  dataBytes: 0, wireBytes: 0,
});
const totals = (): FederationActivityTotals => ({ sent: counts(), received: counts() });
function add(target: FederationActivityTotals, source: FederationActivityTotals) {
  for (const direction of ["sent", "received"] as const) {
    for (const key of Object.keys(target[direction]) as Array<keyof FederationActivityCounts>) {
      target[direction][key] += source[direction][key];
    }
  }
}
class Series {
  readonly lifetime = totals();
  readonly buckets = new Map<number, FederationActivityTotals>();
  record(at: number, delta: FederationActivityTotals) {
    add(this.lifetime, delta);
    const bucket = this.buckets.get(at) ?? totals();
    add(bucket, delta);
    this.buckets.set(at, bucket);
    this.expire(at);
  }
  expire(at: number) {
    for (const time of this.buckets.keys()) {
      if (time > at - HOUR) break;
      this.buckets.delete(time);
    }
  }
  snapshot(at: number, includeHistory: boolean): FederationActivitySeries {
    this.expire(at);
    const windows = { "1m": totals(), "5m": totals(), "1h": totals() };
    const history: FederationActivitySeries["history"] = [];
    const first = at - HOUR + 1;
    // Ten-second chart bins, with rolling totals evaluated at second boundaries.
    if (includeHistory) {
      for (let start = first; start <= at; start += 10) {
        history.push({ at: start * SECOND, totals: totals() });
      }
    }
    for (const [time, bucket] of this.buckets) {
      add(windows["1h"], bucket);
      if (time > at - 300) add(windows["5m"], bucket);
      if (time > at - 60) add(windows["1m"], bucket);
      if (includeHistory) add(history[Math.floor((time - first) / 10)].totals, bucket);
    }
    return { lifetime: structuredClone(this.lifetime), windows, history };
  }
}

/** Numeric aggregates only: no envelope, method, request ID or payload retention. */
export class FederationActivityLedger {
  private readonly physical = new Series();
  private readonly peers = new Map<string, Series>();
  private readonly logical = new Map<string, Series>();
  private lastSecond: number;
  constructor(private readonly since = Date.now()) {
    this.lastSecond = Math.floor(since / SECOND);
  }
  private series(map: Map<string, Series>, peer: string) {
    // Envelope metadata is remote input. Bound retained strings as well as
    // map cardinality; malformed IDs must never retain a payload-sized value.
    const name = typeof peer === "string" && peer.length > 0 && peer.length <= 120
      ? peer
      : "Unknown endpoint";
    const key = map.has(name) || map.size < MAX_PEERS ? name : OTHER;
    let value = map.get(key);
    if (!value) { value = new Series(); map.set(key, value); }
    return value;
  }
  record(info: {
    peerId: string;
    localInstanceId: string;
    direction: "sent" | "received";
    byteCount: number;
    dataByteCount: number;
    envelope: Pick<FederationProtocolEnvelope, "kind" | "sourceInstanceId" | "targetInstanceId">;
    at?: number;
  }) {
    if (!Number.isFinite(info.byteCount) || info.byteCount < 0
      || !Number.isFinite(info.dataByteCount) || info.dataByteCount < 0) return;
    const second = Math.max(this.lastSecond, Math.floor((info.at ?? Date.now()) / SECOND));
    this.lastSecond = second;
    const delta = totals();
    const value = delta[info.direction];
    const kind = info.envelope.kind;
    value[kind === "request" ? "requests" : kind === "response" || kind === "error"
      ? "responses" : kind === "notification" ? "notifications" : "other"] = 1;
    value.dataBytes = info.dataByteCount;
    value.wireBytes = info.byteCount;
    this.physical.record(second, delta);
    this.series(this.peers, info.peerId).record(second, delta);
    // A gateway's forwarding leg is physical traffic, never a second logical event.
    if (info.direction === "sent" && info.envelope.sourceInstanceId === info.localInstanceId) {
      this.series(this.logical, info.envelope.targetInstanceId ?? "Broadcast").record(second, delta);
    } else if (info.direction === "received"
      && (!info.envelope.targetInstanceId || info.envelope.targetInstanceId === info.localInstanceId)) {
      this.series(this.logical, info.envelope.sourceInstanceId).record(second, delta);
    }
  }
  snapshot(now = Date.now(), request: ReadFederationActivityRequest = {}): FederationActivitySnapshot {
    const at = Math.max(this.lastSecond, Math.floor(now / SECOND));
    this.lastSecond = at;
    const snapshotMap = (map: Map<string, Series>, view: "physical" | "logical") =>
      [...map].map(([peerId, series]) => ({
        peerId,
        series: series.snapshot(at, request.includeHistory !== false
          && request.historyPeerId === peerId && request.historyView === view),
      }));
    return {
      since: this.since, at: at * SECOND, bucketMs: SECOND,
      physical: this.physical.snapshot(at, request.includeHistory !== false && !request.historyPeerId),
      peers: snapshotMap(this.peers, "physical"), logical: snapshotMap(this.logical, "logical"),
    };
  }
}
