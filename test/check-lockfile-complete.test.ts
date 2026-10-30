// Fixtures for the lockfile-completeness gate (#649). npm 10 accepts a lockfile
// whose optional edge resolves to nothing, and npm >= 11.6.2 rejects it in
// `npm ci`; CI runs npm 10, so this check is what keeps the two in step. The
// fixtures pin the parts of the walk most likely to be written wrong: optional
// edges, the `node_modules` ancestry (including through scoped names and not
// into cousins), and which peers count.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

import {
  missingEdges
  // @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig
  // graph. The directive sits on the module specifier, not on `import`, because
  // TS7016 is reported at the `from` clause.
} from '../scripts/check-lockfile-complete.mjs'

type Entry = {
  version?: string
  link?: boolean
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const ROOT = join(import.meta.dirname, '..')
const SCRIPT = join(ROOT, 'scripts', 'check-lockfile-complete.mjs')

const lock = (packages: Record<string, Entry>): { packages: Record<string, Entry> } => ({
  packages: { '': { version: '1.0.0' }, ...packages }
})

const missing = (packages: Record<string, Entry>): string[] =>
  missingEdges(lock(packages)) as string[]

const read = (...p: string[]): string => {
  try {
    return fs.readFileSync(join(ROOT, ...p), 'utf8')
  } catch {
    return ''
  }
}

describe('check-lockfile-complete', () => {
  // Case 1. On the pre-#649 lockfile this reported
  // `node_modules/electron-winstaller -optionalDependencies-> @electron/windows-sign`.
  it("finds no missing edge in the repo's own package-lock.json", () => {
    expect(missingEdges(JSON.parse(read('package-lock.json')))).toEqual([])
  })

  // Case 2: the npm 11.6.2 case. npm 10 counts this edge as valid.
  it('reports an optionalDependencies edge with no package entry', () => {
    expect(
      missing({
        'node_modules/winstaller': { optionalDependencies: { 'windows-sign': '^1.1.2' } }
      })
    ).toEqual(['node_modules/winstaller -optionalDependencies-> windows-sign'])
    expect(
      missing({
        'node_modules/winstaller': { optionalDependencies: { 'windows-sign': '^1.1.2' } },
        'node_modules/windows-sign': {}
      })
    ).toEqual([])
  })

  // Case 3.
  it('reports a dependencies edge with no package entry', () => {
    expect(missing({ 'node_modules/a': { dependencies: { b: '^1.0.0' } } })).toEqual([
      'node_modules/a -dependencies-> b'
    ])
    expect(
      missing({ 'node_modules/a': { dependencies: { b: '^1.0.0' } }, 'node_modules/b': {} })
    ).toEqual([])
  })

  // Case 4.
  describe('resolution through the node_modules ancestry', () => {
    const b = { dependencies: { c: '^1.0.0' } }

    it('is satisfied by a root node_modules/c', () => {
      expect(
        missing({
          'node_modules/a': {},
          'node_modules/a/node_modules/b': b,
          'node_modules/c': {}
        })
      ).toEqual([])
    })

    it("is satisfied by the enclosing package's node_modules/a/node_modules/c", () => {
      expect(
        missing({
          'node_modules/a': {},
          'node_modules/a/node_modules/b': b,
          'node_modules/a/node_modules/c': {}
        })
      ).toEqual([])
    })

    it("is satisfied by the entry's own node_modules", () => {
      expect(
        missing({
          'node_modules/a': {},
          'node_modules/a/node_modules/b': b,
          'node_modules/a/node_modules/b/node_modules/c': {}
        })
      ).toEqual([])
    })

    // A suffix match on `node_modules/c` would accept this.
    it('is not satisfied by a cousin at node_modules/x/node_modules/c', () => {
      expect(
        missing({
          'node_modules/a': {},
          'node_modules/a/node_modules/b': b,
          'node_modules/x': {},
          'node_modules/x/node_modules/c': {}
        })
      ).toEqual(['node_modules/a/node_modules/b -dependencies-> c'])
    })

    // The walk must step over `@s/a` as one package. Popping `/` segments
    // yields a bogus `node_modules/@s` parent.
    it('walks through a scoped package to a root node_modules/c', () => {
      expect(
        missing({
          'node_modules/@s/a': {},
          'node_modules/@s/a/node_modules/b': b,
          'node_modules/c': {}
        })
      ).toEqual([])
    })

    it('does not search a bogus node_modules/@s/node_modules/c', () => {
      expect(
        missing({
          'node_modules/@s/a': {},
          'node_modules/@s/a/node_modules/b': b,
          'node_modules/@s/node_modules/c': {}
        })
      ).toEqual(['node_modules/@s/a/node_modules/b -dependencies-> c'])
    })

    // From a scoped entry, popping two segments lands on the bogus
    // `node_modules/a/node_modules` and skips `node_modules/a`.
    it("walks from a scoped entry to its enclosing package's node_modules/a/node_modules/c", () => {
      expect(
        missing({
          'node_modules/a': {},
          'node_modules/a/node_modules/@s/b': b,
          'node_modules/a/node_modules/c': {}
        })
      ).toEqual([])
    })

    it('resolves scoped names', () => {
      expect(
        missing({
          'node_modules/a': { dependencies: { '@s/c': '^1.0.0', '@s/d': '^1.0.0' } },
          'node_modules/@s/c': {}
        })
      ).toEqual(['node_modules/a -dependencies-> @s/d'])
    })
  })

  // Case 5.
  describe('peers', () => {
    it('does not require a peer marked optional in peerDependenciesMeta', () => {
      expect(
        missing({
          'node_modules/a': {
            peerDependencies: { p: '*' },
            peerDependenciesMeta: { p: { optional: true } }
          }
        })
      ).toEqual([])
    })

    it('reports a required peer with no entry', () => {
      expect(
        missing({
          'node_modules/a': {
            peerDependencies: { p: '*', q: '*' },
            peerDependenciesMeta: { q: { optional: true } }
          }
        })
      ).toEqual(['node_modules/a -peerDependencies-> p'])
      expect(
        missing({ 'node_modules/a': { peerDependencies: { p: '*' } }, 'node_modules/p': {} })
      ).toEqual([])
    })
  })

  // Case 6.
  it("checks the root entry's devDependencies, and only the root's", () => {
    expect(
      missingEdges({
        packages: {
          '': { devDependencies: { tool: '^1.0.0', other: '^1.0.0' } },
          'node_modules/other': {},
          'node_modules/a': { devDependencies: { 'not-installed': '^1.0.0' } }
        }
      })
    ).toEqual(['(root) -devDependencies-> tool'])
  })

  describe('CLI', () => {
    const runOn = (packages: Record<string, Entry>): ReturnType<typeof spawnSync> => {
      const dir = fs.mkdtempSync(join(os.tmpdir(), 'lockfile-complete-'))
      try {
        const file = join(dir, 'package-lock.json')
        fs.writeFileSync(file, JSON.stringify(lock(packages)))
        return spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' })
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }

    it('exits 1 and names each missing edge', () => {
      const r = runOn({ 'node_modules/a': { optionalDependencies: { b: '^1.0.0' } } })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('  node_modules/a -optionalDependencies-> b\n')
    })

    it('exits 0 on a complete lockfile', () => {
      const r = runOn({ 'node_modules/a': { dependencies: { b: '^1.0.0' } }, 'node_modules/b': {} })
      expect(r.status).toBe(0)
    })
  })

  describe('wiring', () => {
    const quality = (): string => {
      const yml = read('.github', 'workflows', 'check.yml')
      const start = yml.indexOf('\n  quality:\n')
      if (start < 0) return ''
      const rest = yml.slice(start + 1)
      const next = rest.slice(1).search(/\n {2}[a-z]/)
      return next < 0 ? rest : rest.slice(0, next + 1)
    }
    const runLines = (job: string): string[] =>
      job
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .map((line) => line.trim())
        .filter((line) => /^(- )?run: /.test(line))
        .map((line) => line.replace(/^(- )?run: /, ''))

    it('package.json defines check:lockfile-complete', () => {
      const pkg = JSON.parse(read('package.json'))
      expect(pkg.scripts['check:lockfile-complete']).toBe(
        'node scripts/check-lockfile-complete.mjs'
      )
    })

    it('quality runs check:lockfile-complete before its npm ci', () => {
      const runs = runLines(quality())
      const check = runs.indexOf('npm run check:lockfile-complete')
      const ci = runs.indexOf('npm ci')
      expect(check).toBeGreaterThanOrEqual(0)
      expect(ci).toBeGreaterThan(check)
    })
  })
})
