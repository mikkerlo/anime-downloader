// Fixtures for the packaged-icon gate (#686). Each case writes synthetic asar
// archives into a tmpdir shaped like electron-builder's `dist/`, so the header
// parsing and the archive discovery are both exercised without packaging
// anything.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkDist,
  findArchives,
  missingEntries,
  readAsarHeader,
  REQUIRED_ENTRIES
  // @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig
  // graph. The directive sits on the module specifier, not on `import`, because
  // TS7016 is reported at the `from` clause.
} from '../scripts/check-packaged-icon.mjs'

type Tree = { files: Record<string, Tree | { size: number; offset: string }> }

const file = { size: 1, offset: '0' }

// Main's archive: the bundle and package.json, no `resources/`.
const MAIN_SHAPED: Tree = {
  files: {
    out: { files: { main: { files: { 'index.js': file } } } },
    'package.json': file
  }
}

const WITH_ICONS: Tree = {
  files: {
    ...MAIN_SHAPED.files,
    resources: { files: { 'icon.ico': file, 'icon.png': file } }
  }
}

// The on-disk layout: a size pickle (UInt32 4, then the header pickle's size),
// then the header pickle (payload size, string length, the JSON padded to 4).
function asar(header: Tree): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4)
  json.copy(padded)
  const pickle = Buffer.alloc(8 + padded.length)
  pickle.writeUInt32LE(4 + padded.length, 0)
  pickle.writeUInt32LE(json.length, 4)
  padded.copy(pickle, 8)
  const size = Buffer.alloc(8)
  size.writeUInt32LE(4, 0)
  size.writeUInt32LE(pickle.length, 4)
  return Buffer.concat([size, pickle, Buffer.from('file-bytes')])
}

let dist: string

function put(dir: string, header: Tree): string {
  mkdirSync(join(dist, dir), { recursive: true })
  const path = join(dist, dir, 'app.asar')
  writeFileSync(path, asar(header))
  return path
}

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'check-packaged-icon-'))
})

afterEach(() => {
  rmSync(dist, { recursive: true, force: true })
})

describe('check-packaged-icon', () => {
  it('reads the header JSON from a synthetic archive', () => {
    expect(readAsarHeader(put('linux-unpacked/resources', WITH_ICONS))).toEqual(WITH_ICONS)
  })

  it('reports both icons missing from a main-shaped archive', () => {
    const path = put('linux-unpacked/resources', MAIN_SHAPED)
    expect(missingEntries(readAsarHeader(path))).toEqual([
      'resources/icon.ico',
      'resources/icon.png'
    ])
    const result = checkDist(dist)
    expect(result.ok).toBe(false)
    expect(result.err).toEqual([
      `${path}: missing resources/icon.ico`,
      `${path}: missing resources/icon.png`
    ])
  })

  it('passes an archive carrying both icons', () => {
    put('linux-unpacked/resources', WITH_ICONS)
    expect(missingEntries(WITH_ICONS)).toEqual([])
    expect(checkDist(dist)).toMatchObject({ ok: true, err: [] })
  })

  it('reports the one icon that is missing', () => {
    const header: Tree = {
      files: { ...MAIN_SHAPED.files, resources: { files: { 'icon.png': file } } }
    }
    expect(missingEntries(header)).toEqual(['resources/icon.ico'])
  })

  it('does not take a directory named like an icon for the file', () => {
    const header: Tree = {
      files: {
        resources: { files: { 'icon.ico': { files: {} }, 'icon.png': file } }
      }
    }
    expect(missingEntries(header)).toEqual(['resources/icon.ico'])
  })

  it('requires exactly the two icon paths the main process loads', () => {
    expect(REQUIRED_ENTRIES).toEqual(['resources/icon.ico', 'resources/icon.png'])
  })

  it('finds the Windows, Linux and macOS archives, including a bundle name with a space', () => {
    const win = put('win-unpacked/resources', WITH_ICONS)
    const linux = put('linux-unpacked/resources', WITH_ICONS)
    const mac = put('mac-arm64/Anime DL.app/Contents/Resources', WITH_ICONS)
    mkdirSync(join(dist, 'extracted'))
    writeFileSync(join(dist, 'Anime-DL-6.0.21-x64.zip'), '')
    expect(findArchives(dist)).toEqual([linux, mac, win].sort())
  })

  it('fails when any one of several archives is missing an icon', () => {
    put('win-unpacked/resources', WITH_ICONS)
    const linux = put('linux-unpacked/resources', MAIN_SHAPED)
    const result = checkDist(dist)
    expect(result.ok).toBe(false)
    expect(result.err).toEqual([
      `${linux}: missing resources/icon.ico`,
      `${linux}: missing resources/icon.png`
    ])
  })

  it('is an error when dist/ holds no archive', () => {
    const result = checkDist(dist)
    expect(result.ok).toBe(false)
    expect(result.err[0]).toMatch(/^No packaged app\.asar found under /)
  })

  it('is an error when dist/ does not exist', () => {
    expect(checkDist(join(dist, 'nope')).ok).toBe(false)
  })
})

describe('check.yml runs the packaged-icon check', () => {
  const yml = readFileSync(join(import.meta.dirname, '..', '.github/workflows/check.yml'), 'utf8')
  const lines = yml.split('\n')
  const at = (needle: string): number => lines.findIndex((l) => l.includes(needle))

  it('runs the script after electron-builder and before the zip is extracted', () => {
    const builder = at('- run: npx electron-builder ${{ matrix.args }} --publish never')
    const check = at('- run: node scripts/check-packaged-icon.mjs')
    const extract = at('- name: Extract zip for single-layer artifact')
    expect(builder).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(builder)
    expect(extract).toBeGreaterThan(check)
  })

  it("lists the script in the `changes` job's `code:` filter, so editing it alone still builds", () => {
    const code = at('            code:')
    expect(code).toBeGreaterThan(-1)
    const end = lines.findIndex((l, i) => i > code && !/^ {14}- /.test(l))
    const filter = lines.slice(code + 1, end === -1 ? undefined : end)
    expect(filter).toContain("              - 'scripts/check-packaged-icon.mjs'")
  })

  it('runs in the build job that packages all three platforms', () => {
    const start = at('  build:')
    const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l))
    expect(start).toBeGreaterThan(-1)
    const job = lines.slice(start, end === -1 ? undefined : end).join('\n')
    expect(job).toContain('- run: node scripts/check-packaged-icon.mjs')
    for (const args of ['--linux zip', '--win zip', '--mac zip']) expect(job).toContain(args)
  })
})
