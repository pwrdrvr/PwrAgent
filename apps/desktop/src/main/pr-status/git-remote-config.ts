export type GitRemote = { name: string; url: string };
export type GitRemoteConfiguration = { names: string[]; remotes: GitRemote[]; hasConditionalIncludes?: true };

type FetchUrlRewrite = { base: string; prefix: string };

function rewriteFetchUrl(url: string, rewrites: FetchUrlRewrite[]): string | undefined {
  // Git uses the longest prefix and applies the rewrite once. Defer ties in
  // which bases disagree so Git keeps ownership of precedence between them.
  let winner: FetchUrlRewrite | undefined;
  let tied = false;
  for (const rewrite of rewrites) {
    if (!url.startsWith(rewrite.prefix)) continue;
    if (!winner || rewrite.prefix.length > winner.prefix.length) {
      winner = rewrite;
      tied = false;
    } else if (rewrite.prefix.length === winner.prefix.length && rewrite.base !== winner.base) {
      tied = true;
    }
  }
  if (tied) return undefined;
  return winner ? winner.base + url.slice(winner.prefix.length) : url;
}

/**
 * Decode Git's effective config for ordinary fetch remotes. Git evaluates all
 * scopes and includes in the checkout. Layouts whose remote meaning also
 * depends on Git's remote machinery fall back to `remote get-url --all`.
 */
export function parseGitRemoteConfiguration(stdout: string): GitRemoteConfiguration | undefined {
  const records = stdout.split("\0");
  if (records.pop() !== "" || records.length % 2 !== 0) return undefined;
  const fetchUrls = new Map<string, string[]>();
  const configuredInRepository = new Set<string>();
  const rewrites: FetchUrlRewrite[] = [];
  let hasConditionalIncludes: true | undefined;
  for (let index = 0; index < records.length; index += 2) {
    const scope = records[index];
    if (!/^(system|global|local|worktree|command)$/.test(scope)) return undefined;
    const record = records[index + 1];
    const newline = record.indexOf("\n");
    const key = newline < 0 ? record : record.slice(0, newline);
    const value = newline < 0 ? undefined : record.slice(newline + 1);
    if (key.startsWith("includeif.")) hasConditionalIncludes = true;
    const rewrite = /^url\.(.*)\.(insteadof|pushinsteadof)$/.exec(key);
    if (rewrite) {
      if (value === undefined) return undefined;
      if (rewrite[2] === "insteadof") {
        if (!rewrite[1] || /[\r\n]/.test(value)) return undefined;
        rewrites.push({ base: rewrite[1], prefix: value });
      }
    }
    if (key === "remote.pushdefault" || /^branch\..*\.(?:remote|pushremote|merge)$/.test(key)) {
      if (value === undefined) return undefined;
    }
    if (!key.startsWith("remote.") || key === "remote.pushdefault") continue;
    const match = /^remote\.([A-Za-z0-9_][A-Za-z0-9_./-]*)\.(url|pushurl|fetch)$/.exec(key);
    if (!match || value === undefined) return undefined;
    const [, name, field] = match;
    if (name.includes("..") || name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock")) || name.endsWith(".")) return undefined;
    if (scope === "local" || scope === "worktree") configuredInRepository.add(name);
    let urls = fetchUrls.get(name);
    if (!urls) fetchUrls.set(name, urls = []);
    if (field === "fetch" && value !== `+refs/heads/*:refs/remotes/${name}/*`) return undefined;
    if (field !== "url") continue;
    // Git's handling of an empty URL has changed across versions. Multiline
    // values also need the same interpretation as the original Git command.
    if (!value.trim() || /[\r\n]/.test(value)) return undefined;
    urls.push(value);
  }

  const names = [...fetchUrls.keys()].sort();
  const remotes: GitRemote[] = [];
  for (const name of names) {
    const urls = fetchUrls.get(name)!;
    // An unconfigured URL can be supplied by the legacy remotes/ or branches/
    // layouts. Git also decides which global-only remotes are usable.
    if (!configuredInRepository.has(name) || urls.length === 0) return undefined;
    const effective = new Set<string>();
    for (const rawUrl of urls) {
      const url = rewriteFetchUrl(rawUrl, rewrites)?.trim();
      if (!url || /[\r\n]/.test(url)) return undefined;
      effective.add(url);
    }
    for (const url of effective) remotes.push({ name, url });
  }
  return hasConditionalIncludes ? { names, remotes, hasConditionalIncludes } : { names, remotes };
}
