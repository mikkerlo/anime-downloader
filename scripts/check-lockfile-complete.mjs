#!/usr/bin/env node
// CI gate: every dependency edge in `package-lock.json` resolves to an entry in
// the same file (#649).
//
// npm 10 and npm 11 up to 11.6.1 count an optional edge with no target as valid,
// so a lockfile missing an optional subtree installs cleanly there. npm 11.6.2
// (arborist 9.1.6) re-resolves every node with a missing edge, optional ones
// included, and `npm ci` then fails with "Missing: … from lock file". The #337
// regeneration dropped `@electron/windows-sign` and its subtree that way, and
// CI, on Node 20's npm 10, never noticed.
//
// The walk: each package entry's `dependencies`, `optionalDependencies` and
// required `peerDependencies` (a peer marked optional in `peerDependenciesMeta`
// is skipped), plus the root entry's `devDependencies`. Each name is looked up
// through Node's `node_modules` ancestry: the entry's own `node_modules`, then
// each enclosing package's, then the root's. An edge that finds nothing is
// printed as `<from> -<kind>-> <name>`.
//
// It models where a package resolves, not which version: an entry present at a
// version outside the edge's range passes here, and npm 10's `npm ci` already
// rejects that as "Invalid". It reads one file and needs no network and no
// `node_modules`.
//
// Run: npm run check:lockfile-complete
//   or: node scripts/check-lockfile-complete.mjs <path/to/package-lock.json>

import { readFileSync } from 'node:fs'

const ROOT_LABEL = '(root)'

// The directory whose `node_modules` is searched after `dir`'s own. Package
// names may be scoped (`@s/a`), so the parent is found by cutting at the last
// `/node_modules/`, never by popping `/`-separated segments.
function parentDir(dir) {
  if (dir === '') return null
  const cut = dir.lastIndexOf('/node_modules/')
  return cut >= 0 ? dir.slice(0, cut) : ''
}

function resolves(packages, from, name) {
  for (let dir = from; dir !== null; dir = parentDir(dir)) {
    const key = dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`
    if (Object.hasOwn(packages, key)) return true
  }
  return false
}

function edgesOf(from, entry) {
  const edges = []
  const add = (kind, names) => {
    for (const name of names) edges.push({ kind, name })
  }
  add('dependencies', Object.keys(entry.dependencies ?? {}))
  add('optionalDependencies', Object.keys(entry.optionalDependencies ?? {}))
  const peerMeta = entry.peerDependenciesMeta ?? {}
  add(
    'peerDependencies',
    Object.keys(entry.peerDependencies ?? {}).filter((name) => !peerMeta[name]?.optional)
  )
  if (from === '') add('devDependencies', Object.keys(entry.devDependencies ?? {}))
  return edges
}

export function missingEdges(lock) {
  const packages = lock?.packages ?? {}
  const missing = []
  for (const [from, entry] of Object.entries(packages)) {
    if (entry.link) continue
    for (const { kind, name } of edgesOf(from, entry)) {
      if (!resolves(packages, from, name)) {
        missing.push(`${from === '' ? ROOT_LABEL : from} -${kind}-> ${name}`)
      }
    }
  }
  return missing
}

function main() {
  const path = process.argv[2] ?? 'package-lock.json'
  const lock = JSON.parse(readFileSync(path, 'utf8'))
  const missing = missingEdges(lock)
  if (missing.length === 0) {
    console.log(`${path}: every dependency edge resolves.`)
    return
  }
  console.error(
    `${path}: ${missing.length} dependency edge(s) resolve to no entry in the lockfile:\n`
  )
  for (const line of missing) console.error(`  ${line}`)
  console.error(
    '\nnpm >= 11.6.2 rejects this lockfile in `npm ci`. Refresh it with\n' +
      '`npx -y npm@11 install --package-lock-only --ignore-scripts` (see docs/build.md).'
  )
  process.exit(1)
}

if (process.argv[1]?.endsWith('check-lockfile-complete.mjs')) main()
