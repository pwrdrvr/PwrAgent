// Forward one local TCP port to another host and port.
// Usage: node tcp-relay.mjs <listenHost> <listenPort> <targetHost> <targetPort>
import net from "node:net";

const [listenHost, listenPort, targetHost, targetPort] = process.argv.slice(2);
if (!listenHost || !listenPort || !targetHost || !targetPort) {
  console.error("usage: node tcp-relay.mjs <listenHost> <listenPort> <targetHost> <targetPort>");
  process.exit(2);
}

const server = net.createServer((client) => {
  const upstream = net.connect({ host: targetHost, port: Number(targetPort) });
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", close);
  upstream.on("close", close);
});

server.listen(Number(listenPort), listenHost, () => {
  console.log(`relay ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`);
});
