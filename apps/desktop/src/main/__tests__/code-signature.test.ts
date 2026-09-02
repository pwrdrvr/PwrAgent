import { mkdtemp, rm, writeFile as write } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopCodeSignature } from "@pwragent/shared";
import {
  CodeSignatureInspector,
  parseAuthenticodeOutput,
  parseCodesignDisplay,
} from "../settings/code-signature";

/**
 * Fixtures are verbatim `codesign -dvvv` output captured on macOS 25.6
 * (Apple silicon) from the binaries a developer machine actually has. The
 * point of pinning real output is that the classification hinges on
 * details that are easy to get wrong from memory — Homebrew's `gh` reports
 * `adhoc` only inside a `flags=` list and carries no `Signature=` line at
 * all, and Apple's `/usr/bin/git` is a `tool-shim` whose authority chain
 * is the only thing identifying it.
 */
const HOMEBREW_GIT = `Executable=/opt/homebrew/bin/git
Identifier=git-555549448c92eaf5407f39be9a8bdf138c1bf1a1
Format=Mach-O thin (arm64)
CodeDirectory v=20400 size=7301 flags=0x2(adhoc) hashes=222+2 location=embedded
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set`;

const HOMEBREW_GH = `Executable=/opt/homebrew/bin/gh
Identifier=a.out
Format=Mach-O thin (arm64)
CodeDirectory v=20400 size=305150 flags=0x20002(adhoc,linker-signed) hashes=9533+0 location=embedded
Signature=adhoc
TeamIdentifier=not set`;

const APPLE_GIT = `Executable=/usr/bin/git
Identifier=com.apple.dt.xcode_select.tool-shim-public
Format=Mach-O universal (x86_64 arm64e)
CodeDirectory v=20400 size=323 flags=0x0(none) hashes=4+2 location=embedded
Signature size=4567
Authority=macOS Software Signing
Authority=Apple Code Signing Certification Authority
Authority=Apple Root CA
TeamIdentifier=not set`;

const VS_CODE = `Executable=/Applications/Visual Studio Code.app/Contents/MacOS/Electron
Identifier=com.microsoft.VSCode
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=640 flags=0x10000(runtime) hashes=9+7 location=embedded
Signature size=9012
Authority=Developer ID Application: Microsoft Corporation (UBF8T346G9)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=UBF8T346G9`;

describe("parseCodesignDisplay", () => {
  it("reads an ad-hoc signed Homebrew binary as adhoc", () => {
    expect(parseCodesignDisplay(HOMEBREW_GIT)).toEqual({ trust: "adhoc" });
  });

  it("reads a linker-signed binary as adhoc from the flags alone", () => {
    // No standalone `Signature=adhoc` classification is possible here in
    // isolation — the flag list is what says so.
    expect(parseCodesignDisplay(HOMEBREW_GH)).toEqual({ trust: "adhoc" });
  });

  it("reads an Apple-signed system binary as platform", () => {
    expect(parseCodesignDisplay(APPLE_GIT)).toEqual({
      trust: "platform",
      signer: "macOS Software Signing",
    });
  });

  it("reads a Developer ID signature as publisher, with the team", () => {
    // `publisher` is what the display alone can prove. Upgrading it to
    // `notarized` requires the separate verify pass.
    expect(parseCodesignDisplay(VS_CODE)).toEqual({
      trust: "publisher",
      signer: "Developer ID Application: Microsoft Corporation (UBF8T346G9)",
      teamId: "UBF8T346G9",
    });
  });

  it("reads an unsigned file as unsigned", () => {
    expect(
      parseCodesignDisplay("/tmp/fake-git: code object is not signed at all"),
    ).toEqual({ trust: "unsigned" });
  });

  it("reads a modified signature as invalid", () => {
    const parsed = parseCodesignDisplay(
      "/tmp/git: invalid signature (code or signature have been modified)",
    );
    expect(parsed.trust).toBe("invalid");
  });

  it("does not claim a team identifier when the file has none", () => {
    expect(parseCodesignDisplay(APPLE_GIT)).not.toHaveProperty("teamId");
  });
});

describe("parseAuthenticodeOutput", () => {
  it("reads a valid Authenticode signature as publisher with the common name", () => {
    expect(
      parseAuthenticodeOutput(
        JSON.stringify({
          status: "Valid",
          subject: 'CN="Johnson Controls, Inc.", O=Example, C=US',
        }),
      ),
    ).toEqual({
      trust: "publisher",
      // A quoted common name may itself contain a comma, which is why the
      // quoted form is read before falling back to "up to the next comma".
      signer: "Johnson Controls, Inc.",
    });
  });

  it("reads an unquoted common name", () => {
    expect(
      parseAuthenticodeOutput(
        JSON.stringify({ status: "Valid", subject: "CN=Git Development, C=US" }),
      ),
    ).toEqual({ trust: "publisher", signer: "Git Development" });
  });

  it("reads NotSigned as unsigned", () => {
    expect(
      parseAuthenticodeOutput(JSON.stringify({ status: "NotSigned", subject: "" })),
    ).toEqual({ trust: "unsigned" });
  });

  it("reads any other status as invalid and keeps the reason", () => {
    expect(
      parseAuthenticodeOutput(
        JSON.stringify({ status: "HashMismatch", subject: "" }),
      ),
    ).toEqual({ trust: "invalid", detail: "HashMismatch" });
  });

  it("reads unparseable output as unknown", () => {
    expect(parseAuthenticodeOutput("not json").trust).toBe("unknown");
  });
});

/**
 * The inspector's own logic — identity cache, in-flight dedupe, and the
 * concurrency cap — with the one subprocess step stubbed out. Left
 * untested, the parsers above are green while the class around them
 * re-probes on every render or runs an unbounded burst of `codesign`
 * processes, neither of which any parser assertion can see.
 */
class StubInspector extends CodeSignatureInspector {
  readonly probed: string[] = [];
  peakConcurrency = 0;
  private running = 0;

  constructor(
    private readonly gate?: Promise<void>,
    platform: NodeJS.Platform = "darwin",
  ) {
    super({ platform });
  }

  protected override async probe(path: string): Promise<DesktopCodeSignature> {
    this.probed.push(path);
    this.running += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.running);
    try {
      await (this.gate ?? Promise.resolve());
      return { path, trust: "adhoc" };
    } finally {
      this.running -= 1;
    }
  }
}

describe("CodeSignatureInspector", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "pwragent-code-signature-"));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  async function writeFile(name: string, contents: string): Promise<string> {
    const target = path.join(directory, name);
    await write(target, contents, "utf8");
    return target;
  }

  it("serves a cached reading without probing again", async () => {
    const target = await writeFile("git", "one");
    const inspector = new StubInspector();

    await inspector.inspect(target);
    await inspector.inspect(target);

    expect(inspector.probed).toEqual([target]);
  });

  it("re-probes when the file at the same path changes", async () => {
    const target = await writeFile("git", "one");
    const inspector = new StubInspector();
    await inspector.inspect(target);

    // A Homebrew upgrade rewrites the same path in place, which is the
    // case the mtime+size key exists to notice.
    await write(target, "two-is-longer", "utf8");
    await inspector.inspect(target);

    expect(inspector.probed).toEqual([target, target]);
  });

  it("probes an unreadable path every time rather than caching a guess", async () => {
    const missing = path.join(directory, "absent");
    const inspector = new StubInspector();

    await inspector.inspect(missing);
    await inspector.inspect(missing);

    expect(inspector.probed).toEqual([missing, missing]);
  });

  it("collapses concurrent requests for one path into a single probe", async () => {
    const target = await writeFile("git", "one");
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const inspector = new StubInspector(gate);

    const both = Promise.all([inspector.inspect(target), inspector.inspect(target)]);
    open();
    const [first, second] = await both;

    expect(inspector.probed).toEqual([target]);
    expect(first).toEqual(second);
  });

  it("never runs more than four probes at once", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const inspector = new StubInspector(gate);
    const targets = await Promise.all(
      Array.from({ length: 12 }, (_value, index) =>
        writeFile(`tool-${index}`, `contents-${index}`),
      ),
    );

    const pending = inspector.inspectMany(targets);
    // Every caller stats its file before it reaches the limiter, so settle
    // that I/O first and assert the cap while all twelve are outstanding.
    await vi.waitFor(() => {
      expect(inspector.probed).toHaveLength(4);
    });
    expect(inspector.peakConcurrency).toBe(4);

    open();
    await pending;
    expect(inspector.peakConcurrency).toBe(4);
    expect(inspector.probed).toHaveLength(12);
  });

  it("reports unsupported without probing on a platform with no signing", async () => {
    const inspector = new StubInspector(undefined, "linux");

    expect(await inspector.inspect("/usr/bin/git")).toEqual({
      path: "/usr/bin/git",
      trust: "unsupported",
    });
    expect(inspector.probed).toEqual([]);
  });
});
