import { expect, it, vi } from "vitest";
import { createWorktreeDirectoryProbe } from "../app-server/worktree-directory-probe";

const directory = { isDirectory: () => true };

it("shares a stalled probe and keeps its slot until the filesystem answers", async () => {
  const first = Promise.withResolvers<typeof directory>();
  const second = Promise.withResolvers<typeof directory>();
  const stat = vi.fn((target: string) => target === "/first" ? first.promise
    : target === "/second" ? second.promise : Promise.resolve(directory));
  const probe = createWorktreeDirectoryProbe(stat, 0);

  try {
    await expect(Promise.all([
      probe("/first"), probe("/first"), probe("/second"), probe("/third"),
    ])).resolves.toEqual(["not-responding", "not-responding", "not-responding", "busy"]);
    await expect(probe("/first")).resolves.toBe("not-responding");
    await expect(probe("/third")).resolves.toBe("busy");
    expect(stat.mock.calls).toEqual([["/first"], ["/second"]]);

    first.resolve(directory);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(probe("/third")).resolves.toBe("available");
    expect(stat.mock.calls).toEqual([["/first"], ["/second"], ["/third"]]);
  } finally {
    first.resolve(directory);
    second.resolve(directory);
  }
});

it("admits a waiting worktree when a physical probe finishes before the deadline", async () => {
  const first = Promise.withResolvers<typeof directory>();
  const second = Promise.withResolvers<typeof directory>();
  const stat = vi.fn((target: string) => target === "/first" ? first.promise
    : target === "/second" ? second.promise : Promise.resolve(directory));
  const probe = createWorktreeDirectoryProbe(stat);
  const requests = [probe("/first"), probe("/second"), probe("/third")];

  try {
    await Promise.resolve();
    expect(stat.mock.calls).toEqual([["/first"], ["/second"]]);
    first.resolve(directory);
    await expect(requests[2]).resolves.toBe("available");
    expect(stat.mock.calls).toEqual([["/first"], ["/second"], ["/third"]]);
  } finally {
    first.resolve(directory);
    second.resolve(directory);
    await Promise.all(requests);
  }
});
