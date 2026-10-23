import type { FederationServiceDataEnvelope, ServiceStreamData } from "@pwragent/shared";
import { FEDERATION_PROTOCOL_VERSION } from "@pwragent/shared";

/** The binary `service_data` envelope that carries `frame`; `route` names it and its ends. */
export function serviceDataEnvelope(
  frame: ServiceStreamData,
  route: Pick<FederationServiceDataEnvelope, "id" | "sourceInstanceId" | "targetInstanceId" | "createdAt">,
): FederationServiceDataEnvelope {
  return {
    ...route, kind: "service_data", protocolVersion: FEDERATION_PROTOCOL_VERSION,
    streamId: frame.streamId, seq: frame.seq, ...(frame.fin ? { fin: true } : {}), data: frame.data,
  };
}
