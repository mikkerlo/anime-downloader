import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

// #567: every HTTP request in main goes through `fetchWithTimeout`
// (`src/main/lib/net.ts`), which owns the timeouts and the offline refusal. A
// bare `fetch` anywhere else would bypass both. This is an accident-catcher,
// not a proof: it flags the direct shapes — a call, a default
// (`fetchImpl = fetch`), an argument, shorthand, an import, and
// `globalThis.fetch` / `globalThis['fetch']` — but deliberate aliasing
// (`const g = globalThis; g.fetch(…)`, `Reflect.get`) gets past it. Type
// positions (`typeof fetch`), member names (`.fetch`, `fetch:`) and longer
// identifiers are not references. Walking the TypeScript AST rather than
// grepping keeps comments and string literals ("fetch failed") out of the scan.
//
// The two transports that are not `fetch` — a raw socket (`net.createConnection`)
// and `electron-updater` (`autoUpdater.`) — are allowed only in the files that
// gate them on the offline state, and `bypassOffline` only in the offline
// service's probe.
const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'src', 'main')
const NET = path.join('src', 'main', 'lib', 'net.ts')
const GLOBALS = new Set(['globalThis', 'global', 'window', 'self'])
const ALLOWED: Record<'bypassOffline' | 'createConnection' | 'autoUpdater', string[]> = {
  bypassOffline: ['src/main/services/offline/index.ts'],
  createConnection: ['src/main/syncplay.ts'],
  autoUpdater: ['src/main/ipc/app.ipc.ts']
}

interface Finding {
  line: number
  kind: 'fetch' | 'bypassOffline' | 'adopted' | 'createConnection' | 'autoUpdater'
  text: string
}

function inTypePosition(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p)) return true
    if (ts.isStatement(p) || ts.isExpression(p) || ts.isSourceFile(p)) {
      if (ts.isExpressionWithTypeArguments(p)) continue
      return false
    }
  }
  return false
}

function isMemberName(node: ts.Identifier): boolean {
  const p = node.parent
  if (ts.isPropertyAccessExpression(p) && p.name === node) {
    return !(ts.isIdentifier(p.expression) && GLOBALS.has(p.expression.text))
  }
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p)) &&
    p.name === node
  ) {
    return true
  }
  return false
}

function scanSource(source: string, fileName = 'x.ts'): Finding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const findings: Finding[] = []
  const report = (node: ts.Node, kind: Finding['kind']): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    findings.push({ line: line + 1, kind, text: node.parent.getText(sf).slice(0, 80) })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (node.text === 'fetch' && !inTypePosition(node) && !isMemberName(node)) {
        report(node, 'fetch')
      }
      if (node.text === 'bypassOffline') report(node, 'bypassOffline')
      if (
        node.text === 'fetchWithTimeout' &&
        !ts.isImportSpecifier(node.parent) &&
        !inTypePosition(node) &&
        !isMemberName(node)
      ) {
        report(node, 'adopted')
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'createConnection') report(node.name, 'createConnection')
      if (ts.isIdentifier(node.expression) && node.expression.text === 'autoUpdater') {
        report(node.expression, 'autoUpdater')
      }
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBALS.has(node.expression.text) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'fetch'
    ) {
      report(node.argumentExpression, 'fetch')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.ts$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

function scanMain(root: string = ROOT): Array<Finding & { file: string }> {
  return walk(path.join(root, 'src', 'main')).flatMap((abs) => {
    const file = path.relative(root, abs).split(path.sep).join('/')
    if (file === NET.split(path.sep).join('/')) return []
    return scanSource(fs.readFileSync(abs, 'utf-8'), abs).map((f) => ({ ...f, file }))
  })
}

function countPerFile(kind: Finding['kind']): Record<string, number> {
  const perFile: Record<string, number> = {}
  for (const f of scanMain().filter((x) => x.kind === kind)) {
    perFile[f.file] = (perFile[f.file] ?? 0) + 1
  }
  return perFile
}

describe('net adoption guard — the scanner', () => {
  const kinds = (src: string): string[] => scanSource(src).map((f) => f.kind)

  it('flags every kind of bare fetch value reference', () => {
    expect(kinds(`await fetch(url)`)).toEqual(['fetch'])
    expect(kinds(`function f(impl: typeof fetch = fetch) {}`)).toEqual(['fetch'])
    expect(kinds(`const impl = fetch`)).toEqual(['fetch'])
    expect(kinds(`run(fetch)`)).toEqual(['fetch'])
    expect(kinds(`globalThis.fetch(url)`)).toEqual(['fetch'])
    expect(kinds(`global.fetch(url)`)).toEqual(['fetch'])
    expect(kinds(`globalThis['fetch'](url)`)).toEqual(['fetch'])
    expect(kinds(`const o = { fetch }`)).toEqual(['fetch'])
    expect(kinds(`import { fetch } from 'undici'`)).toEqual(['fetch'])
    expect(kinds(`if (typeof fetch === 'function') {}`)).toEqual(['fetch'])
  })

  it('does not flag types, member names, longer identifiers, comments or strings', () => {
    expect(kinds(`let impl: typeof fetch`)).toEqual([])
    expect(kinds(`type F = typeof globalThis.fetch`)).toEqual([])
    expect(kinds(`api.fetch(url)`)).toEqual([])
    expect(kinds(`const o = { fetch: other }`)).toEqual([])
    expect(kinds(`class A { fetch() {} }`)).toEqual([])
    expect(kinds(`interface I { fetch(): void }`)).toEqual([])
    expect(kinds(`fetchPoster(url); abortPrefetch(); doFetch()`)).toEqual([])
    expect(kinds(`// fetch(url)\n/* fetch */ const s = 'fetch failed'`)).toEqual([])
    expect(kinds('const s = `${a} fetch(b)`')).toEqual([])
  })

  it('counts fetchWithTimeout references, not its import', () => {
    expect(kinds(`import { fetchWithTimeout } from './lib/net'`)).toEqual([])
    expect(kinds(`await fetchWithTimeout(url)`)).toEqual(['adopted'])
    expect(kinds(`function f(impl = fetchWithTimeout) {}`)).toEqual(['adopted'])
    expect(kinds(`let f: typeof fetchWithTimeout`)).toEqual([])
  })

  it('flags bypassOffline wherever it appears', () => {
    expect(kinds(`fetchWithTimeout(u, { bypassOffline: true })`)).toEqual([
      'adopted',
      'bypassOffline'
    ])
    expect(kinds(`const bypassOffline = true; f({ bypassOffline })`)).toEqual([
      'bypassOffline',
      'bypassOffline'
    ])
  })

  it('flags a raw socket open and any electron-updater use', () => {
    expect(kinds(`net.createConnection({ host, port })`)).toEqual(['createConnection'])
    expect(kinds(`createConnection({ host, port }); tls.connect(o)`)).toEqual([])
    expect(kinds(`autoUpdater.checkForUpdates()`)).toEqual(['autoUpdater'])
    expect(kinds(`autoUpdater.autoDownload = false`)).toEqual(['autoUpdater'])
    expect(kinds(`import { autoUpdater } from 'electron-updater'`)).toEqual([])
  })

  it('reports the line of each finding', () => {
    expect(scanSource(`const a = 1\n\nawait fetch(u)`)).toMatchObject([{ line: 3 }])
  })
})

describe('net adoption guard — src/main', () => {
  it('scans the whole main tree, net.ts excluded', () => {
    const files = walk(MAIN).map((f) => path.relative(ROOT, f))
    expect(files.length).toBeGreaterThan(50)
    expect(files).toContain(path.join('src', 'main', 'download-manager.ts'))
    expect(files).toContain(NET)
    expect(scanSource(fs.readFileSync(path.join(ROOT, NET), 'utf-8')).map((f) => f.kind)).toContain(
      'fetch'
    )
  })

  it('has no bare fetch outside lib/net.ts', () => {
    expect(scanMain().filter((f) => f.kind === 'fetch')).toEqual([])
  })

  // The probe is the one request that must reach the network while offline.
  it('uses bypassOffline only in the offline service probe', () => {
    expect(countPerFile('bypassOffline')).toEqual({ 'src/main/services/offline/index.ts': 1 })
    expect(Object.keys(countPerFile('bypassOffline'))).toEqual(ALLOWED.bypassOffline)
  })

  it('opens a raw socket only in the gated Syncplay connect', () => {
    expect(countPerFile('createConnection')).toEqual({ 'src/main/syncplay.ts': 1 })
    expect(Object.keys(countPerFile('createConnection'))).toEqual(ALLOWED.createConnection)
  })

  it('touches electron-updater only in the gated app router', () => {
    const perFile = countPerFile('autoUpdater')
    expect(Object.keys(perFile)).toEqual(ALLOWED.autoUpdater)
    expect(perFile['src/main/ipc/app.ipc.ts']).toBeGreaterThan(0)
  })

  // Pinned so a scanner that silently stops matching goes red: the nine sites
  // that were bare `fetch` before #567 (eight calls plus the
  // `checkLatestRelease` default), and the offline probe. A new adopter bumps
  // its file's count.
  it('finds every adopted site', () => {
    expect(countPerFile('adopted')).toEqual({
      'src/main/shikimori.ts': 1,
      'src/main/smotret-api.ts': 4,
      'src/main/ffmpeg-binaries.ts': 1,
      'src/main/fpcalc-binaries.ts': 1,
      'src/main/lib/manual-update.ts': 1,
      'src/main/download-manager.ts': 1,
      'src/main/services/offline/index.ts': 1
    })
  })
})
