/** Decimal network units: 1 KB = 1,000 bytes. Keep exact counters in IPC. */
export function trafficByteUnit(value: number) {
  const exponent = Math.min(4, Math.max(1, Math.floor(Math.log10(Math.max(1, value)) / 3)));
  return { scale: 1000 ** exponent, unit: ["B", "KB", "MB", "GB", "TB"][exponent] };
}

export function formatTrafficBytes(value: number): string {
  const { scale, unit } = trafficByteUnit(value);
  const scaled = value / scale;
  if (scaled > 0 && scaled < 0.01) return `<0.01 ${unit}`;
  return `${scaled.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
}
