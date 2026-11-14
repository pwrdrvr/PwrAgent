// Browser-side runner. Paste/run via agent-browser eval --stdin after Start.
// Commands change only the live native fixture through authenticated window RPC.
(async () => {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const phases = [];
  if (!pwrwin.active || !pwrwin.metrics.frames.length) throw new Error("No live decoded frame; benchmark refused");
  async function phase(name, duration, action) {
    const wallStart = Date.now();
    const start = performance.now(), first = pwrwin.metrics.frames.length;
    if (action) await action();
    await pause(duration);
    phases.push({ name, wallStart, wallEnd: Date.now(), start, end: performance.now(), first, endIndex: pwrwin.metrics.frames.length });
  }
  await phase("idle", 3000);
  await phase("typing", 1500, async () => {
    for (const text of "LIVE123") { pwrwin.enqueue({ action: "text", text }); await pause(160); }
  });
  await phase("scroll", 1500, async () => {
    for (let i = 0; i < 15; i++) { pwrwin.enqueue({ action: "scroll", lines: 1 }); await pause(100); }
  });
  pwrwin.enqueue({ action: "motion", enabled: true });
  await phase("motion", 4000);
  pwrwin.enqueue({ action: "motion", enabled: false });
  await phase("settled", 3000);
  pwrwin.metrics.phases = phases;
  await pwrwin.save();
  return { frames: pwrwin.metrics.frames.length, inputs: pwrwin.metrics.inputs.length,
    errors: pwrwin.metrics.errors, phases };
})();
