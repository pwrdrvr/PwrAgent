export type GitRemote = { name: string; url: string };
export type GitRemoteConfiguration = { names: string[]; remotes: GitRemote[]; hasConditionalIncludes?: true };

type FetchUrlRewrite = { base: string; prefix: string };

function isSingleBranchOriginFetch(value: string): boolean {
  const match = /^\+refs\/heads\/([A-Za-z0-9_./-]+):refs\/remotes\/origin\/\1$/.exec(value);
  if (!match || match[0] !== value) return false;
  const [, branch] = match;
  return !branch.includes("..") && !branch.endsWith(".") && branch.split("/").every((component) =>
    /^[A-Za-z0-9_]/.test(component) && !component.endsWith(".lock"));
}

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
export function parseGitRemoteConfiguration(stdout: string, allowSingleBranchOrigin = false): GitRemoteConfiguration | undefined {
  const records = stdout.split("\0");
  if (records.pop() !== "") return undefined;
  return parseGitRemoteConfigRecords(records, allowSingleBranchOrigin);
}

export function parseGitRemoteConfigRecords(records: string[], allowSingleBranchOrigin = false): GitRemoteConfiguration | undefined {
  if (records.length % 2 !== 0) return undefined;
  const fetchUrls = new Map<string, string[]>();
  const configuredInRepository = new Set<string>();
  const rewrites: FetchUrlRewrite[] = [];
  let hasConditionalIncludes: true | undefined;
  let singleBranchOrigin = false;
  let originFetchCount = 0;
  let canonicalOrigin = true;
  for (let index = 0; index < records.length; index += 2) {
    const scope = records[index];
    if (!/^(system|global|local|worktree|command)$/.test(scope)) return undefined;
    const record = records[index + 1];
    const newline = record.indexOf("\n");
    const key = newline < 0 ? record : record.slice(0, newline);
    const value = newline < 0 ? undefined : record.slice(newline + 1);
    if (key.startsWith("includeif.")) hasConditionalIncludes = true;
    if (key.startsWith("url.")) canonicalOrigin = false;
    if (key === "transfer.credentialsinurl" && value !== "allow" && value !== "warn" && value !== "die") canonicalOrigin = false;
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
    if (key.startsWith("remote.")) {
      if (scope !== "local" || (key !== "remote.origin.url" && key !== "remote.origin.fetch")) canonicalOrigin = false;
      if (key === "remote.origin.fetch") originFetchCount++;
    }
    if (!key.startsWith("remote.") || key === "remote.pushdefault") continue;
    const match = /^remote\.([A-Za-z0-9_][A-Za-z0-9_./-]*)\.(url|pushurl|fetch)$/.exec(key);
    if (!match || value === undefined) return undefined;
    const [, name, field] = match;
    if (name.includes("..") || name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock")) || name.endsWith(".")) return undefined;
    if (scope === "local" || scope === "worktree") configuredInRepository.add(name);
    let urls = fetchUrls.get(name);
    if (!urls) fetchUrls.set(name, urls = []);
    if (field === "fetch" && value !== `+refs/heads/*:refs/remotes/${name}/*`) {
      if (!allowSingleBranchOrigin || name !== "origin" || !isSingleBranchOriginFetch(value)) return undefined;
      singleBranchOrigin = true;
    }
    if (field !== "url") continue;
    // Git's handling of an empty URL has changed across versions. Multiline
    // values also need the same interpretation as the original Git command.
    if (!value.trim() || /[\r\n]/.test(value)) return undefined;
    urls.push(value);
  }

  if (singleBranchOrigin) {
    const urls = fetchUrls.get("origin");
    // Only accept one local URL and one matching fetch refspec. Native remote
    // lookup validates URL userinfo against Git's transfer.credentialsInUrl.
    if (!canonicalOrigin || hasConditionalIncludes || originFetchCount !== 1 || urls?.length !== 1
      || urls[0].includes("\uFFFD") || /:\/\/[^/?#]*@/.test(urls[0])) return undefined;
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
