import { configureFederationObservability } from "@pwragent/federation/observability";
import { getMainLogger } from "../log";
import { federationTrafficCaptureUntil, recordFederationTraffic } from "./federation-traffic-capture";

configureFederationObservability({
  logger: getMainLogger("pwragent:federation-transport"),
  captureUntil: federationTrafficCaptureUntil,
  recordTraffic: recordFederationTraffic,
});

export * from "@pwragent/federation/federation-transport";
