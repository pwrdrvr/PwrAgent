import type { FederationPayloadSizeStats } from "@pwragent/shared";

// 32 bins per power of two cover every nonnegative safe integer byte size.
// Fixed storage: at most 1,698 numeric bins, independent of traffic volume.
const BINS_PER_OCTAVE = 32;
const BIN_COUNT = 53 * BINS_PER_OCTAVE + 2;

export class FederationSizeStatistics {
  private histogram?: Float64Array;
  private count = 0;
  private sum = 0;
  private min = Infinity;
  private max = 0;

  record(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return;
    this.histogram ??= new Float64Array(BIN_COUNT);
    const bin = bytes === 0 ? 0 : Math.ceil(Math.log2(bytes) * BINS_PER_OCTAVE) + 1;
    this.histogram[bin] += 1;
    this.count += 1;
    this.sum += bytes;
    this.min = Math.min(this.min, bytes);
    this.max = Math.max(this.max, bytes);
  }

  snapshot(): FederationPayloadSizeStats {
    if (!this.count || !this.histogram) return { count: 0 };
    const rank = Math.ceil(this.count / 2);
    let seen = 0;
    let median = 0;
    for (let bin = 0; bin < this.histogram.length; bin += 1) {
      seen += this.histogram[bin];
      if (seen < rank) continue;
      // The midpoint differs from any integer in this bin by about 1.1%
      // or less. Clamp to observed extrema, including constant-size streams.
      median = bin === 0 ? 0 : 2 ** ((bin - 1.5) / BINS_PER_OCTAVE);
      break;
    }
    return {
      count: this.count,
      averageBytes: this.sum / this.count,
      p50Bytes: Math.max(this.min, Math.min(this.max, median)),
      minBytes: this.min,
      maxBytes: this.max,
    };
  }
}
