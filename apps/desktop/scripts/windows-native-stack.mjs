// CDB output includes local paths, arguments and addresses. Keep only bounded
// thread identities and call-site symbols; never persist its raw output.
export function parseNativeStacks(output) {
  const threads = [];
  let current, omittedThreads = 0, omittedFrames = 0, symbolWarnings = 0;
  for (const line of output.split(/\r?\n/)) {
    if (/\*\*\* (?:ERROR|WARNING):.*(?:symbol|timestamp)/i.test(line)) symbolWarnings++;
    const thread = /^\s*[.#]?\s*(\d+)\s+Id:\s*([a-f0-9]+)\.([a-f0-9]+)\b/i.exec(line);
    if (thread) {
      current = undefined;
      if (threads.length >= 128) { omittedThreads++; continue; }
      current = { index: Number(thread[1]), pid: thread[2].toLowerCase(), tid: thread[3].toLowerCase(), frames: [] };
      threads.push(current);
      continue;
    }
    const frame = /^\s*([a-f0-9]{2,3})\s+[a-f0-9`]+\s+[a-f0-9`]+\s+(\S+)/i.exec(line);
    if (!frame || !current) continue;
    const symbol = frame[2];
    // Accept module!symbol or module+offset. No paths, arguments or raw memory.
    if (!/^[a-z0-9_.-]+(?:![a-z0-9_.$~?@:+<>,*&()={}\[\]`'-]+|\+0x[a-f0-9]+)$/i.test(symbol)
      || current.frames.length >= 40) { omittedFrames++; continue; }
    current.frames.push({ index: parseInt(frame[1], 16), symbol });
  }
  return { threads, omittedThreads, omittedFrames, symbolWarnings,
    frameCount: threads.reduce((count, thread) => count + thread.frames.length, 0) };
}
