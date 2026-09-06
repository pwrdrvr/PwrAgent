import { FederationSizeStatistics } from "./federation-size-statistics";
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
const COUNT_FIELDS = ["requests", "responses", "notifications", "other", "dataBytes", "wireBytes"] as const;
function addCounts(target: FederationActivityCounts, source: FederationActivityCounts) {
  target.requests += source.requests;
  target.responses += source.responses;
  target.notifications += source.notifications;
  target.other += source.other;
  target.dataBytes += source.dataBytes;
  target.wireBytes += source.wireBytes;
}
function add(target: FederationActivityTotals, source: FederationActivityTotals) {
  addCounts(target.sent, source.sent);
  addCounts(target.received, source.received);
}
function addBucket(target: FederationActivityTotals, values: Float64Array, offset: number) {
  for (const direction of ["sent", "received"] as const) {
    const value = target[direction];
    value.requests += values[offset++];
    value.responses += values[offset++];
    value.notifications += values[offset++];
    value.other += values[offset++];
    value.dataBytes += values[offset++];
    value.wireBytes += values[offset++];
  }
}
class Series {
  readonly lifetime = totals();
  private readonly sizes = {
    sent: { requests: new FederationSizeStatistics(), responses: new FederationSizeStatistics() },
    received: { requests: new FederationSizeStatistics(), responses: new FederationSizeStatistics() },
  };
  // Fixed ring storage, allocated only after this series receives traffic.
  // Timestamp tags make idle/expired slots invisible without a per-event sweep.
  private times?: Float64Array;
  private values?: Float64Array;
  record(at: number, delta: FederationActivityTotals) {
    add(this.lifetime, delta);
    for (const direction of ["sent", "received"] as const) {
      const value = delta[direction];
      if (value.requests) this.sizes[direction].requests.record(value.dataBytes);
      if (value.responses) this.sizes[direction].responses.record(value.dataBytes);
    }
    this.times ??= new Float64Array(HOUR).fill(-Infinity);
    this.values ??= new Float64Array(HOUR * 12);
    const slot = ((at % HOUR) + HOUR) % HOUR;
    let offset = slot * 12;
    if (this.times[slot] !== at) {
      this.values.fill(0, offset, offset + 12);
      this.times[slot] = at;
    }
    for (const direction of ["sent", "received"] as const) {
      for (const field of COUNT_FIELDS) this.values[offset++] += delta[direction][field];
    }
  }
  snapshot(at: number, includeHistory: boolean): FederationActivitySeries {
    const windows = { "1m": totals(), "5m": totals(), "10m": totals(), "1h": totals() };
    const history: FederationActivitySeries["history"] = [];
    const first = at - HOUR + 1;
    // Ten-second chart bins, with rolling totals evaluated at second boundaries.
    if (includeHistory) {
      for (let start = first; start <= at; start += 10) {
        history.push({ at: start * SECOND, totals: totals() });
      }
    }
    if (this.times && this.values) {
      for (let slot = 0; slot < HOUR; slot += 1) {
        const time = this.times[slot];
        if (time <= at - HOUR || time > at) continue;
        const offset = slot * 12;
        addBucket(windows["1h"], this.values, offset);
        if (time > at - 600) addBucket(windows["10m"], this.values, offset);
        if (time > at - 300) addBucket(windows["5m"], this.values, offset);
        if (time > at - 60) addBucket(windows["1m"], this.values, offset);
        if (includeHistory) addBucket(history[Math.floor((time - first) / 10)].totals, this.values, offset);
      }
    }
    return {
      lifetime: structuredClone(this.lifetime), windows, history,
      sizes: {
        sent: { requests: this.sizes.sent.requests.snapshot(), responses: this.sizes.sent.responses.snapshot() },
        received: { requests: this.sizes.received.requests.snapshot(), responses: this.sizes.received.responses.snapshot() },
      },
    };
  }
}

/** Numeric aggregates only: no envelope, method, request ID or payload retention. */
export class FederationActivityLedger {
  private physical = new Series();
  private readonly peers = new Map<string, Series>();
  private readonly logical = new Map<string, Series>();
  private lastSecond: number;
  constructor(private since = Date.now()) {
    this.lastSecond = Math.floor(since / SECOND);
  }
  reset(at = Date.now()): void {
    this.physical = new Series();
    this.peers.clear();
    this.logical.clear();
    this.since = at;
    this.lastSecond = Math.floor(at / SECOND);
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
    if (!Number.isSafeInteger(info.byteCount) || info.byteCount < 0
      || !Number.isSafeInteger(info.dataByteCount) || info.dataByteCount < 0) return;
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
