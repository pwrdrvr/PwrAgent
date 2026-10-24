import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.argv[2] ?? 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a port from 1024 to 65535.");
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Federation preview fixture</title>
<style>body{font:18px system-ui;margin:3rem;max-width:45rem}code{font-size:14px}button{font:inherit;padding:.5rem}</style>
<h1>Federation preview fixture</h1><p>Invented data only. This server never reads files.</p>
<p>Browser origin: <code id="origin"></code></p><p>WebSocket updates: <strong id="updates">Connecting…</strong></p>
<button id="fetch">Test relative HTTP request</button><pre id="result"></pre>
<script>
document.querySelector('#origin').textContent = location.origin;
document.querySelector('#fetch').onclick = async () => {
  document.querySelector('#result').textContent = JSON.stringify(await (await fetch('/api/fixture')).json(), null, 2);
};
const url = new URL('/events', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(url);
socket.onmessage = (event) => { document.querySelector('#updates').textContent = event.data; };
socket.onclose = () => { document.querySelector('#updates').textContent = 'Disconnected'; };
</script></html>`;
const server = createServer((request, response) => {
  if (request.url === "/api/fixture") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ message: "Benign fixture response", host: request.headers.host }));
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(page);
  }
});
const websocket = new WebSocketServer({ server, path: "/events" });
websocket.on("connection", (socket) => {
  let revision = 0;
  const timer = setInterval(() => socket.send(`Fixture revision ${++revision}`), 1000);
  socket.once("close", () => clearInterval(timer));
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Fixture listening only on http://127.0.0.1:${port}/`);
  console.log("Call advertise_service on this owning instance's thread:");
  console.log(JSON.stringify({ port, name: "Federation preview fixture", protocol: "http", ttlSeconds: 3600 }));
});
function stop() {
  for (const socket of websocket.clients) socket.terminate();
  websocket.close();
  server.close();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
