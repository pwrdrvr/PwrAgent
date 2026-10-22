async function benchmark(faults) {
  const p = window.pwrwin, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  p.faults(faults);
  const phases = [];
  async function phase(name, action) {
    const a = p.snapshot(), decodeStart = a.decodeMs.length, presentationStart = a.presentations.length;
    await action(); const b = p.snapshot();
    phases.push({ name, durationMs: b.at - a.at, mediaBytes: b.mediaBytes - a.mediaBytes,
      feedbackSentBytes: b.feedbackSentBytes - a.feedbackSentBytes, feedbackReceivedBytes: b.feedbackReceivedBytes - a.feedbackReceivedBytes,
      packets: b.packets - a.packets, dropped: b.dropped - a.dropped, previews: b.previews - a.previews,
      tiles: b.tiles - a.tiles, missingAtEnd: b.missing, decodeMs: b.decodeMs.slice(decodeStart),
      presentations: b.presentations.slice(presentationStart).map(x => ({ ...x, at: x.at - a.at })) });
  }
  async function settle() {
    // Starts after the native fixture acknowledged the command. End requires its
    // revision in actual canvas pixels AND complete current lossless tile coverage.
    const deadline = performance.now() + 8000;
    const complete = () => { const s = p.snapshot(); return s.refinementComplete && s.visibleRevision === s.fixtureRevision; };
    while (!complete() && performance.now() < deadline) await sleep(10);
    if (!complete()) throw new Error("refinement_did_not_converge");
  }
  await settle();
  // UI screenshot tooling between scenarios can itself change native window
  // activation/capture-indicator pixels. Start idle only after observed quiescence.
  const quietDeadline = performance.now() + 8000;
  while ((p.snapshot().quietMs < 500 || !p.snapshot().refinementComplete) && performance.now() < quietDeadline) await sleep(25);
  if (p.snapshot().quietMs < 500 || !p.snapshot().refinementComplete) throw new Error("source_not_quiet_for_idle");
  await phase("idle", () => sleep(2000));
  await phase("typing", async () => { for (const text of " PUSH WEBP") { await p.fixture({ action: "text", text }); await sleep(100); } });
  await phase("typing-settle", settle);
  await phase("scroll", async () => { for (let n = 0; n < 20; n++) { await p.fixture({ action: "scroll", lines: 1 }); await sleep(50); } });
  await phase("scroll-settle", settle);
  await phase("motion", async () => { await p.fixture({ action: "motion", enabled: true }); await sleep(3000); await p.fixture({ action: "motion", enabled: false }); });
  await phase("motion-settle", settle);
  await phase("interrupted-refinement", async () => {
    for (let n = 0; n < 5; n++) {
      await p.fixture({ action: "motion", enabled: true }); await sleep(300);
      await p.fixture({ action: "motion", enabled: false }); await sleep(180);
    }
  });
  await phase("final-settle", settle);
  const { decodeMs, presentations, ...state } = p.snapshot();
  return { faults, phases, state, rtc: await p.rtc() };
}
