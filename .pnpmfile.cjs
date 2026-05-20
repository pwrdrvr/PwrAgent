'use strict'

// Fields scanned on every package (first-party and transitive).
// pnpm never installs a transitive package's devDependencies, so we
// only enforce git-spec blocking on devDependencies for our own
// first-party packages — the fields below are the ones whose specs
// pnpm WILL try to resolve regardless of who declared them.
const dependencyFields = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]

const firstPartyPackageNames = new Set(['pwragent-workspace'])
const firstPartyPackagePrefix = '@pwragent/'

function isFirstParty(pkg) {
  if (!pkg || typeof pkg.name !== 'string') return false
  if (firstPartyPackageNames.has(pkg.name)) return true
  return pkg.name.startsWith(firstPartyPackagePrefix)
}

const gitSpecPattern = /^(?:git(?:\+|:)|git@|ssh:\/\/git@|github:|gitlab:|bitbucket:|https?:\/\/(?:www\.)?(?:github|gitlab|bitbucket)\.com\/|[^/@\s]+\/[^/\s]+(?:#.*)?$)/

function isGitSpec(spec) {
  return typeof spec === 'string' && gitSpecPattern.test(spec)
}

function scanField(pkg, field) {
  const dependencies = pkg[field]
  if (!dependencies) return
  for (const [name, spec] of Object.entries(dependencies)) {
    if (isGitSpec(spec)) {
      throw new Error(`Blocked git dependency ${name}@${spec} (in ${pkg.name ?? '<unknown>'}.${field})`)
    }
  }
}

function readPackage(pkg) {
  // Protobufjs publishes an unused transitive devDependency as a GitHub spec.
  // Strip it before enforcing the registry-only dependency policy. Even
  // though devDependencies of non-first-party packages are no longer scanned
  // below (and pnpm never installs them either), keeping the explicit strip
  // means pnpm doesn't even materialize the spec in its resolver graph —
  // defense in depth, and an audit trail for the specific upstream issue.
  if (
    pkg.name === 'protobufjs' &&
    pkg.devDependencies?.['jaguarjs-jsdoc'] === 'github:dcodeIO/jaguarjs-jsdoc'
  ) {
    delete pkg.devDependencies['jaguarjs-jsdoc']
  }
  for (const field of dependencyFields) {
    scanField(pkg, field)
  }
  if (isFirstParty(pkg)) {
    // First-party packages also block git specs in devDependencies so a
    // PR can't slip a git devDep into our own workspace. Transitive
    // devDependencies are never installed by pnpm and the fetchers.git
    // hook below still refuses any actual git clone — so we don't need
    // to gate them here and the false positive on legitimate upstream
    // packages (e.g. axe-core's axe-test-fixtures) goes away.
    scanField(pkg, 'devDependencies')
  }
  return pkg
}

function blockGitFetcher() {
  return async () => {
    throw new Error('Blocked pnpm git dependency fetch')
  }
}

module.exports = {
  hooks: {
    readPackage,
    fetchers: {
      git: blockGitFetcher,
      gitHostedTarball: blockGitFetcher,
    },
  },
}
