// Imported by the Electron bootstrap, or NODE_OPTIONS in Node helpers.
// Profile helpers retain the bootstrap entry. Keep traffic off the runner IP's
// anonymous GitHub quota, including services outside electron-updater.
if (process.env.PWRAGENT_E2E === "1") {
  const isReleaseUrl = (input) => {
    const url = new URL(typeof input === "string" || input instanceof URL
      ? input : input.url);
    return url.hostname === "api.github.com"
      && /^\/repos\/[^/]+\/[^/]+\/releases(?:\/|$)/.test(url.pathname);
  };
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!isReleaseUrl(input)) return nativeFetch(input, init);
    const url = new URL(typeof input === "string" || input instanceof URL
      ? input : input.url);
    const list = /\/releases$/.test(url.pathname);
    return new Response(JSON.stringify(list ? [] : { message: "No E2E release" }), {
      status: list ? 200 : 404,
      headers: { "Content-Type": "application/json", "X-PwrAgent-E2E": "release-stub" },
    });
  };
  // electron-updater uses a different transport. It is disabled by the E2E
  // flag; reject any regression through Node HTTP before it opens a socket.
  for (const protocol of ["http", "https"]) {
    const transport = require(`node:${protocol}`);
    for (const method of ["request", "get"]) {
      const original = transport[method];
      transport[method] = function (input, ...args) {
        const url = typeof input === "string" || input instanceof URL
          ? new URL(input)
          : new URL(`${input.protocol ?? `${protocol}:`}//${input.hostname ?? input.host}${input.path ?? "/"}`);
        if (isReleaseUrl(url)) {
          throw new Error(`E2E GitHub release request must be stubbed: ${url}`);
        }
        return original.call(this, input, ...args);
      };
    }
  }
  if (process.type === "browser") {
    const { net } = require("electron");
    const original = net.request;
    net.request = function (input) {
      const url = typeof input === "string" ? input : input.url
        ?? `${input.protocol ?? "https:"}//${input.hostname ?? input.host}${input.path ?? "/"}`;
      if (isReleaseUrl(url)) {
        throw new Error(`E2E GitHub release request must be stubbed: ${url}`);
      }
      return original.call(this, input);
    };
  }
  require("node:module").syncBuiltinESMExports();
  globalThis[Symbol.for("pwragent.e2e.releaseStubs")] = true;
}
