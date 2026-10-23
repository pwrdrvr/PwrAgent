/** Release a cancelled search even if a provider cannot abort its in-flight read. */
export async function awaitThreadSearchRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await read();
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([read(), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
