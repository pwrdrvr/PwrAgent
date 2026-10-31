import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  htmlPreviewAssetPath,
  readHtmlPreviewAssets,
} from "../html-preview-assets";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("readHtmlPreviewAssets", () => {
  let root: string;
  let page: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "html-preview-assets-")));
    await mkdir(path.join(root, "site", "img"), { recursive: true });
    page = path.join(root, "site", "index.html");
    await writeFile(page, "<img src=\"img/logo.png\">");
    await writeFile(path.join(root, "site", "img", "logo.png"), PNG);
    await writeFile(path.join(root, "site", "style.css"), "body { color: red; }");
    await writeFile(path.join(root, "site", "notes.txt"), "not an asset");
    await writeFile(path.join(root, "secret.png"), PNG);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("inlines images and stylesheets beside the page", async () => {
    const response = await readHtmlPreviewAssets({
      path: page,
      refs: ["img/logo.png", "./style.css?v=2", "img/logo.png"],
    });

    expect(response.skipped).toEqual([]);
    expect(response.assets).toEqual([
      { ref: "img/logo.png", dataUrl: `data:image/png;base64,${PNG.toString("base64")}` },
      {
        ref: "./style.css?v=2",
        dataUrl: `data:text/css;base64,${Buffer.from("body { color: red; }").toString("base64")}`,
      },
    ]);
  });

  it("takes absolute paths and file URLs that stay inside the folder", async () => {
    const logo = path.join(root, "site", "img", "logo.png");
    const response = await readHtmlPreviewAssets({
      path: page,
      refs: [logo, pathToFileURL(logo).href],
    });

    expect(response.assets.map((asset) => asset.ref)).toEqual([logo, pathToFileURL(logo).href]);
  });

  it("refuses files outside the page's folder, however they are named", async () => {
    await symlink(path.join(root, "secret.png"), path.join(root, "site", "img", "linked.png"));

    const response = await readHtmlPreviewAssets({
      path: page,
      refs: [
        "../secret.png",
        "img/../../secret.png",
        path.join(root, "secret.png"),
        pathToFileURL(path.join(root, "secret.png")).href,
        "img/linked.png",
      ],
    });

    expect(response.assets).toEqual([]);
    expect(response.skipped.map((skip) => skip.reason)).toEqual([
      "outside-folder",
      "outside-folder",
      "outside-folder",
      "outside-folder",
      "outside-folder",
    ]);
  });

  it("refuses files under hidden directories, even inside the folder", async () => {
    await mkdir(path.join(root, "site", ".config", "tool"), { recursive: true });
    await writeFile(path.join(root, "site", ".config", "tool", "config.js"), "export const token = 1;");
    await writeFile(path.join(root, "site", ".hidden.png"), PNG);

    const response = await readHtmlPreviewAssets({
      path: page,
      refs: [".config/tool/config.js", ".hidden.png", "img/logo.png"],
    });

    expect(response.assets.map((asset) => asset.ref)).toEqual(["img/logo.png"]);
    expect(response.skipped).toEqual([
      { ref: ".config/tool/config.js", reason: "outside-folder" },
      { ref: ".hidden.png", reason: "outside-folder" },
    ]);
  });

  it("keeps the page order when many files load at once", async () => {
    const refs = Array.from({ length: 20 }, (_, index) => `img/${index}.png`);
    await Promise.all(refs.map((ref) => writeFile(path.join(root, "site", ref), PNG)));

    const response = await readHtmlPreviewAssets({ path: page, refs: [...refs, "img/missing.png"] });

    expect(response.assets.map((asset) => asset.ref)).toEqual(refs);
    expect(response.skipped).toEqual([{ ref: "img/missing.png", reason: "missing" }]);
  });

  it("refuses files a page has no reason to load, and says which are missing", async () => {
    const response = await readHtmlPreviewAssets({
      path: page,
      refs: ["notes.txt", "img/missing.png", "https://example.com/a.png", "//example.com/a.png"],
    });

    expect(response.assets).toEqual([]);
    expect(response.skipped).toEqual([
      { ref: "notes.txt", reason: "unsupported-type" },
      { ref: "img/missing.png", reason: "missing" },
      { ref: "https://example.com/a.png", reason: "outside-folder" },
      { ref: "//example.com/a.png", reason: "outside-folder" },
    ]);
  });

  it("reads nothing for a page that is not HTML or belongs to a peer", async () => {
    await expect(readHtmlPreviewAssets({
      path: path.join(root, "site", "notes.txt"),
      refs: ["img/logo.png"],
    })).resolves.toMatchObject({ assets: [], error: "This file is not an HTML page." });

    await expect(readHtmlPreviewAssets({
      path: page,
      refs: ["img/logo.png"],
      federationTarget: { scope: "remote", instanceId: "peer" },
    })).resolves.toMatchObject({ assets: [], error: expect.stringContaining("peer") });
  });
});

describe("htmlPreviewAssetPath", () => {
  it("decodes a relative ref and drops its query and fragment", () => {
    expect(htmlPreviewAssetPath("/site", "img/my%20logo.png?v=1#x")).toBe(path.resolve("/site/img/my logo.png"));
  });

  it.each(["", "#top", "data:image/png;base64,AA", "mailto:a@example.com", "//cdn.example.com/a.png"])(
    "names no local file for %j",
    (ref) => {
      expect(htmlPreviewAssetPath("/site", ref)).toBeUndefined();
    },
  );
});
