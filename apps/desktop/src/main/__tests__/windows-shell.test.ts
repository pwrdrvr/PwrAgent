import { afterEach, describe, expect, it, vi } from "vitest";
import {
  preferStableWindowsBashPath,
  windowsBashCandidates,
} from "../windows-shell";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Windows bash resolution", () => {
  it("prefers the stable Git bash executable over its launcher", () => {
    vi.stubEnv("ProgramFiles", "C:\\Program Files");
    vi.stubEnv("ProgramFiles(x86)", "C:\\Program Files (x86)");
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\operator\\AppData\\Local");

    expect(windowsBashCandidates()).toEqual([
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      "C:\\Users\\operator\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe",
      "C:\\Users\\operator\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
      "bash.exe",
    ]);
  });

  it("normalizes an explicit Git bash launcher when the stable sibling exists", () => {
    const existingPaths: string[] = [];
    expect(
      preferStableWindowsBashPath(
        "C:\\Program Files\\Git\\bin\\bash.exe",
        (candidate) => {
          existingPaths.push(candidate);
          return true;
        },
      ),
    ).toBe("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
    expect(existingPaths).toEqual([
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    ]);
  });

  it("preserves a launcher when its stable sibling is unavailable", () => {
    expect(
      preferStableWindowsBashPath(
        "C:\\PortableGit\\bin\\bash.exe",
        () => false,
      ),
    ).toBe("C:\\PortableGit\\bin\\bash.exe");
  });
});
