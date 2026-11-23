const MCP_DEFAULTS_READ_BUDGET_MS = 2_000;

/** Startup can proceed even when the managed MCP inventory cannot answer. */
export async function readNewThreadMcpInventory<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`No answer within ${MCP_DEFAULTS_READ_BUDGET_MS} ms.`)), MCP_DEFAULTS_READ_BUDGET_MS);
      timer.unref?.();
    });
    return await Promise.race([Promise.resolve().then(read), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
