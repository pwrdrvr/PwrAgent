// Read literal package metadata without executing Ruby or resolving YAML tags.
// Unknown/dynamic layouts remain unverifiable rather than passing a partial read.
const stable = (value) => /^\d+\.\d+\.\d+$/.test(value ?? "");
const quoted = (value) => {
  const match = /^(?:"([^"\\]*)"|'([^'\\]*)')\s*(?:#.*)?$/.exec(value.trim());
  if (!match) throw new Error("Expected literal quoted package metadata");
  return match[1] ?? match[2];
};

function literalCaskScope(text) {
  let scope = "outside";
  let continuation;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (scope === "outside" && /^cask ["']pwragent["'] do\s*(?:#.*)?$/.test(line)) {
      scope = "cask";
      continue;
    }
    if (scope === "livecheck") {
      if (/^  end\s*(?:#.*)?$/.test(line)) scope = "cask";
      else if (!/^    (?:url :url|strategy :github_latest)\s*(?:#.*)?$/.test(line)) {
        throw new Error("Unsupported cask livecheck layout");
      }
      continue;
    }
    if (scope !== "cask") throw new Error("Unsupported cask scope or control flow");
    if (/^end\s*(?:#.*)?$/.test(line)) {
      scope = "closed";
      continue;
    }
    if (/^  livecheck do\s*(?:#.*)?$/.test(line)) {
      scope = "livecheck";
      continuation = undefined;
      continue;
    }
    const statement = /^  (arch|version|sha256|url|name|desc|homepage|auto_updates|depends_on|app)[ \t]+(.+)$/.exec(line);
    if (!statement) {
      if (["arch", "sha256"].includes(continuation) && /^ {3,}(?:arm|intel):[ \t]+/.test(line)) continue;
      throw new Error("Unsupported cask declaration scope or control flow");
    }
    continuation = statement[1];
    if (["name", "desc", "homepage", "app"].includes(statement[1])) {
      if (quoted(statement[2]).includes("#{")) throw new Error("Unsupported cask interpolation");
    } else if (statement[1] === "auto_updates" && !/^(?:true|false)\s*(?:#.*)?$/.test(statement[2])) {
      throw new Error("Unsupported cask auto_updates declaration");
    } else if (statement[1] === "depends_on" && !/^macos:\s*:[a-z_]+\s*(?:#.*)?$/.test(statement[2])) {
      throw new Error("Unsupported cask dependency declaration");
    }
  }
  if (scope !== "closed") throw new Error("Incomplete literal cask scope");
}

export function caskMetadata(text) {
  if (!/^\s*cask ["']pwragent["'] do\s*(?:#.*)?$/m.test(text)) throw new Error("Unexpected cask identity");
  literalCaskScope(text);
  const field = (name) => {
    const values = [...text.matchAll(new RegExp(`^[ \\t]+${name}[ \\t]+([^\\n]+(?:\\n[ \\t]+(?:arm|intel):[^\\n]+)*)`, "gm"))];
    if (values.length !== 1) throw new Error(`Expected one literal cask ${name} stanza`);
    return values[0][1];
  };
  const mapping = (value) => {
    const clean = value.replace(/\s+#.*$/gm, "");
    const pairs = [...clean.matchAll(/(arm|intel):\s*(["'])([^"']+)\2/g)];
    const remainder = clean.replace(/(arm|intel):\s*(["'])([^"']+)\2/g, "").replace(/[\s,]/g, "");
    if (remainder || pairs.length !== 2 || new Set(pairs.map((pair) => pair[1])).size !== 2) {
      throw new Error("Expected literal arm/intel cask metadata");
    }
    return Object.fromEntries(pairs.map((pair) => [pair[1], pair[3]]));
  };
  const version = quoted(field("version"));
  const arch = mapping(field("arch"));
  const hashes = mapping(field("sha256"));
  // livecheck's `url :url` is not a download declaration.
  const urls = [...text.matchAll(/^[ \t]+url[ \t]+(["'][^\n]+)$/gm)];
  if (urls.length !== 1 || !stable(version) || arch.arm !== "arm64" || arch.intel !== "universal") {
    throw new Error("Unsupported cask version, URL or architectures");
  }
  const url = quoted(urls[0][1]);
  const interpolated = urls[0][1].trim().startsWith("\"");
  return { version, installers: ["arm", "intel"].map((key) => ({
    architecture: arch[key], sha256: hashes[key].toLowerCase(),
    url: interpolated ? url.replaceAll("#{version}", version).replaceAll("#{arch}", arch[key]) : url,
  })) };
}

export function wingetMetadata(text, identifier, version) {
  const fields = new Set(["PackageIdentifier", "PackageVersion", "Architecture", "Scope", "InstallerUrl", "InstallerSha256"]);
  const root = {};
  const installers = [];
  let inInstallers = false;
  let listIndent;
  let mappingIndent;
  let nestedMapping = false;
  const assign = (target, key, value) => {
    if (!fields.has(key)) return;
    if (Object.hasOwn(target, key)) throw new Error(`Duplicate Winget ${key}`);
    const scalar = /^["']/.test(value.trim()) ? quoted(value) : value.replace(/\s+#.*$/, "").trim();
    if (!scalar || /\s/.test(scalar) || /^[!&*\[\]{},>|]/.test(scalar)) throw new Error(`Unsupported Winget ${key} scalar`);
    target[key] = scalar;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^Installers:\s*(?:#.*)?$/.test(line)) {
      if (inInstallers || installers.length) throw new Error("Duplicate Winget Installers");
      inInstallers = true;
      continue;
    }
    const item = /^( *)(- +)([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (inInstallers && item && (listIndent === undefined || item[1].length === listIndent)) {
      listIndent ??= item[1].length;
      mappingIndent = item[1].length + item[2].length;
      const installer = {};
      installers.push(installer);
      assign(installer, item[3], item[4]);
      nestedMapping = !fields.has(item[3]) && /^\s*(?:#.*)?$/.test(item[4]);
      continue;
    }
    const field = /^( *)([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (!field) throw new Error("Unsupported Winget mapping layout");
    if (field[1].length === 0) {
      inInstallers = false;
      assign(root, field[2], field[3]);
    } else if (inInstallers && installers.length && field[1].length === mappingIndent) {
      assign(installers.at(-1), field[2], field[3]);
      nestedMapping = !fields.has(field[2]) && /^\s*(?:#.*)?$/.test(field[3]);
    } else if (!(inInstallers && nestedMapping && field[1].length > mappingIndent)) {
      throw new Error("Unsupported Winget mapping indentation");
    }
  }
  if (root.PackageIdentifier !== identifier || root.PackageVersion !== version || !stable(version)) {
    throw new Error("Unexpected Winget package identity/version");
  }
  const metadata = installers.map((item) => ({
    architecture: item.Architecture ?? root.Architecture,
    scope: item.Scope ?? root.Scope,
    url: item.InstallerUrl ?? root.InstallerUrl,
    sha256: (item.InstallerSha256 ?? root.InstallerSha256 ?? "").toLowerCase(),
  }));
  if (metadata.length !== 2 || new Set(metadata.map((item) => item.scope)).size !== 2
    || metadata.some((item) => item.architecture !== "x64" || !["user", "machine"].includes(item.scope))) {
    throw new Error("Unsupported Winget architectures/scopes");
  }
  return { version, installers: metadata };
}

export function installerFindings(channel, platform, release, repository) {
  const findings = [];
  for (const installer of channel.installers) {
    const name = platform === "macos" ? `PwrAgent-${channel.version}-${installer.architecture}.dmg`
      : `PwrAgent-${channel.version}-windows-x64-setup.exe`;
    const expected = `https://github.com/${repository}/releases/download/v${channel.version}/${name}`;
    const assets = release.assets?.filter((item) => item.name === name) ?? [];
    const finding = (kind, message) => findings.push({ kind, asset: name, message });
    if (installer.url !== expected || assets.length !== 1 || assets[0].browser_download_url !== expected) {
      finding("drift", "Published package URL or release asset identity differs");
    } else if (!/^[a-f0-9]{64}$/.test(installer.sha256) || !/^sha256:[a-f0-9]{64}$/.test(assets[0].digest ?? "")
      || !(assets[0].size > 0)) {
      finding("unverifiable", "Missing or invalid source checksum, release digest or asset size");
    } else if (assets[0].digest !== `sha256:${installer.sha256}`) {
      finding("drift", "Published package checksum differs from release digest");
    }
  }
  return findings;
}
