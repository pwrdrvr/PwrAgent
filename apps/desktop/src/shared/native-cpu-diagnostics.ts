export const DIAGNOSTICS_CAPTURE_NATIVE_CPU_CHANNEL = "diagnostics:capture-native-cpu";
export const DIAGNOSTICS_STOP_NATIVE_CPU_CHANNEL = "diagnostics:stop-native-cpu";

export type NativeCpuCaptureResult = {
  summaryPath: string;
  durationMs: number;
};
