import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

export async function transmitPacket(client, packet, { mbps, stallMs }, wait = sleep) {
  // Serialization and retransmission-like stalls precede receiver visibility,
  // even for a single-packet frame. Propagation is added by the receiver.
  await wait(packet.length * 8 / (mbps * 1000) + stallMs);
  if (!client.write(packet)) await once(client, "drain");
}
