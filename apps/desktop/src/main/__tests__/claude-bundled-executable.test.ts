import { describe, expect, it, vi } from "vitest";
import { resolveBundledClaudeExecutable } from "../claude/claude-bundled-executable";

describe("bundled Claude executable", () => {
  it.each([
    ["darwin", "arm64", "glibc", "darwin-arm64/claude"],
    ["darwin", "x64", "glibc", "darwin-x64/claude"],
    ["win32", "x64", "glibc", "win32-x64/claude.exe"],
    ["win32", "arm64", "glibc", "win32-arm64/claude.exe"],
    ["linux", "x64", "glibc", "linux-x64/claude"],
    ["linux", "arm64", "musl", "linux-arm64-musl/claude"],
  ] as const)("resolves %s %s %s from the pinned SDK", async (platform, arch, libc, suffix) => {
    const resolveModule = vi.fn((name: string) => `/app/app.asar/node_modules/${name}`);
    const validatePath = vi.fn(async (file: string) => file);
    expect(await resolveBundledClaudeExecutable({ platform, arch, libc, resolveModule, validatePath }))
      .toBe(`/app/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-${suffix}`);
    expect(resolveModule).toHaveBeenCalledWith(`@anthropic-ai/claude-agent-sdk-${suffix}`);
  });

  it("uses Windows ASAR paths without passing a shell shim", async () => {
    expect(await resolveBundledClaudeExecutable({ platform: "win32", arch: "x64",
      resolveModule: () => "C:\\App\\resources\\app.asar\\node_modules\\sdk\\claude.exe",
      validatePath: async (file) => file,
    })).toBe("C:\\App\\resources\\app.asar.unpacked\\node_modules\\sdk\\claude.exe");
  });

  it("reports a missing package or unpacked binary without downloading anything", async () => {
    expect(await resolveBundledClaudeExecutable({ resolveModule: () => { throw new Error("missing"); } })).toBeUndefined();
    expect(await resolveBundledClaudeExecutable({ resolveModule: () => "/missing/claude",
      validatePath: async () => { throw new Error("ENOENT"); },
    })).toBeUndefined();
  });
});
