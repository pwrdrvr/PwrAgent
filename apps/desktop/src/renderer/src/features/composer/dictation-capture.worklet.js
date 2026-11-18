// The AudioContext supplies mono 24 kHz frames. Batch 100 ms of PCM16 per IPC.
class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new ArrayBuffer(4800);
    this.view = new DataView(this.samples);
    this.size = 0;
    this.port.onmessage = () => {
      this.emit();
      this.port.postMessage("flushed");
    };
  }

  emit() {
    if (!this.size) return;
    const pcm = this.samples.slice(0, this.size);
    this.port.postMessage(pcm, [pcm]);
    this.size = 0;
  }

  process(inputs) {
    const mono = inputs[0]?.[0];
    if (!mono) return true;
    for (const sample of mono) {
      this.view.setInt16(this.size, Math.max(-1, Math.min(1, sample)) * 32767, true);
      this.size += 2;
      if (this.size === this.samples.byteLength) this.emit();
    }
    return true;
  }
}

registerProcessor("pwragent-dictation", DictationCapture);
