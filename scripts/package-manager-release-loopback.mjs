#!/usr/bin/env node

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyFile, stableVersion, SOURCE_REPO } from "./package-manager-release.mjs";

export function installationCopy(contents, version, base) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error("Installation mirror must use loopback");
  const url = `https://github.com/${SOURCE_REPO}/releases/download/v${version}/PwrAgent-${version}-windows-x64-setup.exe`;
  const lines = contents.split(/(?<=\n)/);
  let changed = 0;
  const result = lines.map((line) => {
    if (!line.trimStart().startsWith("InstallerUrl:")) return line;
    if (line.trim() !== `InstallerUrl: ${url}`) throw new Error("Unexpected production InstallerUrl");
    changed++;
    return line.replace(url, `${base}/PwrAgent-${version}-windows-x64-setup.exe`);
  }).join("");
  if (contents.includes("InstallerUrl:") && changed !== 2) throw new Error("Expected both user and machine installer URLs");
  return result;
}

export async function serveInstallers(dir, plan, onRequest = () => {}) {
  const files = new Map();
  for (const role of ["current", "previous"]) {
    const release = plan[role];
    const asset = release.assets.find(({ name }) => name === `PwrAgent-${stableVersion(release)}-windows-x64-setup.exe`);
    const file = resolve(dir, "assets", role === "previous" ? "previous" : "", asset.name);
    await verifyFile(file, asset, asset.digest.slice(7));
    files.set(`/${asset.name}`, { file, asset });
  }
  const server = createServer((req, res) => {
    const entry = files.get(req.url);
    if (!entry || !["GET", "HEAD"].includes(req.method)) { res.writeHead(404).end(); return; }
    const { file, asset } = entry;
    let start = 0;
    let end = asset.size - 1;
    let status = 200;
    if (req.headers.range) {
      const range = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
      if (!range) { res.writeHead(416).end(); return; }
      start = Number(range[1]);
      end = range[2] ? Number(range[2]) : end;
      if (start > end || end >= asset.size) { res.writeHead(416).end(); return; }
      status = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${asset.size}`);
    }
    res.writeHead(status, { "Content-Length": end - start + 1, "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes" });
    onRequest({ name: asset.name, method: req.method, start, end });
    if (req.method === "HEAD") res.end();
    else {
      const stream = createReadStream(file, { start, end });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export async function writeInstallationCopies(dir, plan, base) {
  for (const role of ["current", "previous"]) {
    const version = stableVersion(plan[role]);
    for (const [path, contents] of Object.entries(plan.files[role])) {
      if (!path.endsWith(".yaml")) continue;
      const production = await readFile(resolve(dir, role, path), "utf8");
      if (production.replaceAll("\r\n", "\n") !== contents) throw new Error("Production manifest differs from planned validation input");
      const file = resolve(dir, "installation", role, path);
      await mkdir(resolve(file, ".."), { recursive: true });
      await writeFile(file, installationCopy(production, version, base));
    }
  }
}

async function main([dir, ready]) {
  const plan = JSON.parse(await readFile(resolve(dir, "plan.json"), "utf8"));
  const { server, base } = await serveInstallers(dir, plan, (request) => console.log(JSON.stringify(request)));
  try {
    await writeInstallationCopies(dir, plan, base);
    await writeFile(ready, JSON.stringify({ base }));
  } catch (error) { server.close(); throw error; }
  process.on("SIGTERM", () => server.close());
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
