import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkNpmDependencyLicenses } from "../../../scripts/check-third-party-license-allowlist.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(root, "apps/mobile/assets/licenses.json");
if (process.argv.includes("--check")) {
  const data = JSON.parse(fs.readFileSync(output, "utf8"));
  const failures = checkNpmDependencyLicenses(data.packages);
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(`${data.packages.length} bundled mobile package licenses allowed`);
} else {
  const map = process.argv[2];
  if (!map) throw new Error("Pass the iOS production export source map after expo export --platform ios --source-maps");
  const sources = JSON.parse(fs.readFileSync(map, "utf8")).sources;
  const records = new Map();
  for (const source of sources) {
    if (!source.startsWith("/node_modules/")) continue;
    let directory = path.dirname(path.join(root, source));
    while (directory.startsWith(root)) {
      const manifest = path.join(directory, "package.json");
      if (fs.existsSync(manifest)) {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (pkg.name && pkg.version) {
          const licenses = fs.readdirSync(directory).filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
          let text = licenses.filter((name) => fs.statSync(path.join(directory, name)).isFile())
            .map((name) => fs.readFileSync(path.join(directory, name), "utf8")).join("\n\n");
          const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
          if (!text && repository === "https://github.com/expo/expo.git") text = fs.readFileSync(path.join(root, "apps/mobile/assets/expo-LICENSE"), "utf8");
          if (!text && repository === "git+https://github.com/react/react-native.git") text = fs.readFileSync(path.join(root, "apps/mobile/node_modules/react-native/LICENSE"), "utf8");
          if (!text) throw new Error(`Missing license text: ${pkg.name}`);
          records.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, declaredLicense: pkg.license, text });
          break;
        }
      }
      directory = path.dirname(directory);
    }
  }
  const packages = [...records.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!packages.length) throw new Error("No bundled dependencies found");
  const failures = checkNpmDependencyLicenses(packages);
  if (failures.length) throw new Error(failures.join("\n"));
  const plist = path.join(root, "apps/mobile/ios/Pods/Target Support Files/Pods-PwrAgent/Pods-PwrAgent-acknowledgements.plist");
  const native = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" })).PreferenceSpecifiers
    .filter((entry) => entry.Title && entry.FooterText).map((entry) => ({ name: entry.Title, text: entry.FooterText }));
  fs.writeFileSync(output, `${JSON.stringify({ packages, native }, null, 2)}\n`);
  console.log(`Retained ${packages.length} allowed bundled package licenses and ${native.length} native notices`);
}
