'use strict'

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

const gitSpecPattern = /^(?:git(?:\+|:)|git@|ssh:\/\/git@|github:|gitlab:|bitbucket:|https?:\/\/(?:www\.)?(?:github|gitlab|bitbucket)\.com\/|[^/@\s]+\/[^/\s]+(?:#.*)?$)/

function isGitSpec(spec) {
  return typeof spec === 'string' && gitSpecPattern.test(spec)
}

function readPackage(pkg) {
  // Protobufjs publishes an unused transitive devDependency as a GitHub spec.
  // Strip it before enforcing the registry-only dependency policy.
  if (
    pkg.name === 'protobufjs' &&
    pkg.devDependencies?.['jaguarjs-jsdoc'] === 'github:dcodeIO/jaguarjs-jsdoc'
  ) {
    delete pkg.devDependencies['jaguarjs-jsdoc']
  }

  for (const field of dependencyFields) {
    const dependencies = pkg[field]
    if (!dependencies) continue

    for (const [name, spec] of Object.entries(dependencies)) {
      if (isGitSpec(spec)) {
        throw new Error(`Blocked git dependency ${name}@${spec}`)
      }
    }
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
