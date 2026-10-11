import type { MobileCredential, MobileEvent, MobileHello, MobileRpcResponse } from "../../../packages/shared/src/mobile-gateway";

export class GatewayRequestError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
type SocketFactory = (url: string, token: string) => WebSocket;
export class Gateway {
  private socket?: WebSocket;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private generation = 0;
  private sequence = 0;
  private stopped = true;
  private retry?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  hello?: MobileHello;
  onState: (state: string) => void = () => {};
  onEvent: (event: MobileEvent) => void = () => {};
  constructor(readonly credential: MobileCredential, private readonly createSocket: SocketFactory) {}
  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }
  private open(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.onState("Connecting");
    const url = new URL(this.credential.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Gateway requires HTTPS.");
    url.protocol = "wss:"; url.pathname = "/mobile/v1/socket"; url.search = ""; url.hash = "";
    const socket = this.createSocket(url.toString(), this.credential.token);
    this.socket = socket;
    socket.onopen = () => {
      if (generation !== this.generation) return socket.close();
      void this.rpc<MobileHello>("hello", {}).then((hello) => {
        if (hello.protocol !== 1 || hello.gatewayId !== this.credential.gatewayId || hello.deviceId !== this.credential.deviceId) {
          this.stop(); this.onState("Gateway identity changed. Pair again."); return;
        }
        this.hello = hello; this.attempt = 0; this.onState("Connected");
        this.heartbeat = setInterval(() => { void this.rpc("ping", {}).catch(() => socket.close()); }, 15_000);
      }).catch(() => socket.close());
    };
    socket.onmessage = ({ data }) => {
      if (generation !== this.generation || typeof data !== "string") return;
      try {
        const message = JSON.parse(data) as MobileRpcResponse | MobileEvent;
        if ("event" in message) { this.onEvent(message); return; }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new GatewayRequestError(message.error.code, message.error.message)); else pending.resolve(message.result);
      } catch { socket.close(); }
    };
    socket.onerror = () => socket.close();
    socket.onclose = (event) => {
      if (generation !== this.generation) return;
      this.hello = undefined; clearInterval(this.heartbeat);
      this.rejectPending();
      if (this.stopped) return;
      if (event.code === 4001 || event.code === 4003) { this.stopped = true; this.onState("Pairing expired or revoked"); return; }
      this.onState("Reconnecting");
      this.retry = setTimeout(() => this.open(), Math.min(30_000, 500 * 2 ** this.attempt++) + Math.random() * 500);
    };
  }
  rpc<T>(method: string, params: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return Promise.reject(new Error("Gateway disconnected"));
    const id = String(++this.sequence);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Acknowledgment timed out")); }, 30_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  stop(): void {
    this.stopped = true; ++this.generation; clearTimeout(this.retry); clearInterval(this.heartbeat);
    this.socket?.close(); this.socket = undefined; this.hello = undefined; this.rejectPending(); this.onState("Offline");
  }
  private rejectPending(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Connection lost; request retained")); }
    this.pending.clear();
  }
}
