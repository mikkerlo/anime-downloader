// Fixtures for the citation gate (#336). Every case that drives `analyze()`
// drives it over a synthetic corpus rather than the real tree, so the
// assertions stay exact: the real tree's counts are the gate's own pins and
// move with every repair. The one block that does read a real file — the
// prose-figure cases at the foot of this file (#461) — reads `docs/testing.md`
// and compares it with the pin constants, never with a count taken off the
// tree, so the reason above still holds there.
//
// This file is in `EXCLUDED_PATHS`, and has to be. Its fixtures are citation
// shapes on purpose — several are deliberately broken — so scanning it would
// make the gate fail on its own test data.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig graph
import { analyze, report, driftBasePlan } from '../scripts/check-line-citations.mjs'
// The four pin constants (#461), taken as a namespace and destructured below the
// way this file already takes the nightly half's exports. A named import of all
// four wraps past `printWidth`, and Prettier then puts the module specifier on a
// line of its own, where the `@ts-expect-error` above no longer covers it —
// `TS2578: Unused '@ts-expect-error' directive` plus the error it was suppressing.
// @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig graph
import * as citations from '../scripts/check-line-citations.mjs'
// The nightly half of the same gate (#395 step 2). Importing it is safe rather
// than lucky: its `main()` sits behind an `endsWith('check-upstream-citations.mjs')`
// argv guard, exactly as this file's other import does, so loading the module
// under vitest provisions nothing and runs nothing.
// @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig graph
import * as upstream from '../scripts/check-upstream-citations.mjs'

type Corpus = Record<string, string>

type Result = {
  scannedCount: number
  resolved: { at: string; cited: string; target: string }[]
  resolvedFullPath: number
  resolvedUniqueBasename: number
  unresolvableByExtension: number
  unmarkedPy: number
  markedPy: number
  failures: { at: string; cited: string; why: string; candidates?: string[] }[]
  suspicious: { at: string; cited: string; target: string; start: number; why: string }[]
  marked: { at: string; cited: string; target: string; quote: string }[]
  quoteFailures: {
    at: string
    cited: string
    target: string
    quote: string
    elsewhere: number[]
  }[]
  drift: {
    at: string
    cited: string
    target: string
    line: number
    end: boolean
    elsewhere: number[]
    baseText: string
  }[]
  driftChecked: number
  driftExemptNewFile: { at: string; cited: string; target: string }[]
  driftBase: string | null
  driftEnabled: boolean
  pathless: { at: string; anchor: string }[]
  uncheckable: number
}

// Line 1 is a comment, 4 is blank, 6 is a bare `}`, 8 is a lone `)`, and 3, 5
// and 7 are code. One target file covers every landing class the heuristic has.
const TARGET = [
  '// why the function exists',
  'export function f(): number {',
  '  const a = 1',
  '',
  '  return a',
  '}',
  'const g = (',
  ')',
  ''
].join('\n')

const run = (files: Corpus, excludedPaths: string[] = []): Result =>
  analyze({
    files: Object.keys(files),
    readLines: (p: string) => files[p].split('\n'),
    scanRoots: ['src', 'docs', 'test'],
    excludedPaths
  }) as Result

const base = (extra: Corpus = {}): Corpus => ({ 'src/target.ts': TARGET, ...extra })

// The tree step 2 of #395 produces, in memory. `.py` is not in `RESOLVABLE_EXT`
// and cannot be — that rule is what lets the upstream Syncplay anchors through
// with no filename allowlist — so every predicate that would run on an upstream
// target the moment a pinned copy is on disk is unreachable from a fixture
// without widening the set here. Only the fixtures that exercise those
// predicates use this; everything else runs the shipped extension list. The set
// is spelled out rather than derived from `RESOLVABLE_EXT`, so that widening the
// shipped list cannot quietly change what these two corpora mean — they cite the
// two extensions named here and nothing else.
const runResolvingPy = (files: Corpus): Result =>
  analyze({
    files: Object.keys(files),
    readLines: (p: string) => files[p].split('\n'),
    scanRoots: ['src', 'docs', 'test'],
    excludedPaths: [],
    resolvableExt: new Set(['.ts', '.py'])
  }) as Result

// Four lines of upstream-shaped Python: a `def`, a statement, a `#` comment and
// another statement. Line 3 is the landing the hash predicate has to see and
// line 4 the one it must leave alone.
const UPSTREAM = [
  'def forcePositionUpdate(self, watcher):',
  '    room = watcher.getRoom()',
  '    # the controller path, from the signature through the broadcast',
  '    room.broadcast(watcher)',
  ''
].join('\n')

// Every pin but the one under test neutralised, so a case about one counter
// cannot be satisfied or broken by another moving.
const pinsAtZero = { suspiciousLanding: 0, uncheckable: 0, marked: 0 }

// --- #395 step 2: the nightly upstream check -----------------------------------

const { assertPinnedTree, defClassBoundary, findings, issueBody, pinnedCommitFromWorkflow } =
  upstream

// Ten lines modelled on the real tree's class header: an import, a blank, the
// `class` line, a two-line `def __init__` signature, a body line, a blank, a
// decorator and the decorated `def` it belongs to, and that method's body. Every
// shape `defClassBoundary()` has to decide about is in here, including the two it
// must NOT fire on — a signature continuation line and a decorator.
const UPSTREAM_CLASS = [
  'from syncplay import constants',
  '',
  'class SyncFactory(Factory):',
  "    def __init__(self, port='', password='', motdFilePath=None,",
  '                 disableReady=False, disableChat=False, salt=None):',
  '        self.isolateRooms = isolateRooms',
  '',
  '    @requireLogged',
  '    def handleChat(self, chatMessage):',
  '        self._factory.sendChat(self._watcher, chatMessage)'
]

/**
 * A synthetic upstream file of `length` lines with `patch`'s one-based lines
 * substituted in. The filler is live code — never blank, never a comment — so a
 * fixture built this way can only trip the predicate under test and not the
 * landing heuristics that share the ladder.
 *
 * Padded to the real line numbers on purpose, for the characterisation cases
 * below: an assertion written against `:847-849` is checkable against the pinned
 * tree by eye, where the same claim shifted onto a ten-line fixture is not.
 */
const pyFile = (length: number, patch: Record<number, string>): string[] => {
  const lines = Array.from({ length }, (_, i) => `    pad${i + 1} = ${i + 1}`)
  for (const [n, text] of Object.entries(patch)) lines[Number(n) - 1] = text
  return lines
}

// `server.py` at the pin, in the three neighbourhoods step 0 repaired, at their
// real line numbers.
const SERVER_PY = pyFile(919, {
  777: '    def setPosition(self, position):',
  778: '        self._position = position',
  779: '',
  780: '    def getPosition(self):',
  781: '        if self._position is None:',
  782: '            return None',
  783: '        if self._room.isPlaying():',
  784: '            timePassedSinceSet = time.time() - self._lastUpdatedOn',
  785: '        else:',
  786: '            timePassedSinceSet = 0',
  787: '        return self._position + timePassedSinceSet',
  788: '',
  841: '    def _scheduleSendState(self):',
  842: '        self._sendStateTimer = task.LoopingCall(self._askForStateUpdate)',
  843: '        self._sendStateTimer.start(constants.SERVER_STATE_INTERVAL)',
  844: '',
  845: '    def _askForStateUpdate(self, doSeek=False, forcedUpdate=False):',
  846: '        self._server.sendState(self, doSeek, forcedUpdate)',
  847: '',
  848: '    def _resetStateTimer(self):',
  849: '        if self._sendStateTimer:',
  850: '            if self._sendStateTimer.running:',
  851: '                self._sendStateTimer.stop()',
  852: '            self._sendStateTimer.start(constants.SERVER_STATE_INTERVAL)'
})

// `client.py` at the pin, around `updateGlobalState` and the four definitions
// that follow it.
const CLIENT_PY = pyFile(2384, {
  454: '    def updateGlobalState(self, position, paused, doSeek, setBy, messageAge):',
  455: '        if self.__getUserlistOnLogon:',
  464: '            self.askPlayer()',
  465: '        self._executePlaystateHooks(position, paused, doSeek, setBy, messageAge)',
  466: '',
  467: '    def getUserOffset(self):',
  468: '        return self._userOffset',
  469: '',
  470: '    def setUserOffset(self, time):',
  474: '',
  475: '    def onDisconnect(self):',
  479: '',
  480: '    def removeUser(self, username):',
  484: '',
  485: '    def getPlayerPosition(self):'
})

// `_allowTLSconnections()` at its real span: the `def` on the START line, and the
// intra-function blank between the three `open()` calls and the `getmtime()`
// below them. The contrast case's whole subject — one predicate must fire here
// and the other must not.
const TLS_PY = pyFile(919, {
  251: '    def _allowTLSconnections(self, path):',
  252: '        try:',
  253: "            privKey = open(path+'/privkey.pem', 'rb').read()",
  254: "            certif = open(path+'/cert.pem', 'rb').read()",
  255: "            chain = open(path+'/chain.pem', 'rb').read()",
  256: '',
  257: "            self.lastEditCertTime = os.path.getmtime(path+'/cert.pem')"
})

// A small `syncplay/`-rooted corpus for `findings()`, which scopes on that
// prefix: a crossing, a landing, an unresolved anchor and a rotted quote, one
// each, so one `issueBody()` covers every section it can print.
//
// The two definitions at `:2` and `:4` are deliberately NOT separated by a blank
// line, and the blank sits at `:6` instead. One anchor per class is the point of
// the corpus, and the two predicates overlap freely on a real file — a range
// spanning a blank line and a `def` is both a landing and a crossing — so a
// corpus laid out the natural way reports four findings in three classes and the
// counts stop saying which predicate fired.
const FINDINGS_SERVER = [
  'class SyncFactory(Factory):',
  '    def __init__(self, port=None):',
  '        self.port = port',
  '    def handleChat(self, message):',
  '        self.sendChat(message)',
  '',
  '    def sendChat(self, message):',
  '        self._factory.sendChat(message)',
  ''
].join('\n')

describe('check-line-citations', () => {
  it('resolves a full-path citation that lands on code', () => {
    const r = run(base({ 'src/caller.ts': '// the increment (src/target.ts:3)' }))

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([])
    expect(r.resolvedFullPath).toBe(1)
    expect(r.resolved[0]).toMatchObject({ cited: 'src/target.ts:3', target: 'src/target.ts' })
  })

  it('fails a citation past the end of the file', () => {
    const r = run(base({ 'src/caller.ts': '// see src/target.ts:999' }))

    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatchObject({
      at: 'src/caller.ts:1',
      cited: 'src/target.ts:999',
      why: 'src/target.ts has 8 lines'
    })
  })

  it('counts the last real line rather than the phantom one after the newline', () => {
    // TARGET is newline-terminated, so splitting on '\n' yields a ninth, empty
    // element. Counting it would put the EOF boundary one line too far out and
    // report a line count nobody else agrees with.
    const r = run(
      base({ 'src/caller.ts': '// last line (src/target.ts:8)\n// past it (src/target.ts:9)' })
    )

    expect(r.resolved.map((x) => x.cited)).toEqual(['src/target.ts:8'])
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatchObject({ cited: 'src/target.ts:9' })
  })

  it('fails a citation to a path that does not exist', () => {
    const r = run(base({ 'src/caller.ts': '// see src/renamed-away.ts:3' }))

    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatchObject({
      cited: 'src/renamed-away.ts:3',
      why: 'no such file in this repo'
    })
  })

  it('fails an inverted range', () => {
    const r = run(base({ 'src/caller.ts': '// see src/target.ts:5-3' }))

    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatchObject({
      cited: 'src/target.ts:5-3',
      why: 'range starts after it ends'
    })
  })

  it('resolves a bare basename exactly one tracked file carries', () => {
    const r = run(base({ 'src/caller.ts': '// the increment (target.ts:3)' }))

    expect(r.failures).toEqual([])
    expect(r.resolvedUniqueBasename).toBe(1)
    expect(r.resolved[0].target).toBe('src/target.ts')
  })

  it('resolves a unique path suffix but fails a wrong directory', () => {
    // The suffix filter is what makes `dir/target.ts:3` checkable at all, and
    // what lets an anchor stay inside its paragraph instead of running to 130
    // columns. Its other half is that a wrong directory must NOT quietly fall
    // back to a unique basename: the gate's advice when the pin rises ("give it
    // a path the gate can resolve") is only sound if a typo'd directory reds.
    const ok = run({ 'src/dir/target.ts': TARGET, 'src/caller.ts': '// see dir/target.ts:3' })

    expect(ok.failures).toEqual([])
    expect(ok.resolvedUniqueBasename).toBe(1)
    expect(ok.resolved[0].target).toBe('src/dir/target.ts')

    const bad = run(base({ 'src/caller.ts': '// see src/wrong/target.ts:3' }))

    expect(bad.resolved).toEqual([])
    expect(bad.failures[0]).toMatchObject({
      cited: 'src/wrong/target.ts:3',
      why: 'no such file in this repo'
    })
  })

  it('scans repo-root files under the `.` root', () => {
    // Six named directories cannot reach a file with no directory component,
    // and the root holds the architecture index and the rules file — prose
    // *about* paths. An anchor there used to be invisible twice over: unchecked,
    // and absent from the uncheckable pin, so the gate printed OK.
    const corpus = base({ 'DESIGN.md': 'the mirror election (src/target.ts:999)' })

    const named = run(corpus)
    expect(named.scannedCount).toBe(1)
    expect(named.failures).toEqual([])

    // No `scanRoots` here: `analyze` falls back to the exported `SCAN_ROOTS`,
    // so this pins the `'.'` entry in the config as well as the arm in
    // `underRoot` that reads it. Passing a list instead made the two separable,
    // and deleting `'.'` from the constant then left every test green and the
    // gate printing OK — a regression as silent as the bug it undoes.
    const withRoot = analyze({
      files: Object.keys(corpus),
      readLines: (p: string) => corpus[p].split('\n'),
      excludedPaths: []
    }) as Result

    expect(withRoot.scannedCount).toBe(2)
    expect(withRoot.failures).toHaveLength(1)
    expect(withRoot.failures[0]).toMatchObject({
      at: 'DESIGN.md:1',
      cited: 'src/target.ts:999',
      why: 'src/target.ts has 8 lines'
    })
  })

  // #517: a bare basename two tracked files carry. It used to be counted into
  // the uncheckable pin and never looked at again, which is how all ten bare
  // `syncplay.ts:NNN` anchors on the censused tree went stale with the gate
  // green. It is a failure now, and the failure names both candidates.
  it('fails a basename two tracked files carry, naming both candidates (#517)', () => {
    const corpus = {
      'src/main/dup.ts': TARGET,
      'src/renderer/dup.ts': TARGET,
      'src/caller.ts': '// see dup.ts:3'
    }
    const r = run(corpus)

    expect(r.resolved).toEqual([])
    expect(r.uncheckable).toBe(0)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toEqual({
      at: 'src/caller.ts:1',
      cited: 'dup.ts:3',
      candidates: ['src/main/dup.ts', 'src/renderer/dup.ts'],
      why:
        'ambiguous — 2 tracked files end in `dup.ts` ' +
        '(src/main/dup.ts, src/renderer/dup.ts); spell the path out'
    })

    // The message is the point of the change: the report has to carry both
    // candidates, not a count, or the author goes looking for them.
    const { ok, err } = report(r, pinsAtZero)
    expect(ok).toBe(false)
    expect(err).toContain('1 citation(s) do not resolve:')
    expect(err).toContain(
      '  src/caller.ts:1: cites `dup.ts:3` — ambiguous — 2 tracked files end in ' +
        '`dup.ts` (src/main/dup.ts, src/renderer/dup.ts); spell the path out'
    )
  })

  it('fails an ambiguous basename whatever its number says (#517)', () => {
    // A right number, a wrong one and one past the end of both files: each is
    // exactly one ambiguity failure, never a range failure and never a pass, so
    // the verdict cannot depend on whether the number happens to be correct.
    for (const n of [3, 5, 999]) {
      const r = run({
        'src/main/dup.ts': TARGET,
        'src/renderer/dup.ts': TARGET,
        'src/caller.ts': `// see dup.ts:${n}`
      })
      expect(r.failures, `dup.ts:${n}`).toHaveLength(1)
      expect(r.failures[0].cited).toBe(`dup.ts:${n}`)
      expect(r.failures[0].candidates).toEqual(['src/main/dup.ts', 'src/renderer/dup.ts'])
      expect(r.failures[0].why).toMatch(/^ambiguous — 2 tracked files/)
      expect(r.resolved).toEqual([])
    }
  })

  it('fails a bare `syncplay.ts:NNN` and resolves the suffixes that disambiguate it (#517)', () => {
    // The real collision, by its real paths: `src/main/syncplay.ts` and the
    // Pinia store. The suffix `main/syncplay.ts` is what self-citing comments
    // in the main process write to keep lines short, so it has to resolve to
    // exactly one file — and so does the store's.
    const r = run({
      'src/main/syncplay.ts': TARGET,
      'src/renderer/src/stores/syncplay.ts': TARGET,
      'docs/syncplay.md': [
        'the guard at `syncplay.ts:3`,',
        'the same guard at `main/syncplay.ts:3`,',
        'and the store at `stores/syncplay.ts:5`.'
      ].join('\n')
    })

    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatchObject({
      at: 'docs/syncplay.md:1',
      cited: 'syncplay.ts:3',
      candidates: ['src/main/syncplay.ts', 'src/renderer/src/stores/syncplay.ts']
    })
    expect(r.resolved.map((x) => [x.at, x.cited, x.target])).toEqual([
      ['docs/syncplay.md:2', 'main/syncplay.ts:3', 'src/main/syncplay.ts'],
      ['docs/syncplay.md:3', 'stores/syncplay.ts:5', 'src/renderer/src/stores/syncplay.ts']
    ])
    expect(r.resolvedUniqueBasename).toBe(2)
    expect(r.uncheckable).toBe(0)
  })

  // #517's other two forms are not resolved by the gate, by design: inferring a
  // shorthand's path from the nearest anchor on its line was measured wrong on
  // two of fifty-two, both stale. They are spelled out in the tree instead and
  // stay counted against an exact pin; what changed is that a pin overrun now
  // NAMES each pathless anchor, so a new one can be found and spelled.
  it('keeps a shorthand `:NNN` after a full anchor pathless, and names it when the pin overruns (#517)', () => {
    const r = run(base({ 'src/caller.ts': '// see `src/target.ts:3`/`:5`' }))

    expect(r.resolved.map((x) => x.cited)).toEqual(['src/target.ts:3'])
    expect(r.failures).toEqual([])
    expect(r.pathless).toEqual([{ at: 'src/caller.ts:1', anchor: ':5' }])
    expect(r.uncheckable).toBe(1)

    const { ok, err } = report(r, pinsAtZero)
    expect(ok).toBe(false)
    expect(err).toContain('Uncheckable-anchor count rose: 1, pinned at 0.')
    expect(err.slice(err.indexOf('Pathless anchors:'))).toEqual([
      'Pathless anchors:',
      '  src/caller.ts:1: `:5`'
    ])
  })

  it('keeps a `(:NNN)` self-reference pathless rather than resolving it against its own file (#517)', () => {
    const self = ['export const a = 1', '// the constant above (:1) and the guard (:2)', ''].join(
      '\n'
    )
    const r = run(base({ 'src/self.ts': self }))

    expect(r.resolved).toEqual([])
    expect(r.failures).toEqual([])
    expect(r.pathless).toEqual([
      { at: 'src/self.ts:2', anchor: ':1' },
      { at: 'src/self.ts:2', anchor: ':2' }
    ])

    const { err } = report(r, { ...pinsAtZero, uncheckable: 1 })
    expect(err).toContain('Uncheckable-anchor count rose: 2, pinned at 1.')
    expect(err.slice(err.indexOf('Pathless anchors:'))).toEqual([
      'Pathless anchors:',
      '  src/self.ts:2: `:1`',
      '  src/self.ts:2: `:2`'
    ])

    // A fall prints no list: there is nothing to find, only a pin to lower.
    const fell = report(r, { ...pinsAtZero, uncheckable: 3 })
    expect(fell.err).not.toContain('Pathless anchors:')
  })

  it('drift-checks the spelled-out anchor and is blind to the same target written as shorthand (#517)', () => {
    // The pair that says why #517 spells paths out instead of counting them:
    // one line inserted above the target moves both anchors' landing, and only
    // the spelled one is compared against the base.
    const target = (lead: string[]): string =>
      [...lead, 'export const guard = 1', 'export const other = 2', ''].join('\n')
    const citer = '// the guard (src/main/x.ts:1), the other (src/main/x.ts:2) and again (:1)'
    const selfCiter = [
      'export const guard = 1',
      '// the guard above (:1), spelled: src/main/self.ts:1',
      ''
    ].join('\n')
    const baseCorpus: Corpus = {
      'src/main/x.ts': target([]),
      'src/main/self.ts': selfCiter,
      'src/caller.ts': citer
    }
    const head: Corpus = {
      'src/main/x.ts': target(['export const inserted = 0']),
      'src/main/self.ts': ['export const inserted = 0', selfCiter].join('\n'),
      'src/caller.ts': citer
    }
    const r = analyze({
      files: Object.keys(head),
      readLines: (p: string) => head[p].split('\n'),
      readBaseLines: (p: string) => (p in baseCorpus ? baseCorpus[p].split('\n') : null),
      baseLabel: 'base',
      scanRoots: ['src'],
      excludedPaths: []
    }) as Result

    // Scanned in `files` order, which is the head corpus's key order.
    expect(r.drift.map((d) => [d.at, d.cited, d.elsewhere])).toEqual([
      ['src/main/self.ts:3', 'src/main/self.ts:1', [2]],
      ['src/caller.ts:1', 'src/main/x.ts:1', [2]],
      ['src/caller.ts:1', 'src/main/x.ts:2', [3]]
    ])
    expect(r.driftChecked).toBe(3)
    expect(r.pathless).toEqual([
      { at: 'src/main/self.ts:3', anchor: ':1' },
      { at: 'src/caller.ts:1', anchor: ':1' }
    ])
  })

  it('counts a pathless anchor rather than silently ignoring it', () => {
    const r = run(base({ 'src/caller.ts': '// and the guard just below (:42)' }))

    expect(r.failures).toEqual([])
    expect(r.pathless).toEqual([{ at: 'src/caller.ts:1', anchor: ':42' }])
    expect(r.uncheckable).toBe(1)
  })

  it('does not count the line number of a full citation as a pathless anchor too', () => {
    const r = run(base({ 'src/caller.ts': '// see src/target.ts:3' }))

    expect(r.pathless).toEqual([])
    expect(r.uncheckable).toBe(0)
  })

  it('does not count a JSON value or a stream selector as a pathless anchor', () => {
    // A fifth of the first pin measured these: wire transcripts quoted verbatim
    // in docs, and a `${sel}:0` ffmpeg selector. Nothing can be spelled out to
    // fix one, so counting them means a new transcript line reds the gate with
    // advice its author cannot follow. A backtick- or paren-wrapped anchor in
    // the same file still counts, which is the half that has to keep working.
    const r = run({
      'docs/wire.md': '`{"playstate":{"position":20.998,"paused":false}}` then the gate at `:296`',
      'src/caller.ts': '// ffmpeg map is `${sel}:0`, and the early-out (:1326) skips it'
    })

    expect(r.pathless.map((p) => p.anchor)).toEqual([':296', ':1326'])
    expect(r.uncheckable).toBe(2)
  })

  it('treats an extension this repo does not contain as unresolvable, not missing', () => {
    const r = run(base({ 'src/caller.ts': "// upstream's election (server.py:597-604)" }))

    expect(r.failures).toEqual([])
    expect(r.unresolvableByExtension).toBe(1)
    expect(r.uncheckable).toBe(0)
  })

  it('leaves a host:port that matches the citation shape alone', () => {
    // `syncplay.pl:8999` is the default reference server and port. It parses as
    // a citation under any path regex; the resolvable-extension rule is the only
    // thing between it and a spurious failure.
    const r = run(base({ 'src/caller.ts': '// default server is syncplay.pl:8999' }))

    expect(r.failures).toEqual([])
    expect(r.unresolvableByExtension).toBe(1)
  })

  it('reads a `#` line in a Python target as a comment landing', () => {
    // #395's predicate. `.yml`, `.yaml` and `.sh` were the hash-comment
    // languages; `.py` was not, so the moment a pinned upstream copy makes these
    // anchors resolve, one landing on a Python comment would pass through the
    // only predicate with anything to say about it. Written against the corpus a
    // vendored copy would produce rather than against the tree, because on this
    // tree the branch fires on nothing at all.
    const corpus: Corpus = {
      'upstream/server.py': UPSTREAM,
      'src/caller.ts': '// the forced update (server.py:3)'
    }

    const r = runResolvingPy(corpus)

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([
      {
        at: 'src/caller.ts:1',
        cited: 'server.py:3',
        target: 'upstream/server.py',
        start: 3,
        why: 'comment line'
      }
    ])

    // The other half of the predicate, so a later widening to "every `.py` line"
    // has to delete an assertion: a Python target on live code stays clean.
    const onCode = runResolvingPy({
      'upstream/server.py': UPSTREAM,
      'src/caller.ts': '// the broadcast (server.py:4)'
    })
    expect(onCode.suspicious).toEqual([])

    // And the characterisation half. With the shipped extension list the anchor
    // never reaches the ladder at all, so the same stale landing reports nothing:
    // this case fails on the old predicate and passes on the new one only because
    // the fixture supplies the tree the predicate is written for.
    const asShipped = analyze({
      files: Object.keys(corpus),
      readLines: (p: string) => corpus[p].split('\n'),
      scanRoots: ['src', 'docs', 'test'],
      excludedPaths: []
    }) as Result
    expect(asShipped.suspicious).toEqual([])
    expect(asShipped.unresolvableByExtension).toBe(1)
  })

  it('counts an unmarked upstream `.py` anchor against the ceiling, a marked one not', () => {
    // #395's counter, and the only pin here compared with `>`. The hazard runs
    // the other way from `MARKED_PIN`: writing an upstream anchor is not opt-in,
    // nothing resolves a `.py` target, so growth is what costs coverage and a
    // fall is the retrofit. The gate has no notion of "added in this PR" — it
    // compares one aggregate against one constant — so only a ceiling can red the
    // PR that writes a new unmarked one.
    const unmarked = run(base({ 'src/caller.ts': "// upstream's election (server.py:597-604)" }))

    expect(unmarked.unmarkedPy).toBe(1)
    expect(unmarked.markedPy).toBe(0)
    expect(report(unmarked, { ...pinsAtZero, unmarkedPy: 0 }).ok).toBe(false)
    expect(report(unmarked, { ...pinsAtZero, unmarkedPy: 1 }).ok).toBe(true)

    // Marking it takes it out of the population without resolving anything: the
    // `quality` half of the rule checks the FORM offline, because the target file
    // is not on disk to check the content against.
    const marked = run(
      base({
        'src/caller.ts': '// the setter echo (server.py:187 ("room.broadcast(watcher)"))'
      })
    )
    expect(marked.unmarkedPy).toBe(0)

    // #395's hatch, pinned from both sides. Marking the anchor moves it out of
    // the ceiling and into `markedPy`, and NOT into `marked[]`: the quote is
    // extracted above the extension gate, so the gate's `continue` fires before
    // `marked.push` and `verifyQuote()` ever see it. That asymmetry is the whole
    // hole — the anchor reads as checkable and is compared with nothing — and
    // asserting the absence is what stops a later refactor from moving the
    // `continue` and making the printed counter redundant unobserved.
    expect(marked.markedPy).toBe(1)
    expect(marked.marked).toEqual([])
    // Both halves of "compared with nothing": absent from the verified
    // population AND never handed to `verifyQuote()`, so an empty failure list
    // here is the absence of a comparison rather than a comparison that passed.
    expect(marked.quoteFailures).toEqual([])

    // And the counter is a figure, not a verdict: it carries no pin of its own,
    // so a non-zero `markedPy` must leave `ok` alone with the ceiling at zero.
    expect(report(marked, { ...pinsAtZero, unmarkedPy: 0 }).ok).toBe(true)

    // The printed line is the deliverable, so its position and text are pinned,
    // not just the number behind it. Immediately after the ceiling line and
    // never folded into it: the ceiling names the unmarked population and this
    // names the half that escaped it. Matched with `startsWith` on the two-space
    // indent, because `includes('marked .py anchors')` finds the ceiling line's
    // own `unmarked upstream .py anchors:` first and would pass on the wrong row.
    const printed = report(marked, { ...pinsAtZero, unmarkedPy: 0 }).out
    const ceiling = printed.findIndex((l: string) =>
      l.startsWith('  unmarked upstream .py anchors:')
    )
    const hatch = printed.findIndex((l: string) => l.startsWith('  marked .py anchors:'))
    expect(ceiling).toBeGreaterThan(-1)
    expect(hatch).toBe(ceiling + 1)
    expect(printed[hatch]).toContain('marked .py anchors: 1')
    expect(printed[hatch]).toContain('(no pin)')

    // Printed even at zero, which is the count on the real tree. A figure that
    // appears only once the class is non-empty cannot be what keeps the class
    // from growing unobserved — the same objection *Structural tests* makes to a
    // drift line that prints nothing when the check did not run.
    expect(report(unmarked, { ...pinsAtZero, unmarkedPy: 1 }).out.join('\n')).toContain(
      '  marked .py anchors: 0'
    )

    // One-sided, unlike `suspiciousLanding` and `uncheckable`: a fall is free, so
    // the anchors already on the tree are grandfathered and each retrofit
    // ratchets the number down rather than redding the PR that does it.
    expect(report(marked, { ...pinsAtZero, unmarkedPy: 3 }).ok).toBe(true)

    // Keyed on the extension, not on whether the anchor resolved. Widening
    // `resolvableExt` is what the predicate fixture above does, and it must not
    // move this number — otherwise the ceiling would measure the fixture rather
    // than the population.
    const resolving = runResolvingPy({
      'upstream/server.py': UPSTREAM,
      'src/caller.ts': '// the broadcast (server.py:4)'
    })
    expect(resolving.unmarkedPy).toBe(1)

    // The same claim for the marked half, which is now the other number the
    // extension keying has to hold still. It also shows what the hatch costs:
    // with the target on disk the anchor stays in `markedPy` AND reaches
    // `marked[]`, so `verifyQuote()` runs and passes. Off the tree only the
    // first of those happens — which is exactly why `markedPy` is printed as
    // compared with nothing rather than counted as verified.
    const resolvingMarked = runResolvingPy({
      'upstream/server.py': UPSTREAM,
      'src/caller.ts': '// the broadcast (server.py:4 ("room.broadcast(watcher)"))'
    })
    expect(resolvingMarked.markedPy).toBe(1)
    expect(resolvingMarked.marked).toHaveLength(1)
    expect(resolvingMarked.quoteFailures).toEqual([])

    // And the other edge of the partition: a marked anchor to a non-`.py` target
    // is the verified population, never `markedPy`. Without this, counting every
    // quoted anchor here would read 64 on the real tree with the gate green.
    const markedTs = run(base({ 'src/caller.ts': '// the init (src/target.ts:3 ("const a = 1"))' }))
    expect(markedTs.marked).toHaveLength(1)
    expect(markedTs.markedPy).toBe(0)
  })

  it('does not scan a file under an excluded path', () => {
    const r = run(base({ 'src/vendor/bundle.js': '// see src/gone.ts:5 and node.id:1 and (:7)' }), [
      'src/vendor/'
    ])

    expect(r.failures).toEqual([])
    expect(r.pathless).toEqual([])
    expect(r.scannedCount).toBe(1)
  })

  it('subjects a markdown target to the blank-line test and exempts the markup one', () => {
    // Line 1 of the target is an HTML comment and line 3 is blank — both would
    // warn in a .ts file, and before #344 neither warned in prose. Line 3 warns
    // now: a paragraph boundary is not a line anyone cites deliberately, so the
    // blank test is decidable on prose where the markup one is not.
    const r = run({
      'docs/notes.md': '<!-- a note -->\nThe room mirror.\n\n',
      'src/caller.ts': '// see docs/notes.md:1 and docs/notes.md:3'
    })

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([
      {
        at: 'src/caller.ts:1',
        cited: 'docs/notes.md:3',
        target: 'docs/notes.md',
        start: 3,
        why: 'blank line'
      }
    ])
    // The companion half, stated on its own so a later loosening of the
    // expectation above cannot drop it silently: `<!--` is tested *below* the
    // `.md` return, so deleting that return rather than moving it reds line 1
    // here. This case alone distinguishes the move from the deletion.
    expect(r.suspicious.some((s) => s.cited === 'docs/notes.md:1')).toBe(false)
    expect(r.resolved).toHaveLength(2)
  })

  it('exempts a markdown target landing on a bare brace inside a fenced block', () => {
    // The bare-brace test also sits below the `.md` return, and this pins it
    // there. `docs/types.md:19` is the live shape: the `}` closing a fenced
    // `interface`, which has code semantics and so reads as drift — but no
    // anchor in the tree lands on one, so the predicate stays exempt on that
    // argument rather than on a measurement.
    const r = run({
      'docs/types.md': ['```ts', 'interface Room {', '  id: string', '}', '```', ''].join('\n'),
      'src/caller.ts': '// the room shape (docs/types.md:4)'
    })

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([])
    expect(r.resolved).toHaveLength(1)
  })

  it('warns on a markdown landing on the second of two consecutive blank lines', () => {
    // The one way the narrowed rule could misfire: a markdown file whose
    // paragraphs are separated by more than one blank line puts a
    // legitimately-aimed anchor on a blank. No tracked `.md` is written that
    // way today, so this pins the assumption rather than leaving it to a tree
    // scan — if it ever stops holding, this case is where it surfaces.
    const r = run({
      'docs/airy.md': 'First paragraph.\n\n\nSecond paragraph.\n',
      'src/caller.ts': '// see docs/airy.md:3'
    })

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([
      {
        at: 'src/caller.ts:1',
        cited: 'docs/airy.md:3',
        target: 'docs/airy.md',
        start: 3,
        why: 'blank line'
      }
    ])
  })

  it('warns on a landing on a blank line, a bare brace, a lone paren or a comment', () => {
    const r = run(
      base({
        'src/caller.ts': [
          '// blank (src/target.ts:4)',
          '// brace (src/target.ts:6)',
          '// paren (src/target.ts:8)',
          '// comment (src/target.ts:1)'
        ].join('\n')
      })
    )

    expect(r.failures).toEqual([])
    expect(r.suspicious.map((s) => [s.start, s.why])).toEqual([
      [4, 'blank line'],
      [6, 'bare `}`'],
      [8, 'bare `)`'],
      [1, 'comment line']
    ])
  })

  it('classifies a range by its start line only, except for blank interiors', () => {
    // `src/target.ts:5-8` opens on code and runs over a bare `}`, a `const g = (`
    // and a lone `)`. Thirteen of the tree's twenty-eight ranges have exactly
    // that shape — a cited block's last line is a closing brace by construction —
    // so judging a range's interior by the brace or comment predicates would red
    // the tree on legitimate citations. This is the half of #366's step C that
    // did NOT ship, stated as an assertion so a later widening has to delete it.
    const braces = run(base({ 'src/caller.ts': '// the tail (src/target.ts:5-8)' }))

    expect(braces.failures).toEqual([])
    expect(braces.suspicious).toEqual([])
    expect(braces.resolved).toHaveLength(1)

    // The blank-line predicate does extend inward (#366): a range is judged on
    // its start line for everything else, but a paragraph gap inside the span
    // means the range slid. `src/target.ts:2-6` spans the blank at line 4.
    const gap = run(base({ 'src/caller.ts': '// the whole function (src/target.ts:2-6)' }))

    expect(gap.failures).toEqual([])
    expect(gap.suspicious).toEqual([
      {
        at: 'src/caller.ts:1',
        cited: 'src/target.ts:2-6',
        target: 'src/target.ts',
        start: 4,
        why: 'blank line'
      }
    ])
  })

  it('judges a range whose LAST line is the blank one', () => {
    // THE CASE THAT DECIDES THE BOUND. `interiorBlankLine()` runs `n <= endLine`,
    // and nothing in this file used to distinguish that from `n < endLine` — the
    // whole suite stayed green with the end line dropped out of scope, so a later
    // cleanup could have narrowed the rule to match the word "interior" and taken
    // the coverage with it. `src/target.ts:3-4` is the minimal decider: line 3 is
    // code, so the start-line predicates pass it, and line 4 — the range's last
    // line — is the blank. A range whose final line is a paragraph gap has slid
    // just as surely as one with a gap in the middle, which is why the end line
    // is in scope and why the prose now says so.
    const r = run(base({ 'src/caller.ts': '// the declaration (src/target.ts:3-4)' }))

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([
      {
        at: 'src/caller.ts:1',
        cited: 'src/target.ts:3-4',
        target: 'src/target.ts',
        start: 4,
        why: 'blank line'
      }
    ])
  })

  it('reports a range with two interior gaps once, not once per gap', () => {
    // The pin counts citations that look stale, not lines, so a range crossing
    // several paragraph boundaries must not move `SUSPICIOUS_LANDING_PIN` by
    // more than one — otherwise the pin's arithmetic depends on how airy the
    // target file is.
    const r = run({
      'docs/airy.md': 'One.\n\nTwo.\n\nThree.\n',
      'src/caller.ts': '// see docs/airy.md:1-5'
    })

    expect(r.suspicious).toHaveLength(1)
    expect(r.suspicious[0]).toMatchObject({ start: 2, why: 'blank line' })
  })

  it('reds on a broken anchor and goes green once it is repaired', () => {
    const broken = run(base({ 'src/caller.ts': '// the increment (src/target.ts:993)' }))
    expect(report(broken, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(false)

    const repaired = run(base({ 'src/caller.ts': '// the increment (src/target.ts:3)' }))
    expect(report(repaired, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  // --- the marked form (#366) -------------------------------------------------
  //
  // `resolved` attests that a path exists and a line is not obviously blank. It
  // does not attest that the line says what the citing comment claims, and #344
  // audited four `.md` anchors, cleared them, and watched two of them go 87
  // lines stale within three days with the gate still green. A citation that
  // carries its own target verbatim is the one case where meaning is decidable,
  // because the comparison is a substring test rather than a judgement.

  // Line 2 carries the subject; line 5 is where it moves to.
  const PROSE = [
    'The room mirror.',
    '**Pin the count, never just loop over the set.** A scan that walks',
    '',
    'A later section.',
    '**Pin the count, never just loop over the set.** A scan that walks',
    ''
  ].join('\n')

  it('reds a marked citation whose quote has moved, and names the corrected line', () => {
    // THE REGRESSION CASE. On the old gate this is green: `docs/prose.md:1` is
    // live prose, so `suspiciousLanding()` has nothing to say about it. Delete
    // the quote check and this goes green again — that is the mutation control.
    const r = run({
      'docs/prose.md': 'The room mirror.\n**Pin the count, never just loop over the set.**\n',
      'src/caller.ts': '// per docs/prose.md:1 ("Pin the count, never just loop over the set")'
    })

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([])
    expect(r.marked).toHaveLength(1)
    expect(r.quoteFailures).toHaveLength(1)
    expect(r.quoteFailures[0]).toMatchObject({
      at: 'src/caller.ts:1',
      cited: 'docs/prose.md:1',
      target: 'docs/prose.md',
      elsewhere: [2]
    })
    // Hard failure, no pin: there is no pin value that makes this pass.
    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(false)
    expect(report(r, { suspiciousLanding: 1, uncheckable: 1, marked: 0 }).ok).toBe(false)
  })

  it('distinguishes a stale quote from a drifted one', () => {
    const r = run({
      'docs/prose.md': 'The room mirror.\nSomething else entirely.\n',
      'src/caller.ts': '// per docs/prose.md:1 ("Pin the count, never just loop over the set")'
    })

    expect(r.quoteFailures).toHaveLength(1)
    // Empty `elsewhere` is what the report reads as *stale* rather than *drift*:
    // there is no corrected line to offer, so the repair is a requote.
    expect(r.quoteFailures[0].elsewhere).toEqual([])
    const { err } = report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 })
    expect(err.join('\n')).toContain('stale — that text is nowhere in docs/prose.md')
    expect(err.join('\n')).not.toContain('drift —')
  })

  it('stays green on a marked citation whose quote is still correct', () => {
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:2 ("Pin the count, never just loop over the set")'
    })

    expect(r.quoteFailures).toEqual([])
    expect(r.marked).toHaveLength(1)
    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  it('leaves a quoted string that is not a citation of the target alone', () => {
    // THE CASE THAT PINS "MARKED, NOT ADJACENT". Triggering on any quoted run
    // near a citation measures 75 candidates tree-wide of which 2 are at their
    // span; the misses are UI copy and scare-quoted concepts sitting next to an
    // anchor, exactly this shape. Even a ten-character gap between the citation
    // and the quote admits three of them, so the extractor pins `("` with no
    // slack — and this fixture is what stops a later loosening.
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': [
        '// the toast (docs/prose.md:1) reads "Paused by me" to the room',
        '// and docs/prose.md:1 says "Paused by me" too'
      ].join('\n')
    })

    expect(r.marked).toEqual([])
    expect(r.quoteFailures).toEqual([])
    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  it('refuses to guess when a drifted quote matches more than one line', () => {
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:4 ("Pin the count, never just loop over the set")'
    })

    expect(r.quoteFailures).toHaveLength(1)
    expect(r.quoteFailures[0].elsewhere).toEqual([2, 5])
    const { err } = report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 })
    expect(err.join('\n')).toContain('docs/prose.md:2, docs/prose.md:5')
    expect(err.join('\n')).toContain('more than one match')
  })

  it('ignores multiplicity when the quote is at the cited line', () => {
    // Multiplicity governs the DRIFT REPORT ONLY. `docs/prose.md:5` carries the
    // same sentence as `:2`; the citation names one of them and is right, and
    // "how many other lines also say this" is not a question anyone asked. Under
    // the other reading — count matches, fail on more than one — this reds, and
    // so would four of the twelve anchors this PR retrofits.
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:5 ("Pin the count, never just loop over the set")'
    })

    expect(r.quoteFailures).toEqual([])
    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  it('stays green on a self-file citation whose quote is also on the citing line', () => {
    // Four of the twelve retrofits are self-file: citing file IS target file, so
    // marking one puts the quoted string on the citing line as well as on the
    // target. A rule that counted matches would hard-fail every one of them, and
    // the failure would be manufactured by the repair itself.
    const r = run({
      'docs/prose.md': [
        'The room mirror.',
        '**Pin the count, never just loop over the set.**',
        '',
        'See docs/prose.md:2 ("Pin the count, never just loop over the set") above.',
        ''
      ].join('\n')
    })

    expect(r.marked).toHaveLength(1)
    expect(r.quoteFailures).toEqual([])
    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  it('excludes the citing line from a self-file drift report', () => {
    // The other half of the same rule: when a self-file citation IS wrong, the
    // corrected line must not be the author's own sentence.
    const r = run({
      'docs/prose.md': [
        'The room mirror.',
        '**Pin the count, never just loop over the set.**',
        '',
        'See docs/prose.md:1 ("Pin the count, never just loop over the set") above.',
        ''
      ].join('\n')
    })

    expect(r.quoteFailures).toHaveLength(1)
    expect(r.quoteFailures[0].elsewhere).toEqual([2])
  })

  it('matches a quote anywhere inside a cited range', () => {
    // One of the twelve retrofits is a range, and its quote is in the interior.
    // Without this the gate's own header anchor is not retrofittable and the two
    // self-citations get covered asymmetrically.
    const r = run({
      'docs/prose.md': [
        '- **A rule.** Counting',
        '  the blocks a scan reached',
        '  is a shape check.',
        ''
      ].join('\n'),
      'src/caller.ts': '// per docs/prose.md:1-3 ("is a shape check")'
    })

    expect(r.marked).toHaveLength(1)
    expect(r.quoteFailures).toEqual([])
  })

  it('normalizes emphasis and whitespace on both sides of the comparison', () => {
    // CONSTRUCTED, because no live anchor exercises it: both of #366's repair
    // targets have their `**` outside the quoted span, so the raw substring
    // already matches. A quote with *internal* emphasis does not.
    const target = 'The mirror is refreshed by a **non-self** state.'
    const quote = 'refreshed by a non-self state'
    expect(target).not.toContain(quote) // raw substring fails

    const plainQuote = run({
      'docs/prose.md': `${target}\n`,
      'src/caller.ts': `// per docs/prose.md:1 ("${quote}")`
    })
    expect(plainQuote.quoteFailures).toEqual([])

    // And the mirror image: emphasis in the quote, plain prose in the target.
    const plainTarget = run({
      'docs/prose.md': 'The mirror is refreshed by a non-self state.\n',
      'src/caller.ts': '// per docs/prose.md:1 ("refreshed by a **non-self** state")'
    })
    expect(plainTarget.quoteFailures).toEqual([])

    // Whitespace collapse is the wrapped-quote half of the same rule.
    const wrapped = run({
      'docs/prose.md': `${target}\n`,
      'src/caller.ts': '// per docs/prose.md:1 ("refreshed    by a\n// non-self state")'
    })
    expect(wrapped.marked).toHaveLength(1)
    expect(wrapped.quoteFailures).toEqual([])
  })

  it('reads a quote that wraps across comment lines', () => {
    // The first anchor written in this form had its quote split across two
    // comment lines, so a single-line extractor would miss the very citation
    // that motivated the mechanism.
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': [
        '// Exact-match assertions, per docs/prose.md:2 ("Pin the count, never just',
        '// loop over the set"). Moving one is a deliberate act.'
      ].join('\n')
    })

    expect(r.marked).toHaveLength(1)
    expect(r.marked[0].quote).toBe('Pin the count, never just loop over the set')
    expect(r.quoteFailures).toEqual([])
  })

  it('reads a marked citation written with a backticked path', () => {
    // A backticked path is the same citation, and admitting the closing
    // backtick measures no new candidates tree-wide. Markdown prose backticks
    // paths by house style, so refusing it would make the retrofit unspellable
    // in half the citing files.
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per `docs/prose.md:1` ("Pin the count, never just loop over the set")'
    })

    expect(r.marked).toHaveLength(1)
    expect(r.quoteFailures[0]).toMatchObject({ cited: 'docs/prose.md:1', elsewhere: [2, 5] })
  })

  it('leaves an unmarked citation unverified rather than guessing', () => {
    // The escape hatch for a citation that genuinely points at "around here":
    // drop the `("…")` and the anchor degrades to the rest of this gate rather
    // than to a silenced failure. Opt-in is why the class needs no pin.
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:1, the counting rule'
    })

    expect(r.marked).toEqual([])
    expect(r.quoteFailures).toEqual([])
    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  it('reds a marked anchor when a line is inserted above its target, where a plain one does not', () => {
    // WHY #408'S RETROFIT SHIPPED AS ITS OWN PR. A plain `path:NN` is checked for
    // existence only, so an insertion anywhere above it re-points it at a
    // neighbouring line and the gate still prints OK — measured on #384, where a
    // small insertion inside the model's `sendState` went green while silently
    // wrong, and that is where item 4's `PROTOCOL_TIMEOUT` goes next. This is a
    // contrast rather than a second copy of the rot case below: that one
    // hand-writes a mismatch, this one produces it the way an edit does, and the
    // plain half is the assertion that says the gate alone would not have noticed.
    const body = (extra: string[]): string =>
      [
        '  private updateWatcher(w: Watcher, ps: Playstate | undefined): void {',
        ...extra,
        '    w.lastUpdatedOn = Date.now()',
        '    if (!ps) return',
        '    w.position = ps.position',
        '  }',
        ''
      ].join('\n')

    const before = body([])
    const after = body(['    if (this.protocolTimedOut(w)) return'])
    expect(before.split('\n')[1]).toBe('    w.lastUpdatedOn = Date.now()')
    expect(after.split('\n')[1]).toBe('    if (this.protocolTimedOut(w)) return')
    expect(after.split('\n')[2]).toBe('    w.lastUpdatedOn = Date.now()')

    const plain = '// stamped at receipt (src/server.ts:2), above the playstate guard'
    const cite = '// stamped at receipt (src/server.ts:2 ("w.lastUpdatedOn = Date.now()"))'

    // THE SILENT HALF. The plain anchor resolves, lands on code, and says nothing
    // about the code no longer being the line its own sentence describes.
    const plainAfter = run({ 'src/server.ts': after, 'src/caller.ts': plain })
    expect(plainAfter.resolved).toHaveLength(1)
    expect(plainAfter.marked).toEqual([])
    expect(plainAfter.quoteFailures).toEqual([])
    expect(plainAfter.suspicious).toEqual([])
    expect(report(plainAfter, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)

    // THE HALF THE RETROFIT BUYS. Same corpus, same shift, marked anchor: a drift
    // failure naming the line the stamp moved to, and no pin value makes it pass.
    const markedAfter = run({ 'src/server.ts': after, 'src/caller.ts': cite })
    expect(markedAfter.quoteFailures).toHaveLength(1)
    expect(markedAfter.quoteFailures[0]).toMatchObject({
      at: 'src/caller.ts:1',
      cited: 'src/server.ts:2',
      target: 'src/server.ts',
      elsewhere: [3]
    })
    expect(report(markedAfter, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(false)

    // And it is the shift that reds, not the marking: the same anchor over the
    // unshifted target is green, so the retrofit lands no pre-existing red.
    const markedBefore = run({ 'src/server.ts': before, 'src/caller.ts': cite })
    expect(markedBefore.marked).toHaveLength(1)
    expect(markedBefore.quoteFailures).toEqual([])
    expect(report(markedBefore, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  it('reds a shifted range only once the quote leaves its window', () => {
    // Why both of the retrofit's range anchors quote their LAST line. A range absorbs
    // any shift smaller than its own width, so a quote taken from the near edge is
    // still inside the stale window and reds nothing — correctly, since the span still
    // covers the declaration it names. The far edge is the half that leaves. The
    // fixture is shaped on `:314-319`, the interface one; `:744-766` leans on the same
    // rule. A third anchor used to be a range and is a single line now, because the
    // far edge of `:456-461` is a bare `}` and no quote there can red at all — when
    // the prose already names one line, that is the anchor, not a window around it.
    const iface = (extra: string[]): string =>
      [
        'export interface WireFrame {',
        ...extra,
        '  at: number',
        '  username: string',
        '  position: number',
        '  paused?: boolean',
        ''
      ].join('\n')

    const shifted = iface(['  seq: number'])

    const near = run({
      'src/wire.ts': shifted,
      'src/caller.ts': '// the frame shape (src/wire.ts:1-5 ("at: number"))'
    })
    expect(near.marked).toHaveLength(1)
    expect(near.quoteFailures).toEqual([])

    const far = run({
      'src/wire.ts': shifted,
      'src/caller.ts': '// the frame shape (src/wire.ts:1-5 ("paused?: boolean"))'
    })
    expect(far.quoteFailures).toHaveLength(1)
    expect(far.quoteFailures[0]).toMatchObject({ cited: 'src/wire.ts:1-5', elsewhere: [6] })

    // The same far-edge anchor over the unshifted interface, where `paused?:
    // boolean` is the fifth line and the window's last: green.
    const unshifted = run({
      'src/wire.ts': iface([]),
      'src/caller.ts': '// the frame shape (src/wire.ts:1-5 ("paused?: boolean"))'
    })
    expect(unshifted.quoteFailures).toEqual([])
  })

  it('reds when a marked anchor rots and goes green once it is repointed', () => {
    const rotted = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:1 ("Pin the count, never just loop over the set")'
    })
    expect(report(rotted, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(false)

    const repaired = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:2 ("Pin the count, never just loop over the set")'
    })
    expect(report(repaired, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  it('reds when a marked anchor is quietly de-marked, and stays green on a new one', () => {
    // `marked` was printed and asserted nowhere, so an anchor could leave the
    // verified population with the gate green and exit 0 — and a floor, not an
    // exact pin, is the fix: the class cannot grow silently (marking is opt-in)
    // but it can shrink silently, and shrinking is what costs coverage.
    const marked = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:2 ("Pin the count, never just loop over the set")'
    })
    expect(marked.marked).toHaveLength(1)
    expect(report(marked, { suspiciousLanding: 0, uncheckable: 0, marked: 1 }).ok).toBe(true)

    // Each of these leaves the quote text intact and still takes the anchor out
    // of the population, because the spelling admits no slack: the reader sees a
    // sentence that still names its target and the gate sees an unmarked anchor.
    const demarked = {
      'a trailing clause before the paren':
        '// per docs/prose.md:2, which says ("Pin the count, never just loop over the set")',
      'single quotes': "// per docs/prose.md:2 ('Pin the count, never just loop over the set')",
      'a doubled space': '// per docs/prose.md:2  ("Pin the count, never just loop over the set")'
    }
    for (const [shape, citing] of Object.entries(demarked)) {
      const r = run({ 'docs/prose.md': PROSE, 'src/caller.ts': citing })
      expect(r.marked, shape).toEqual([])
      expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 1 }).ok, shape).toBe(false)
    }

    // The `("` wrapped onto the next line is the fourth shape — the continuation
    // rule joins a wrapped *quote*, not a wrapped opener.
    const wrapped = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:2\n// ("Pin the count, never just loop over the set")'
    })
    expect(wrapped.marked).toEqual([])
    expect(report(wrapped, { suspiciousLanding: 0, uncheckable: 0, marked: 1 }).ok).toBe(false)

    // Growth is the safe direction and must not cost a bump on every retrofit.
    const grown = run({
      'docs/prose.md': PROSE,
      'src/caller.ts':
        '// per docs/prose.md:2 ("Pin the count, never just loop over the set")\n' +
        '// and again per docs/prose.md:5 ("Pin the count, never just loop over the set")'
    })
    expect(grown.marked).toHaveLength(2)
    expect(report(grown, { suspiciousLanding: 0, uncheckable: 0, marked: 1 }).ok).toBe(true)
  })

  it('reds when a pin drifts in either direction, not just upward', () => {
    const r = run(base({ 'src/caller.ts': '// blank (src/target.ts:4)' }))

    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(false)
    // Pinned at the measured value: a real but deliberate landing.
    expect(report(r, { suspiciousLanding: 1, uncheckable: 0, marked: 0 }).ok).toBe(true)
    // And a pin left behind by a repair that removed the landing reds too, so a
    // stale pin cannot quietly license a new one.
    expect(report(run(base()), { suspiciousLanding: 1, uncheckable: 0, marked: 0 }).ok).toBe(false)
  })

  // --- drift (#407) -----------------------------------------------------------
  //
  // The class every case above is blind to by construction: an anchor that
  // resolves, lands on a live code line, and names the WRONG line because the
  // target grew above it. Nothing in the head tree tells that apart from a
  // correct anchor, so each fixture here is TWO corpora — a base and a head —
  // driven through the injected `readBaseLines` so none of them touches git.
  //
  // Every fixture is also run through the pre-#407 reader-less path, because
  // "the new check catches it" is only half a claim: the other half is that the
  // old one did not, and that is what makes the diff self-documenting.

  const runDrift = (baseCorpus: Corpus, head: Corpus): Result =>
    analyze({
      files: Object.keys(head),
      readLines: (p: string) => head[p].split('\n'),
      readBaseLines: (p: string) => (p in baseCorpus ? baseCorpus[p].split('\n') : null),
      baseLabel: 'base',
      scanRoots: ['src', 'docs', 'test'],
      excludedPaths: []
    }) as Result

  const noPins = { suspiciousLanding: 0, uncheckable: 0, marked: 0 }

  // #371's fixture at its REAL line numbers, so the assertion below is `2894`
  // rather than a number invented to make a small fixture come out even. Padding
  // is the cheapest thing that keeps them honest: the check reads two lines and
  // counts one string, so the 2800 lines of template around them do not
  // participate in the decision and are not worth inventing.
  const PLAYER = 'src/renderer/src/components/views/PlayerView.vue'
  const LOADED = '        @loadedmetadata="syncplay.onVideoLoadedMetadata"'
  const MODAL = '      <div class="auto-advance-modal">'
  const pad = (n: number): string[] => Array.from({ length: n }, () => '  <span />')
  const vue = (lines: string[]): string => [...lines, ''].join('\n')

  // The citing comment, byte for byte what `test/helpers/syncplay-two-peer.ts`
  // carries — and identical in both trees, which is what makes the token
  // unchanged and the anchor eligible.
  const TWO_PEER = [
    "        else if (event === 'pause') ui!.onLocalPause()",
    `        // \`${PLAYER}:2835\` is the`,
    '        // `@loadedmetadata="syncplay.onVideoLoadedMetadata"` this stands in for.',
    '        else ui!.onVideoLoadedMetadata()',
    ''
  ].join('\n')

  it('reds the #371 shift that the resolver passes, and names the corrected line', () => {
    // THE REGRESSION CASE, and the whole reason #407 exists. #371 inserted the
    // auto-advance overlay above the `<video>` bindings: `PlayerView.vue:2835`
    // stopped being the `@loadedmetadata` binding and became the modal div, with
    // the binding now at `:2894`, while the anchor in the two-peer helper never
    // moved. Both trees resolve, both land on live markup, and
    // `check:line-citations` was green across the whole incident and is still
    // green on it today — which the first half of this test asserts rather than
    // asserting the fix alone.
    const baseCorpus: Corpus = {
      [PLAYER]: vue([...pad(2834), LOADED, ...pad(100)]),
      'test/helpers/syncplay-two-peer.ts': TWO_PEER
    }
    const head: Corpus = {
      [PLAYER]: vue([...pad(2834), MODAL, ...pad(58), LOADED, ...pad(41)]),
      'test/helpers/syncplay-two-peer.ts': TWO_PEER
    }

    // The base and head shapes, asserted rather than trusted to the padding
    // arithmetic — a fixture whose own line numbers are wrong would prove the
    // opposite of what it claims in a test about wrong line numbers.
    expect(baseCorpus[PLAYER].split('\n')[2834]).toBe(LOADED)
    expect(head[PLAYER].split('\n')[2834]).toBe(MODAL)
    expect(head[PLAYER].split('\n')[2893]).toBe(LOADED)

    // The old behaviour: no `readBaseLines`, and the gate is green.
    const old = analyze({
      files: Object.keys(head),
      readLines: (p: string) => head[p].split('\n'),
      scanRoots: ['src', 'docs', 'test'],
      excludedPaths: []
    }) as Result
    expect(old.failures).toEqual([])
    expect(old.suspicious).toEqual([])
    expect(old.driftEnabled).toBe(false)
    expect(report(old, noPins).ok).toBe(true)

    // The new behaviour: the same head tree, plus the base it came from.
    const r = runDrift(baseCorpus, head)
    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([])
    expect(r.drift).toHaveLength(1)
    expect(r.drift[0]).toMatchObject({
      at: 'test/helpers/syncplay-two-peer.ts:2',
      cited: `${PLAYER}:2835`,
      target: PLAYER,
      line: 2835,
      elsewhere: [2894]
    })

    // Hard failure: no pin value makes it pass, because there is no legitimate
    // steady-state population of anchors naming the wrong line.
    expect(report(r, noPins).ok).toBe(false)
    expect(report(r, { suspiciousLanding: 9, uncheckable: 9, marked: 0 }).ok).toBe(false)
    expect(report(r, noPins).err.join('\n')).toContain(`drift — it is at ${PLAYER}:2894`)
  })

  // Three identical calls, a fixture-sized version of the real multiplicity a
  // bare call reaches on this tree: `clearPendingUserPause()` sits at ten lines
  // of `src/renderer/src/composables/use-syncplay-client.ts`, five of which are
  // the bare call and the same normalized LINE. The other five — the
  // declaration, a one-line `if`, three backticked comment mentions — are what
  // whole-line equality excludes and a substring match would not.
  const CALL = '      clearPendingUserPause()'

  it('lists every head line a drifted anchor could mean instead of picking one', () => {
    // The count has to SURVIVE for this to be reportable at all — the next case
    // is an in-place edit of the same shape and passes — so the fixture
    // relocates the anchored copy while keeping all three present in head.
    const baseCorpus = {
      'src/svc.ts': ['const a = 1', CALL, 'const b = 2', CALL, 'const c = 3', CALL, ''].join('\n'),
      'src/caller.ts': '// the reset (src/svc.ts:2)'
    }
    const head = {
      'src/svc.ts': [
        'const a = 1',
        'const inserted = 0',
        'const b = 2',
        CALL,
        'const c = 3',
        CALL,
        'const d = 4',
        CALL,
        ''
      ].join('\n'),
      'src/caller.ts': '// the reset (src/svc.ts:2)'
    }

    const r = runDrift(baseCorpus, head)
    expect(r.drift).toHaveLength(1)
    expect(r.drift[0].elsewhere).toEqual([4, 6, 8])

    const { err } = report(r, noPins)
    expect(err.join('\n')).toContain('src/svc.ts:4, src/svc.ts:6, src/svc.ts:8')
    expect(err.join('\n')).toContain('more than one match')
  })

  it('passes an in-place edit whose old content is nowhere else in head', () => {
    // CRITICAL 3's NARROWING. Rename an identifier on a cited line and the token
    // is unchanged while the content differs — the naive rule hard-fails the most
    // ordinary edit there is, and the author has no retarget available to go
    // green with. "Nowhere in head" is what distinguishes a reword from a shift.
    const baseCorpus = {
      'src/svc.ts': ['const a = 1', '  const total = a + b', 'const c = 3', ''].join('\n'),
      'src/caller.ts': '// the sum (src/svc.ts:2)'
    }
    const head = {
      'src/svc.ts': ['const a = 1', '  const total = a + b + carry', 'const c = 3', ''].join('\n'),
      'src/caller.ts': '// the sum (src/svc.ts:2)'
    }

    const r = runDrift(baseCorpus, head)
    expect(r.drift).toEqual([])
    expect(r.driftChecked).toBe(1)
    expect(report(r, noPins).ok).toBe(true)
  })

  it('passes an in-place edit of a line whose old content also sits elsewhere', () => {
    // THE ROUND-2 CASE, and the one the multi-match test above must not be built
    // to contradict. The narrowing alone does not protect content that repeats:
    // reword one of three identical lines where it stands and the
    // elsewhere-search still finds the other two, so the gate would report "pick
    // one of two" on an anchor that never moved. Base count 3, head count 2 — the
    // anchored copy did not relocate, it went away — so this passes.
    const baseCorpus = {
      'src/svc.ts': ['const a = 1', CALL, 'const b = 2', CALL, 'const c = 3', CALL, ''].join('\n'),
      'src/caller.ts': '// the reset (src/svc.ts:2)'
    }
    const head = {
      'src/svc.ts': [
        'const a = 1',
        '      clearPendingUserPause(room)',
        'const b = 2',
        CALL,
        'const c = 3',
        CALL,
        ''
      ].join('\n'),
      'src/caller.ts': '// the reset (src/svc.ts:2)'
    }

    const r = runDrift(baseCorpus, head)
    expect(r.drift).toEqual([])
    expect(report(r, noPins).ok).toBe(true)
  })

  it('pins whole-line equality rather than the substring match verifyQuote uses', () => {
    // ROUND 3'S FIXTURE, and the only case here whose purpose is to fail if a
    // later hand swaps the comparison back for `.includes`. Base: the anchored
    // line is a bare `foo()` appearing nowhere else. Head: that line is edited in
    // place and the same commit adds a comment mentioning `foo()` elsewhere.
    // Whole-line equality gives base count 1 and head count 0, so it passes.
    // A substring matcher holds the head count at 1, reports drift onto the
    // comment, and reds — which is the point of the fixture. That matcher also
    // makes every `}` and `return` match half its file, and an empty base line
    // match all of it.
    const baseCorpus = {
      'src/svc.ts': ['const guard = true', '  foo()', 'const after = 1', ''].join('\n'),
      'src/caller.ts': '// the call (src/svc.ts:2)'
    }
    const head = {
      'src/svc.ts': [
        'const guard = true',
        '  foo(nextEpisode)',
        'const after = 1',
        '// calls foo() here',
        ''
      ].join('\n'),
      'src/caller.ts': '// the call (src/svc.ts:2)'
    }

    const r = runDrift(baseCorpus, head)
    expect(r.drift).toEqual([])
    expect(report(r, noPins).ok).toBe(true)
  })

  it('exempts an anchor this commit retargeted, because its token changed', () => {
    // The gate's stated limit, asserted so nobody reads its silence as coverage:
    // a hand retarget is exempt BY CONSTRUCTION, and one that lands a line short
    // goes through green. The workflow is what changes — leave the old token in
    // place and the failure names the correct line, so the number is copied out
    // of the message rather than counted.
    const baseCorpus = {
      'src/svc.ts': ['const a = 1', '  const total = a + b', 'const c = 3', ''].join('\n'),
      'src/caller.ts': '// the sum (src/svc.ts:2)'
    }
    const head = {
      'src/svc.ts': [
        'const a = 1',
        'const inserted = 0',
        '  const total = a + b',
        'const c = 3',
        ''
      ].join('\n'),
      'src/caller.ts': '// the sum (src/svc.ts:3)'
    }

    const r = runDrift(baseCorpus, head)
    expect(r.drift).toEqual([])
    expect(r.driftChecked).toBe(0)

    // And the control, on the same two trees: leave the token alone and it reds
    // while naming 3. Without this the case above would pass for a corpus in
    // which nothing shifted at all.
    const unretargeted = runDrift(baseCorpus, {
      ...head,
      'src/caller.ts': '// the sum (src/svc.ts:2)'
    })
    expect(unretargeted.drift).toHaveLength(1)
    expect(unretargeted.drift[0].elsewhere).toEqual([3])
  })

  it('reads the base token as a parsed token, not as a substring of a longer one', () => {
    // ROUND 4'S FIXTURE, and the second one here whose purpose is to fail if a
    // later hand swaps the comparison back for `.includes` — this time the
    // precondition rather than the content test. `src/a.ts:12` is a substring of
    // `src/a.ts:120`, so a substring precondition holds a brand-new `:12` anchor
    // to a base claim it never made. That is the unsatisfiable shape: the base
    // token stays in the base whatever the author does, so the only way out of
    // the failure is rewording the prose around a correct anchor. It is also the
    // likely shape — a target grows and anchors into it are added in the same
    // change, which is what #384 did.
    const step = (n: number): string => `  const step${n} = ${n}`
    const body = Array.from({ length: 130 }, (_, k) => step(k + 1))
    const baseCorpus = {
      'src/a.ts': [...body, ''].join('\n'),
      'src/b.ts': '// the guard (src/a.ts:120)'
    }
    const head = {
      'src/a.ts': ['const inserted1 = 0', 'const inserted2 = 0', ...body, ''].join('\n'),
      // The base line, untouched, plus the new anchor this branch adds.
      'src/b.ts': ['// the guard (src/a.ts:120)', '// the step (src/a.ts:12)'].join('\n')
    }

    // Head line 12 is base line 10, so the new `:12` is CORRECT and the old
    // `:120` is two lines short — asserted rather than left to the arithmetic.
    expect(head['src/a.ts'].split('\n')[11]).toBe(step(10))
    expect(head['src/a.ts'].split('\n')[121]).toBe(step(120))

    const r = runDrift(baseCorpus, head)

    // Exactly the real drift, and exactly once: the `:12` anchor is exempt
    // because the base parses no `src/a.ts:12`, while `:120` is checked and reds.
    expect(r.drift.map((d) => d.cited)).toEqual(['src/a.ts:120'])
    expect(r.drift[0]).toMatchObject({ at: 'src/b.ts:1', target: 'src/a.ts', line: 120 })
    expect(r.drift[0].elsewhere).toEqual([122])
    expect(r.driftChecked).toBe(1)
    expect(report(r, noPins).ok).toBe(false)

    // And the new anchor did resolve — without this the case above would also
    // pass for a `:12` that fell out of the accounting for some other reason.
    expect(r.resolved.some((x) => x.at === 'src/b.ts:2' && x.cited === 'src/a.ts:12')).toBe(true)

    // Under `.includes` the base `:120` line makes `:12` eligible too, the base
    // line 12 is found at head 14, and the author is handed `it is at
    // src/a.ts:14` for an anchor that is already right.
    expect(r.drift.some((d) => d.cited === 'src/a.ts:12')).toBe(false)
  })

  it('passes a citing comment widened on its own line', () => {
    // #405 and #406 were both authored same-line — widening comment text without
    // wrapping it — to avoid shifting anchors. The token test is "the same token
    // ANYWHERE in the base citing file", not "at the same line", so wrapping is
    // free here too: what matters is the target, and the target did not move.
    const target = ['const a = 1', '  const total = a + b', 'const c = 3', ''].join('\n')
    const r = runDrift(
      { 'src/svc.ts': target, 'src/caller.ts': '// the sum (src/svc.ts:2)' },
      {
        'src/svc.ts': target,
        'src/caller.ts': '// a leading paragraph\n// the sum of both halves (src/svc.ts:2)'
      }
    )

    expect(r.drift).toEqual([])
    expect(r.driftChecked).toBe(1)
  })

  it('passes a target grown entirely below its anchors', () => {
    const baseCorpus = {
      'src/svc.ts': ['const a = 1', '  const total = a + b', ''].join('\n'),
      'src/caller.ts': '// the sum (src/svc.ts:2)'
    }
    const r = runDrift(baseCorpus, {
      'src/svc.ts': ['const a = 1', '  const total = a + b', 'const added = 3', ''].join('\n'),
      'src/caller.ts': '// the sum (src/svc.ts:2)'
    })

    expect(r.drift).toEqual([])
    expect(r.driftChecked).toBe(1)
  })

  it('reds a range whose END moved while its start stayed put', () => {
    // `path:N-M` claims both ends, so both are checked — which is NOT the rule
    // `suspiciousLanding()` follows. Its start-line-only classification has a
    // reason peculiar to itself (a cited block's last line is a closing brace by
    // construction, so judging the interior would red the legitimate ranges), and
    // content equality against the base has no such collision.
    const baseCorpus = {
      'src/svc.ts': [
        'const head = 0',
        '  const a = 1',
        '  const b = 2',
        '  const tail = 3',
        'const after = 9',
        ''
      ].join('\n'),
      'src/caller.ts': '// the middle (src/svc.ts:2-4)'
    }
    const head = {
      'src/svc.ts': [
        'const head = 0',
        '  const a = 1',
        '  const b = 2',
        '  const inserted = 7',
        '  const tail = 3',
        'const after = 9',
        ''
      ].join('\n'),
      'src/caller.ts': '// the middle (src/svc.ts:2-4)'
    }

    const r = runDrift(baseCorpus, head)
    expect(r.suspicious).toEqual([])
    expect(r.drift).toHaveLength(1)
    expect(r.drift[0]).toMatchObject({ line: 4, end: true, elsewhere: [5] })
    expect(report(r, noPins).err.join('\n')).toContain('(range end)')
  })

  it('does not see a whitespace-only reflow of the anchored line as a change', () => {
    // TRUE BY CONSTRUCTION SINCE STEP 6, not as a downstream consequence:
    // `normalizeQuote()` collapses whitespace, so a reindent is not a change at
    // step 1 and the pass never depended on the elsewhere-search missing it. The
    // head copy here is indented differently AND the file grew above it, so a
    // raw comparison would both see a change and find the old text elsewhere.
    const r = runDrift(
      {
        'src/svc.ts': ['const a = 1', '  const total = a + b', 'const c = 3', ''].join('\n'),
        'src/caller.ts': '// the sum (src/svc.ts:2)'
      },
      {
        'src/svc.ts': ['const a = 1', '      const  total = a + b', 'const c = 3', ''].join('\n'),
        'src/caller.ts': '// the sum (src/svc.ts:2)'
      }
    )

    expect(r.drift).toEqual([])
  })

  it('skips an anchored line the base left blank rather than matching every gap', () => {
    // An empty needle is `suspiciousLanding()`'s business, and under equality it
    // would match every blank line in the file — so the drift check declines the
    // case outright instead of reporting a landing that gate already owns.
    const r = runDrift(
      {
        'docs/notes.md': ['The room mirror.', '', 'A later section.', ''].join('\n'),
        'src/caller.ts': '// see docs/notes.md:2'
      },
      {
        'docs/notes.md': ['The room mirror.', 'Now filled in.', '', 'A later section.', ''].join(
          '\n'
        ),
        'src/caller.ts': '// see docs/notes.md:2'
      }
    )

    expect(r.drift).toEqual([])
  })

  it('exempts an anchor whose citing or target file the base does not carry', () => {
    // A file this branch adds has no base content to compare, and a renamed
    // target is already the resolver's business. Neither may crash the check.
    const added = runDrift(
      {},
      {
        'src/svc.ts': ['const a = 1', '  const total = a + b', ''].join('\n'),
        'src/caller.ts': '// the sum (src/svc.ts:2)'
      }
    )
    expect(added.drift).toEqual([])
    expect(added.driftChecked).toBe(0)
    expect(added.driftEnabled).toBe(true)
  })

  // --- the base-free exemption, made visible (#420) ----------------------------
  //
  // #415 closed citation drift for anchors the base carries. It cannot close it
  // for an anchor in a file the branch ADDS: `baseCiting` is null, the first term
  // of the precondition fails, and the anchor is never compared and never counted
  // in `driftChecked`. #417 shipped exactly that shape — a new test file whose
  // comment cited `src/main/download-manager.ts` at the line then holding
  // `item.quality = best.height`, and bringing `main` in inserted eight lines
  // above it — and a manual sweep of the merge's nine files caught it because
  // nothing in this gate could. `suspiciousLanding()` missed it too: the stale
  // number landed on a `try {`, which is not blank, not a closer, not a comment
  // marker. Nothing about the landing was suspicious; it simply named the wrong
  // statement.
  //
  // So the bucket is ADVISORY and carries no pin, unlike every other class here.
  // It is base-relative, where `SUSPICIOUS_LANDING_PIN` and `UNCHECKABLE_PIN`
  // count properties of the head tree alone: on `main` the base tree and the head
  // tree are the same object, so it measures 0 by construction, and an exact pin
  // at 0 would red every PR that adds a cited test file with "edit the pin" as the
  // only repair. That is the hard-fail-with-no-escape shape #407 spent three
  // rounds removing. The cases below therefore never assert a count against a
  // pin, and the one that checks `ok` asserts the bucket alone leaves it untouched.
  //
  // Every assertion here is an exact list or a length, never a predicate:
  // `bucket.every(...)` is true of the empty bucket, so it passes precisely when
  // collection silently stopped happening. That is a property of the bug under
  // repair rather than a style preference — the whole issue is a check that was
  // green because it never ran, and a vacuous assertion here would be the same
  // defect one level up.

  // The base line the #417 anchor was written against, and the line the merge
  // pushed it down to.
  const MOVED = '  item.quality = best.height'
  const movedBase = { 'src/svc.ts': ['const best = pick()', MOVED, ''].join('\n') }
  const movedHead = ['const best = pick()', 'const inserted = 0', MOVED, ''].join('\n')

  it('collects an anchor whose citing file is new on the branch, which drift cannot compare', () => {
    // THE #417 SHAPE, at fixture scale. The citing file is absent from the base;
    // the target is present in BOTH corpora, and its base line 2 content sits at
    // head line 3.
    const head: Corpus = {
      'src/svc.ts': movedHead,
      'test/new.test.ts': '// the quality write (src/svc.ts:2)'
    }

    // Both shapes asserted rather than left to the arithmetic — a fixture whose
    // own line numbers are wrong would prove the opposite of what it claims.
    expect(movedBase['src/svc.ts'].split('\n')[1]).toBe(MOVED)
    expect(head['src/svc.ts'].split('\n')[2]).toBe(MOVED)

    // The pre-#407 reader-less path, per this section's convention: green, as it
    // is on every fixture here.
    const old = analyze({
      files: Object.keys(head),
      readLines: (p: string) => head[p].split('\n'),
      scanRoots: ['src', 'docs', 'test'],
      excludedPaths: []
    }) as Result
    expect(old.driftEnabled).toBe(false)
    expect(report(old, noPins).ok).toBe(true)

    const r = runDrift(movedBase, head)

    // The old behaviour of the drift path itself, which is the half that makes
    // the diff self-documenting: it compared nothing and said nothing, and the
    // landing heuristic had nothing to say either.
    expect(r.drift).toEqual([])
    expect(r.driftChecked).toBe(0)
    expect(r.suspicious).toEqual([])

    // The new behaviour: the anchor is collected, and named.
    expect(r.driftExemptNewFile).toEqual([
      { at: 'test/new.test.ts:1', cited: 'src/svc.ts:2', target: 'src/svc.ts' }
    ])
  })

  it('collects every anchor in a citing file the branch renamed into place', () => {
    // The loudest case the advisory has, and chosen rather than incidental: `null`
    // covers a file renamed into place as well as one added, so a `git mv` of a
    // heavily-cited test file puts ALL of its anchors in the bucket on a PR that
    // wrote no citations at all. Nothing is wrong when that happens, which is
    // exactly why it needs a fixture and a line in the docs.
    //
    // The target keeps its path in both corpora, and that is load-bearing rather
    // than incidental setup: rename the target too and every anchor here drops to
    // the uncollected `baseTarget === null` arm, the bucket comes back empty, and
    // a predicate assertion would pass on it. The exact list below fails loudly
    // instead.
    const svc = ['const a = 1', '  const total = a + b', 'const c = 3', ''].join('\n')
    const citing = ['// the sum (src/svc.ts:2)', '// the tail (src/svc.ts:3)'].join('\n')
    const r = runDrift(
      { 'src/svc.ts': svc, 'test/old-name.test.ts': citing },
      { 'src/svc.ts': svc, 'test/new-name.test.ts': citing }
    )

    // Two anchors planted, two collected — asserted as a list and as a length,
    // because the length is what goes to 0 if the target is ever renamed too.
    expect(r.driftExemptNewFile).toEqual([
      { at: 'test/new-name.test.ts:1', cited: 'src/svc.ts:2', target: 'src/svc.ts' },
      { at: 'test/new-name.test.ts:2', cited: 'src/svc.ts:3', target: 'src/svc.ts' }
    ])
    expect(r.driftExemptNewFile).toHaveLength(2)
    expect(r.driftChecked).toBe(0)
  })

  it('leaves an anchor whose TARGET the branch also adds or renames out of the bucket', () => {
    // Both files new on the branch. There is no base content for the target
    // either, so there is nothing the advisory could tell the author to compare
    // against, and collecting it would turn the bucket into noise. A renamed
    // target reaches this arm too, and is right to: a rename that broke the
    // anchor is already the resolver's business.
    //
    // `toEqual([])`, not `expect(bucket.some(...)).toBe(false)`. A negative
    // assertion cannot be made non-vacuous by itself — it passes just as happily
    // when collection is broken outright — so it earns its teeth from the two
    // positive cases above and from the mutation control: drop `baseTarget !==
    // null` from the new arm and THIS is the case that reds, while every positive
    // case stays green. That asymmetry is why it lives in this suite rather than
    // in a file of its own.
    const r = runDrift(
      {},
      {
        'src/svc.ts': ['const a = 1', '  const total = a + b', ''].join('\n'),
        'test/new.test.ts': '// the sum (src/svc.ts:2)'
      }
    )

    // The anchor RESOLVES in the head, which is what gives the mutation control
    // something to pull into the bucket. Resolution happens before the drift
    // block, so an anchor that does not resolve reaches no arm at all: the case
    // passes, the mutation run passes, and nothing is proven.
    expect(r.resolved.map((x) => x.cited)).toEqual(['src/svc.ts:2'])
    expect(r.driftExemptNewFile).toEqual([])
    expect(r.driftChecked).toBe(0)
  })

  it('does not fail the gate on a non-empty exempt bucket', () => {
    // There is genuinely no way to tell a stale anchor from a correct brand-new
    // one without history, so this must not become a hard failure. The advisory
    // goes to `out`, never to `err`: `err` is non-empty only when something
    // failed, and CI log readers skim stderr as "what broke".
    //
    // Every target in this fixture is present in both corpora, deliberately. A
    // positive fixture that casually cited a second head-only file would hold a
    // latent `baseTarget === null` anchor, the mutation control would pull it in,
    // and the case would red for fixture contamination while reading as "the
    // wrong mutation was applied".
    const svc = ['const a = 1', '  const total = a + b', ''].join('\n')
    const r = runDrift(
      { 'src/svc.ts': svc },
      { 'src/svc.ts': svc, 'test/new.test.ts': '// the sum (src/svc.ts:2)' }
    )

    expect(r.driftExemptNewFile).toHaveLength(1)
    const { ok, err } = report(r, noPins)
    expect(ok).toBe(true)
    expect(err).toEqual([])
  })

  it('lists each exempt anchor in scan order rather than printing a count', () => {
    // A bare "2 drift-exempt" gives the author nothing to act on, so the advisory
    // names the lines, in the `at: cites \`cited\`` shape the resolve failures
    // use. The order is SCAN order, matching how those failures are emitted; the
    // fixture's keys are deliberately not alphabetical, so a sort would fail here
    // rather than pass by coincidence.
    const svc = ['const a = 1', '  const total = a + b', ''].join('\n')
    const r = runDrift(
      { 'src/svc.ts': svc },
      {
        'src/svc.ts': svc,
        'test/zebra.test.ts': '// the sum (src/svc.ts:2)',
        'test/alpha.test.ts': '// the sum again (src/svc.ts:2)'
      }
    )

    expect(r.driftExemptNewFile.map((e) => e.at)).toEqual([
      'test/zebra.test.ts:1',
      'test/alpha.test.ts:1'
    ])

    const { out } = report(r, noPins)
    expect(out.filter((l: string) => l.includes('cites `src/svc.ts:2`'))).toEqual([
      '    test/zebra.test.ts:1: cites `src/svc.ts:2`',
      '    test/alpha.test.ts:1: cites `src/svc.ts:2`'
    ])
    // And it names the remedy, not just the anchors.
    expect(out.join('\n')).toContain('("quoted text")')
    // On its own line, after the drift line, never folded into it: `driftChecked`
    // keeps the meaning the `scanned`-against-`compared` cross-checks in PR
    // descriptions rely on.
    const driftLine = out.findIndex((l: string) => l.includes('anchor(s) compared against'))
    const bucketLine = out.findIndex((l: string) => l.includes('drift-exempt'))
    expect(driftLine).toBeGreaterThan(-1)
    expect(bucketLine).toBe(driftLine + 1)
    expect(out[driftLine]).toContain('0 anchor(s) compared against base')
  })

  it('still verifies a marked quote on an exempt anchor, and names the corrected line', () => {
    // THE REMEDY THE ADVISORY RECOMMENDS, asserted rather than asserted about.
    // Quote verification runs OUTSIDE the base guard, so the exemption cannot
    // suppress it: on the #417 shape a marked anchor fails and names the line the
    // content moved to. It reports the correction; it does not apply it. Without
    // this case the advisory would be recommending something unverified.
    const head = {
      'src/svc.ts': movedHead,
      'test/new.test.ts': '// the write (src/svc.ts:2 ("item.quality = best.height"))'
    }

    const r = runDrift(movedBase, head)

    expect(r.marked).toHaveLength(1)
    expect(r.quoteFailures).toHaveLength(1)
    expect(r.quoteFailures[0].elsewhere).toEqual([3])

    // Still exempt from the base comparison — the two mechanisms are independent
    // — but NOT listed in the advisory: the advisory's whole content is "mark
    // it", and this anchor is marked. Listing it would name an anchor that has
    // been checked and tell its author to do what they already did.
    //
    // `toEqual([])` rather than a predicate. `bucket.every(...)` is true of the
    // empty bucket, so it would pass here whether the exclusion works or not; it
    // earns its teeth instead from the unmarked positives above, which are the
    // cases that red if the new `quote === null` clause ever over-reaches.
    expect(r.driftChecked).toBe(0)
    expect(r.driftExemptNewFile).toEqual([])

    const { ok, err } = report(r, noPins)
    expect(ok).toBe(false)
    expect(err.join('\n')).toContain('drift — it is at src/svc.ts:3')
  })

  it('truncates a multi-thousand-character base line in the failure message', () => {
    // `docs/syncplay.md`'s bullets are single lines running to several thousand
    // characters. Echoing one whole scrolls every other failure out of the
    // terminal, in a gate whose entire output is numbers to copy.
    const long = `- ${'the room mirror re-seats every watcher '.repeat(80)}`
    const r = runDrift(
      {
        'docs/wide.md': [long, 'A later line.', ''].join('\n') as string,
        'src/c.ts': '// (docs/wide.md:1)'
      },
      {
        'docs/wide.md': ['A new opening line.', long, 'A later line.', ''].join('\n'),
        'src/c.ts': '// (docs/wide.md:1)'
      }
    )

    expect(r.drift).toHaveLength(1)
    const line = report(r, noPins).err.find((l: string) => l.includes('the base had'))!
    expect(line.length).toBeLessThan(140)
    expect(line).toContain('…')
  })

  it('prints "not compared" rather than a zero when there is no base', () => {
    // The two outcomes a reader must be able to tell apart: the gate working and
    // finding nothing, and the gate not running at all. A single line reading
    // `drift: 0` renders them identical, which is the shape a printed-only number
    // always takes.
    const withBase = runDrift(
      { 'src/svc.ts': 'const a = 1\n', 'src/caller.ts': '// (src/svc.ts:1)' },
      { 'src/svc.ts': 'const a = 1\n', 'src/caller.ts': '// (src/svc.ts:1)' }
    )
    expect(report(withBase, noPins).out.join('\n')).toContain('1 anchor(s) compared against base')

    const without = run(base({ 'src/caller.ts': '// the increment (src/target.ts:3)' }))
    expect(report(without, noPins).out.join('\n')).toContain('drift: not compared')
  })

  it('fails on a missing base in CI and skips loudly only where there is no base', () => {
    // THE ONE DECISION CI CAN SILENTLY GET WRONG. A missing base must red rather
    // than skip, because a skip turns this gate off in the one place it has to
    // run. The merge-base/tip asymmetry is the other half: the tip locally blames
    // the branch for every shift that landed on `main` since the fork, and the tip
    // in CI is right because `refs/pull/N/merge` already contains base.
    expect(driftBasePlan({ haveTracking: true, haveOrigin: true, ci: false })).toEqual({
      path: 'merge-base'
    })
    expect(driftBasePlan({ haveTracking: false, haveOrigin: true, ci: false })).toEqual({
      path: 'tip'
    })
    expect(driftBasePlan({ haveTracking: false, haveOrigin: true, ci: true })).toEqual({
      path: 'tip'
    })
    expect(driftBasePlan({ haveTracking: false, haveOrigin: false, ci: true }).path).toBe('fail')
    expect(driftBasePlan({ haveTracking: false, haveOrigin: false, ci: false }).path).toBe('skip')
  })

  it('takes the tip in CI even though the tracking ref is there by then', () => {
    // THE ROW THAT WAS WRONG, and it was a hard red on every PR rather than a
    // silent skip. Routing on `haveTracking` before `ci` reads as safe only under
    // the premise that CI has no tracking ref. It has one: `check:version-not-lower`
    // runs earlier in the same `quality` job and takes `baseRevision()`'s fetching
    // branch, and `git fetch --depth=1 origin <base>` writes
    // `refs/remotes/origin/<base>` — `actions/checkout` builds the clone with
    // `git remote add`, whose `remote.origin.fetch` wildcard makes the fetch
    // update it opportunistically. Measured against a simulated depth-1 checkout
    // of a `refs/pull/N/merge`: the tracking ref is present, and
    // `git merge-base HEAD refs/remotes/origin/main` then exits 1 with no output,
    // because at depth 1 HEAD's parents are outside the shallow boundary.
    //
    // So this is the case the pinned table above cannot state, since `ci: true`
    // with a tracking ref is exactly the combination CI presents.
    expect(driftBasePlan({ haveTracking: true, haveOrigin: true, ci: true })).toEqual({
      path: 'tip'
    })
  })
})

describe('check-upstream-citations', () => {
  // `findings()` scopes on the `syncplay/` prefix the nightly script registers
  // the installed package under, so these corpora use it rather than the
  // `upstream/` of the fixtures above. Same analyzer, same injected `.py`
  // extension, one reader shared with `findings()` so the two cannot disagree
  // about what a file contains.
  const runFindings = (files: Corpus) => {
    const readLines = (p: string) => files[p].split('\n')
    const result = analyze({
      files: Object.keys(files),
      readLines,
      scanRoots: ['src', 'docs', 'test'],
      excludedPaths: [],
      resolvableExt: new Set(['.ts', '.md', '.py'])
    })
    return { result: result as Result, f: findings({ result, readLines }) }
  }

  it('flags a range that crosses a `def` and exempts the start line', () => {
    // THE EXEMPTION IS THE PREDICATE. Measured over the 165 ranged upstream
    // anchors at the pin, including the start line flags 97 of them and exempting
    // it flags 0 — the difference between a gate that ships green and a gate that
    // reds on every anchor that cites a function from its signature, which is the
    // correct way to cite a function.
    expect(defClassBoundary(UPSTREAM_CLASS, 3, 6)).toBe(4)

    // An empty interval, a single-line anchor, a range whose own start is the
    // `def`, and a range that is the two halves of one signature.
    expect(defClassBoundary(UPSTREAM_CLASS, 3, 3)).toBeNull()
    expect(defClassBoundary(UPSTREAM_CLASS, 3, null)).toBeNull()
    expect(defClassBoundary(UPSTREAM_CLASS, 4, 5)).toBeNull()
    expect(defClassBoundary(UPSTREAM_CLASS, 9, 10)).toBeNull()

    // A range that opens on a decorator and runs past the `def` it decorates IS a
    // crossing: the exemption is the START line, not "anything to do with a
    // definition". The brief's own case list has this one as null, which cannot be
    // right alongside `:6-9` below without the start exemption swallowing the end
    // line too.
    expect(defClassBoundary(UPSTREAM_CLASS, 8, 10)).toBe(9)
  })

  it('matches a decorated or `async` def at any indentation and nothing adjacent', () => {
    // The end line is in scope, so a range that stops exactly on the next
    // definition is caught — `:6-9` closes on `def handleChat`.
    expect(defClassBoundary(UPSTREAM_CLASS, 6, 9)).toBe(9)

    // Indentation is irrelevant (upstream's methods are all indented one level)
    // and `async def` counts. The negatives are the word-boundary cases a looser
    // `^def|^class` would take: a longer identifier, an assignment, a decorator
    // that merely starts with the word, and a commented-out definition.
    const probe = (line: string): number | null => defClassBoundary(['    pad = 1', line], 1, 2)
    expect(probe('    async def restartTimer(self):')).toBe(2)
    expect(probe('async def main():')).toBe(2)
    expect(probe('class RoomManager:')).toBe(2)
    expect(probe('        def nested():')).toBe(2)
    expect(probe('classmethod')).toBeNull()
    expect(probe('class_name = 1')).toBeNull()
    expect(probe('    @classmethod')).toBeNull()
    expect(probe('def_name = 1')).toBeNull()
    expect(probe('    # def forcePositionUpdate(self):')).toBeNull()
  })

  it('leaves the one blank-line landing alone, which the blank predicate still takes', () => {
    // THE MANDATED CONTRAST CASE, and both halves live in one `it` on purpose: a
    // later hand that merges the two predicates into "anything odd inside a cited
    // range" has to DELETE an assertion here rather than watch a count move.
    //
    // `server.py:251-257` is `_allowTLSconnections()` whole. The `def` is on the
    // START line, so the boundary predicate is silent — correctly, the citation
    // means the function. The blank at `:256` is an intra-function gap, which
    // `interiorBlankLine()` does report, which is why that anchor is named in
    // `UPSTREAM_LANDING_ALLOW` rather than repaired.
    expect(defClassBoundary(TLS_PY, 251, 257)).toBeNull()

    const r = runResolvingPy({
      'upstream/server.py': TLS_PY.join('\n') + '\n',
      'src/caller.ts': '// the TLS reload path (server.py:251-257)'
    })
    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([
      {
        at: 'src/caller.ts:1',
        cited: 'server.py:251-257',
        target: 'upstream/server.py',
        start: 256,
        why: 'blank line'
      }
    ])
  })

  it('does not flag a range that ends on a decorator above a `def`', () => {
    // THE NAMED RESIDUAL, asserted as a decision rather than left as an accident.
    // `protocols.py` carries one anchor of this shape. Adding a `/^@/` arm costs 0
    // extra flags over the 165 at the pin, so this is a free choice; it stays out
    // because a decorated boundary is not the boundary the issue asks about and
    // because `@` opens a line continuation as well as a decorator. If the miss
    // ever costs something, that measurement is where to start.
    expect(defClassBoundary(UPSTREAM_CLASS, 6, 8)).toBeNull()
  })

  it('names the citer, the anchor, the predicate and the pin on every finding', () => {
    // What a nightly issue has to carry, asserted field by field. It is read by
    // someone with no context loaded and possibly without a checkout, so a report
    // missing any of the four is a reason to go and re-derive the whole thing by
    // hand — which is the work the check exists to remove.
    const { f } = runFindings({
      'syncplay/server.py': FINDINGS_SERVER,
      'src/caller.ts': [
        '// the init body (server.py:3-4)',
        '// the chat relay (server.py:5-6)',
        '// long gone (server.py:999)',
        '// the setter (server.py:3 ("self.port = nope"))'
      ].join('\n')
    })

    expect(f.counts).toMatchObject({
      crossings: 1,
      landings: 1,
      unresolved: 1,
      quoteRot: 1,
      exempt: 0
    })

    const body = issueBody(f, {
      commitId: '993232ab095bb810593459bc705b3e6fc64ad161',
      runUrl: 'https://example.invalid/run/1',
      lineCounts: { 'syncplay/server.py': 8 }
    })

    // The citer, as `file:line`, for each of the four classes.
    expect(body).toContain('`src/caller.ts:1` cites `server.py:3-4`')
    expect(body).toContain('`src/caller.ts:2` cites `server.py:5-6`')
    expect(body).toContain('`src/caller.ts:3` cites `server.py:999`')
    expect(body).toContain('`src/caller.ts:4` cites `server.py:3`')

    // The predicate, by name, so the rule can be read rather than inferred.
    expect(body).toContain('`defClassBoundary()`')
    expect(body).toContain('`interiorBlankLine()`')
    expect(body).toContain('`analyze()` resolver')
    expect(body).toContain('`verifyQuote()`')

    // The pin, on every row and not only in the header: a figure copied out of a
    // six-week-old nightly must not read as a figure about today's upstream.
    const rows = (body as string)
      .split('\n')
      .filter((l: string) => l.startsWith('- `src/caller.ts:'))
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(row).toContain('measured against `993232ab095bb810593459bc705b3e6fc64ad161`')
    }

    // And the two things that make the report checkable without the tree.
    expect(body).toContain('`syncplay/server.py` — 8 lines')
    expect(body).toContain('npm run check:upstream-citations')
    expect(body).toContain('conformance/README.md')
  })

  it('keys the landing allow-list on the citer AND the anchor, not on a count', () => {
    // WHY A LIST AND NOT A NUMBER. There is exactly one legitimate upstream
    // landing at the pin, so "expect 1" would pass — and would go on passing if a
    // different anchor slid onto a different blank line, because the count is
    // unchanged. Both halves of the key are load-bearing: the same citer repointed
    // is a different claim, and the same anchor written somewhere else is a
    // different reader.
    const corpus: Corpus = {
      'syncplay/server.py': FINDINGS_SERVER,
      'src/caller.ts': '// the chat relay (server.py:5-6)'
    }
    const readLines = (p: string) => corpus[p].split('\n')
    const result = analyze({
      files: Object.keys(corpus),
      readLines,
      scanRoots: ['src', 'docs', 'test'],
      excludedPaths: [],
      resolvableExt: new Set(['.ts', '.py'])
    })

    const exact = [{ at: 'src/caller.ts:1', cited: 'server.py:5-6' }]
    expect(findings({ result, readLines, allow: exact }).counts).toMatchObject({
      landings: 0,
      exempt: 1
    })

    // Same anchor, different citer — and the other way round. Each reds on its own.
    const otherCiter = [{ at: 'src/elsewhere.ts:9', cited: 'server.py:5-6' }]
    const otherAnchor = [{ at: 'src/caller.ts:1', cited: 'server.py:5-7' }]
    for (const allow of [otherCiter, otherAnchor, []]) {
      expect(findings({ result, readLines, allow }).counts).toMatchObject({
        landings: 1,
        exempt: 0
      })
    }
  })

  it('verifies a marked upstream quote once the target is on disk', () => {
    // THE BEHAVIOUR DIFFERENCE, in the direction the nightly adds. A marked `.py`
    // anchor is checked by nothing in `quality`: the quote is extracted above the
    // extension gate in `analyze()`, so the anchor leaves the unmarked ceiling and
    // then takes the foreign-extension `continue` before `verifyQuote()` ever sees
    // it. With the target on disk the comparison actually happens.
    const correct = runResolvingPy({
      'upstream/server.py': UPSTREAM,
      'src/caller.ts': '// the broadcast (server.py:4 ("room.broadcast(watcher)"))'
    })
    expect(correct.marked).toHaveLength(1)
    expect(correct.quoteFailures).toEqual([])

    const stale = runResolvingPy({
      'upstream/server.py': UPSTREAM,
      'src/caller.ts': '// the broadcast (server.py:4 ("room.broadcastRoom(watcher)"))'
    })
    expect(stale.quoteFailures).toHaveLength(1)
    expect(stale.quoteFailures[0]).toMatchObject({
      at: 'src/caller.ts:1',
      cited: 'server.py:4',
      quote: 'room.broadcastRoom(watcher)',
      elsewhere: []
    })

    // The characterisation half, and the reason this is a behaviour difference
    // rather than a restatement: with the shipped extension list the SAME stale
    // marked anchor reports nothing at all. It is counted in `markedPy`, left out
    // of `marked`, and never compared — which is precisely the hole the nightly
    // closes.
    const asShipped: Corpus = {
      'upstream/server.py': UPSTREAM,
      'src/caller.ts': '// the broadcast (server.py:4 ("room.broadcastRoom(watcher)"))'
    }
    const shipped = analyze({
      files: Object.keys(asShipped),
      readLines: (p: string) => asShipped[p].split('\n'),
      scanRoots: ['src', 'docs', 'test'],
      excludedPaths: []
    }) as Result
    expect(shipped.markedPy).toBe(1)
    expect(shipped.marked).toEqual([])
    expect(shipped.quoteFailures).toEqual([])
  })

  it('fails a path-qualified upstream anchor the registered tree does not carry', () => {
    // The nightly registers the installed package under `syncplay/`, so an anchor
    // spelled with a different prefix must FAIL rather than fall back to the
    // basename and resolve against a file nobody named. Silent resolution here
    // would be the gate attesting an anchor to a path it does not have.
    const r = runResolvingPy({
      'upstream/server.py': UPSTREAM,
      'src/caller.ts': '// the signature (syncplay/server.py:3)'
    })

    expect(r.failures).toEqual([
      {
        at: 'src/caller.ts:1',
        cited: 'syncplay/server.py:3',
        why: 'no such file in this repo'
      }
    ])
    expect(r.resolved).toEqual([])
  })

  it('refuses to measure anchors against a tree that is not the pinned one', () => {
    // BOTH SHAS IN THE MESSAGE. The two ways this fires — a moved pin served a
    // cached install, and a correct install with a wrong workflow edit — look
    // identical from outside, so a message naming only the expected sha says which
    // number to trust and not which number to change.
    const pinned = '993232ab095bb810593459bc705b3e6fc64ad161'
    const other = 'c9345d490b1d9533692508bc0c76638d8105dfba'

    expect(() => assertPinnedTree({ commitId: pinned, expected: pinned })).not.toThrow()

    let message = ''
    try {
      assertPinnedTree({ commitId: other, expected: pinned })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain(other)
    expect(message).toContain(pinned)

    // A wheel or sdist install records no `vcs_info`, so there is nothing to
    // compare — which is a failure, not a licence to assume the pin.
    expect(() => assertPinnedTree({ commitId: null, expected: pinned })).toThrow(/direct_url/)
  })

  it('throws rather than defaulting when the workflow carries no pin', () => {
    // A DEFAULT HERE WOULD BE THE WORST FAILURE THIS SCRIPT HAS: it would attest
    // every anchor against a commit nobody installed, print a clean report and
    // exit 0 — a gate that skips being indistinguishable from a gate that passes.
    const yaml = [
      'jobs:',
      '  conformance:',
      '    steps:',
      '      - run: |',
      '          "$RUNNER_TEMP/sp176/bin/pip" install --no-deps \\',
      "            'git+https://github.com/Syncplay/syncplay@993232ab095bb810593459bc705b3e6fc64ad161'"
    ].join('\n')
    expect(pinnedCommitFromWorkflow(yaml)).toBe('993232ab095bb810593459bc705b3e6fc64ad161')

    expect(() => pinnedCommitFromWorkflow('jobs:\n  conformance:\n    steps: []\n')).toThrow(
      /No pinned Syncplay commit/
    )
    // A tag rather than a commit is the near miss, and it is the one #367 ruled
    // out: a tag can be moved, so it is not a tree.
    expect(() =>
      pinnedCommitFromWorkflow("  'git+https://github.com/Syncplay/syncplay@v1.7.6'\n")
    ).toThrow(/No pinned Syncplay commit/)
  })

  it('reproduces step 0’s three repaired anchors, and names what it cannot decide', () => {
    // CHARACTERISATION, at the real line numbers so each claim is checkable
    // against the pinned tree by eye. These are the three anchors #395 step 0
    // repaired by hand; the predicate flags the broken form of each and clears the
    // repair.
    expect(defClassBoundary(SERVER_PY, 847, 849)).toBe(848)
    expect(SERVER_PY[847]).toContain('def _resetStateTimer')
    expect(defClassBoundary(SERVER_PY, 841, 843)).toBeNull()

    expect(defClassBoundary(SERVER_PY, 779, 787)).toBe(780)
    expect(SERVER_PY[779]).toContain('def getPosition')
    expect(defClassBoundary(SERVER_PY, 780, 787)).toBeNull()

    expect(defClassBoundary(CLIENT_PY, 454, 484)).toBe(467)
    expect(CLIENT_PY[466]).toContain('def getUserOffset')
    expect(defClassBoundary(CLIENT_PY, 454, 465)).toBeNull()

    // FIRST HIT ONLY, so one citation is one finding however many definitions it
    // spans. That range crosses four, and the report names the first.
    const crossed: number[] = []
    for (let n = 455; n <= 484; n++) {
      if (/^(?:async\s+)?def\b|^class\b/.test(CLIENT_PY[n - 1].trim())) crossed.push(n)
    }
    expect(crossed).toEqual([467, 470, 475, 480])

    // THE HONEST LIMIT, asserted rather than left to be discovered on a repair.
    // The predicate names a bad anchor; it cannot choose between two candidate
    // repairs. `server.py:848-852` is the WRONG repair of `:847-849` — it keeps
    // the timer-reset body and drops the `_askForStateUpdate` line the prose was
    // about — and it is just as clean here, because its `def` is on the start line
    // and the start line is exempt.
    expect(defClassBoundary(SERVER_PY, 848, 852)).toBeNull()
  })
})

// --- #461: the pin figures `docs/testing.md` restates in prose ----------------
//
// Two of the four pins are restated as a figure in the prose, and until this
// block nothing compared the figure with the constant. #459 took `MARKED_PIN`
// from 64 to 75 and left the page saying "floored at 64"; #460 repaired it by
// hand. Second time around, and both times a human reading the paragraph was
// the only thing that caught it — which is the defect class the gate itself
// exists to police, turned on the gate's own documentation.
//
// THE LOCATOR IS THE WHOLE DESIGN RISK, because a brittle one reds on unrelated
// prose edits and trains people to adjust the pattern instead of the number. A
// bare phrase will not do: `/floored at (\d+)/` matches three times on this
// tree — the headline plus the two coverage floors in the thresholds section,
// which are `vitest.config.ts` numbers and out of scope here. So each pattern is
// the FULL bullet heading, matched against the whole document text rather than
// line by line, since this page has multi-thousand-character lines. A match
// count other than one is itself a mismatch, so a reworded heading reds instead
// of quietly matching nothing.
//
// The two pins that state no figure get the mirrored guard, passed through the
// same `pins` argument: the heading occurs exactly once, and the pin's own value
// does not appear in the bullet body — so adding a figure there later reds and
// forces the choice between wiring it in and taking it back out. The rule is
// keyed on each pin's OWN value rather than on digits in general, which is the
// revision that matters: a no-bare-integer rule reds on this tree, because the
// suspicious-landings bullet legitimately measures two stale anchors as "one 81
// lines behind its subject and one 119". Accepted blind spot, recorded rather
// than implied closed: a figure spelled as a word ("pinned exactly at four")
// gets through.
//
// Deliberately NOT asserted: the cap's value where the page restates it as a
// *measurement* ("262 anchors across 27 citing files", "false by 262"). The cap
// is one-sided, so after a retrofit the count and the cap can legitimately
// differ and asserting them would be wrong.

const { MARKED_PIN, UNMARKED_PY_PIN, SUSPICIOUS_LANDING_PIN, UNCHECKABLE_PIN } = citations

const TESTING_DOC = join(import.meta.dirname, '..', 'docs', 'testing.md')

type PinName = 'suspiciousLanding' | 'uncheckable' | 'marked' | 'unmarkedPy'
type DocPins = Record<PinName, number>
type DocMismatch = { pin: PinName; why: string }

// The figure lives in the heading for both pins that carry one, which is also
// where one would naturally be added to the other two. `\s+` rather than a
// literal space because a hand rewrap splitting `floored at\n  75.**` would
// otherwise read as a reworded heading — and `check:prose-shape` actively
// pressures authors to rewrap short lines in this very list.
const FIGURE_PINS: { pin: PinName; heading: RegExp }[] = [
  { pin: 'marked', heading: /\*\*Marked\s+citations,\s+floored\s+at\s+(\d+)\.\*\*/ },
  {
    pin: 'unmarkedPy',
    heading: /\*\*Unmarked\s+upstream\s+`\.py`\s+anchors,\s+capped\s+at\s+(\d+)\.\*\*/
  }
]

// Literals rather than patterns, because this heading is also where the body
// slice starts. A rewrap here is the same loud zero-match failure, just not
// tolerated the way the two above tolerate it.
const FIGURELESS_PINS: { pin: PinName; heading: string }[] = [
  { pin: 'suspiciousLanding', heading: '**Suspicious landings, pinned exactly.**' },
  { pin: 'uncheckable', heading: '**Uncheckable anchors.**' }
]

const countLiteral = (text: string, needle: string): number => text.split(needle).length - 1

// An ATX heading, spelled as a heading: 1-6 `#` opening a line, followed by a
// space, a tab or the end of the line. #467's repair — this arm used to be the
// literal `'\n#'`, which is looser than a heading and matches ANY line opening
// with `#`, so an unindented lazy continuation that merely starts with an issue
// reference (`#368 took 4 more`) counted as a heading, ended the span there, and
// let every figure written after that point through SILENTLY. That is the quiet
// direction and the one this guard exists for; the loud direction, a reworded
// heading, already reds through the exactly-once count. The page's own habit
// supplies the shape: two lines in `docs/testing.md` open with a non-heading `#`
// today, and whether it bites is only a question of where a rewrap puts one.
//
// DUPLICATED ON PURPOSE RATHER THAN SHARED. test/check-prose-shape.test.ts
// carries the same three-way boundary with its own copy of this predicate, and
// #467 exists because one bug then had to be fixed in two places — so a change
// here is a change there. Weighed and kept anyway: a module both files import
// from, for one regex, buys less than it couples, and both helpers are local to
// their own file on the same reasoning. THERE ARE TWO COPIES.
const ATX_HEADING = /\n#{1,6}(?:[ \t]|$)/m

// Pure, and local to this file on purpose: the pins are `export const` in an ES
// module, so a test cannot make one disagree with the doc by reassignment. The
// real-tree case passes `readFileSync` plus the imported constants; the
// regression cases pass doctored text. The gate script is unchanged and exports
// nothing new for this.
const pinProseMismatches = (docText: string, pins: DocPins): DocMismatch[] => {
  const out: DocMismatch[] = []

  for (const { pin, heading } of FIGURE_PINS) {
    const hits = [...docText.matchAll(new RegExp(heading.source, 'g'))]
    if (hits.length !== 1) {
      out.push({ pin, why: `heading matched ${hits.length} times, expected exactly 1` })
      continue
    }
    const documented = Number(hits[0][1])
    if (documented !== pins[pin]) {
      out.push({ pin, why: `prose says ${documented}, constant is ${pins[pin]}` })
    }
  }

  for (const { pin, heading } of FIGURELESS_PINS) {
    const found = countLiteral(docText, heading)
    if (found !== 1) {
      out.push({ pin, why: `heading matched ${found} times, expected exactly 1` })
      continue
    }
    const start = docText.indexOf(heading)
    const from = start + heading.length
    // THE END BOUNDARY IS DELIBERATE, and the next bullet alone does not provide
    // it. `indexOf('\n- **')` searches the whole remainder of the document, and
    // this page carries 23 further top-level `- **` bullets below the pins list,
    // so -1 is only reached if the bullet moves below the last of them —
    // reordering it inside its own list does not get there. Measured: moving
    // `**Uncheckable anchors.**` to the end of its list grows its body from 7
    // lines (446 chars) to 31 (1946), across a `###` heading and three unrelated
    // paragraphs, and the value scan then reaches a bare `87` in that prose. It
    // stays green at 116 today, which is the problem: the over-reach is silent,
    // and `4` collides far more easily than `116` does.
    //
    // So bound at the FIRST of the next bullet, the next blank line and the next
    // heading. That really does end a bullet, and it leaves the -1 branch below
    // as defence rather than as the mechanism: all three absent means the page
    // is not shaped the way this guard was written against — the trailing text
    // is a lazy continuation of the bullet or the end of the file — so it is
    // reported instead of guessed at.
    //
    // The heading arm is `ATX_HEADING` (see its note above for why a literal
    // `'\n#'` is not a heading, and for the second copy of it). `search` on the
    // slice returns an offset relative to `from`, so its -1 is mapped through
    // UNCHANGED: add it to `from` and `from - 1` survives the filter below, wins
    // the `Math.min`, and the body collapses to the anchor alone.
    const headingFrom = docText.slice(from).search(ATX_HEADING)
    const ends = [
      docText.indexOf('\n- **', from),
      docText.indexOf('\n\n', from),
      headingFrom === -1 ? -1 : from + headingFrom
    ].filter((at) => at !== -1)
    if (ends.length === 0) {
      out.push({
        pin,
        why: 'bullet has no following bullet, blank line or heading, so its body is unbounded'
      })
      continue
    }
    const body = docText.slice(start, Math.min(...ends))
    if (new RegExp(String.raw`(?<![#:\d])\b${pins[pin]}\b`).test(body)) {
      // HEDGED ON PURPOSE. The suspicious-landings bullet is 2.9k characters of
      // measurement prose about counts, and `\b4\b` is clean today only because
      // the page spells its small numbers as words ("all thirteen", "catches
      // two"). Write one of those as a digit and this fires on a measurement, so
      // a message that only said "wire it into the heading" would be telling the
      // next reader to do precisely the wrong thing — the same measurement-vs-pin
      // distinction the cap's restatements are excluded under.
      out.push({
        pin,
        why:
          `bullet body contains ${pins[pin]}, this pin's own value — if that is the pin, ` +
          `wire it into the heading or drop it; if it is a measurement that happens to equal ` +
          `the pin, spell it as a word, as the rest of the bullet does`
      })
    }
  }

  return out
}

// The numbers the doctored fixtures below state in their own prose. Frozen
// deliberately: a regression case must keep reproducing the #459 failure after
// the next pin raise, so it compares a fixture against fixture pins and never
// against the live constants.
const FIXTURE_PINS: DocPins = {
  suspiciousLanding: 4,
  uncheckable: 116,
  marked: 75,
  unmarkedPy: 262
}

// Four bullets in the page's own order, each replaceable. Every string here is
// kept free of `.py:NNN` shapes: this file is in `EXCLUDED_PATHS` so the gate
// will not see them, but the direct-scan census in `docs/testing.md` counts
// citation-shaped strings in this file against the gate's cap, and that cap is
// currently flush — which is exactly how #457 carried a census forward wrong.
const docFixture = (over: Partial<Record<PinName, string>> = {}): string =>
  [
    'Four pinned counts are what give that teeth — two exact, one a floor and',
    'one a ceiling:',
    '',
    over.suspiciousLanding ??
      '- **Suspicious landings, pinned exactly.** #344 repaired the two the\n  narrowing exposed, one 81 lines behind its subject and one 119, both into\n  `docs/syncplay.md:119`. #390 contributed three more and #384 one.',
    // `#116` carries the `#` arm of the lookbehind, and nothing else in these
    // fixtures does: `\b116\b` matches straight after a `#`, because `#` is not
    // a word character, so an issue reference — ordinary prose in a repo whose
    // issues are in the hundreds — would false-red without it. Drop `#` from
    // `(?<![#:\d])` and every case using this default bullet reds.
    over.uncheckable ??
      '- **Uncheckable anchors.** Pathless anchors that inherit their path from a\n  neighbour, all of them upstream shorthand. #116 took\n  four of them the other way.',
    over.marked ??
      '- **Marked citations, floored at 75.** One of the two one-sided counts here,\n  because the marked class can only shrink silently.',
    over.unmarkedPy ??
      '- **Unmarked upstream `.py` anchors, capped at 262.** The other one-sided\n  count, and the only one where growth is the hazard.',
    '',
    // A sentinel tail: it says 4 and 116 outside every bullet, so a body slice
    // that over-reaches past its bullet reds the no-mismatch case above.
    'That is 4 pins in total, 116 of them uncheckable on this tree.'
  ].join('\n')

describe('the pin figures docs/testing.md restates', () => {
  it('matches every documented figure against the constant it restates', () => {
    const doc = readFileSync(TESTING_DOC, 'utf8')
    const pins: DocPins = {
      suspiciousLanding: SUSPICIOUS_LANDING_PIN,
      uncheckable: UNCHECKABLE_PIN,
      marked: MARKED_PIN,
      unmarkedPy: UNMARKED_PY_PIN
    }

    // A renamed export would arrive here as `undefined`, which makes the
    // value-not-in-body regex `\bundefined\b` and the whole guard vacuous
    // instead of red. Stated rather than trusted.
    expect(Object.values(pins).every((n) => Number.isInteger(n))).toBe(true)

    expect(pinProseMismatches(doc, pins)).toEqual([])

    // The exactly-once property, stated directly as well as enforced through the
    // helper, because it is what keeps the locator honest in the other
    // direction: a heading that stops matching must red, not pass vacuously.
    for (const { heading } of FIGURE_PINS) {
      expect(doc.match(new RegExp(heading.source, 'g'))).toHaveLength(1)
    }
    for (const { heading } of FIGURELESS_PINS) {
      expect(countLiteral(doc, heading)).toBe(1)
    }
  })

  it('describes the uncheckable pin as upstream shorthand, with ambiguous basenames failing (#517)', () => {
    // The guard above checks the bullet does not restate the pin's value; it
    // cannot see the bullet describing the wrong population. Before #517 the
    // bullet opened on "Bare basenames more than one tracked file carries" — the
    // class that now fails outright — so a reader sizing the pin would count
    // something it no longer contains. Bounded the same way the guard bounds it.
    const doc = readFileSync(TESTING_DOC, 'utf8')
    const heading = '**Uncheckable anchors.**'
    const from = doc.indexOf(heading)
    expect(from).toBeGreaterThan(-1)
    const body = doc.slice(from, doc.indexOf('\n- **', from))

    expect(body.startsWith(`${heading} Pathless`)).toBe(true)
    expect(body).toContain('upstream Syncplay')
    expect(body).toMatch(/no\s+longer\s+counted\s+here:\s+it\s+fails\s+outright/)
  })

  it('reds when a documented figure drifts from its constant', () => {
    // THE #459 FAILURE, reproduced. On `main` nothing notices this, which is how
    // it shipped: the page said "floored at 64" against a constant of 75 for a
    // whole PR, and a human reading the paragraph was the only check.
    const drifted = docFixture({
      marked: '- **Marked citations, floored at 74.** One of the two one-sided counts.'
    })
    expect(pinProseMismatches(drifted, FIXTURE_PINS)).toEqual([
      { pin: 'marked', why: 'prose says 74, constant is 75' }
    ])

    // The cap drifts the same way and is caught the same way.
    const cap = docFixture({
      unmarkedPy: '- **Unmarked upstream `.py` anchors, capped at 263.** The other one.'
    })
    expect(pinProseMismatches(cap, FIXTURE_PINS)).toEqual([
      { pin: 'unmarkedPy', why: 'prose says 263, constant is 262' }
    ])
  })

  it('reds on a reworded or duplicated heading rather than matching nothing', () => {
    // A ZERO-MATCH PASS IS THE FAILURE MODE A FIGURE CHECK HAS. Rewording the
    // heading is an ordinary prose edit, and without the count assertion it
    // would silence the comparison for good.
    const reworded = docFixture({
      marked: '- **Marked citations, with a floor of 75.** One of the two one-sided counts.'
    })
    expect(pinProseMismatches(reworded, FIXTURE_PINS)).toEqual([
      { pin: 'marked', why: 'heading matched 0 times, expected exactly 1' }
    ])

    // Same for a figureless heading, which is matched as a literal.
    const renamed = docFixture({
      uncheckable: '- **Uncheckable basename anchors.** Bare basenames and pathless anchors.'
    })
    expect(pinProseMismatches(renamed, FIXTURE_PINS)).toEqual([
      { pin: 'uncheckable', why: 'heading matched 0 times, expected exactly 1' }
    ])

    // Both directions for the figureless pins too, not just the zero one:
    // weakening `found !== 1` to `found < 1` has to red here. Duplicated, the
    // body slice would take whichever copy came first and the other would go
    // unguarded.
    const twoCopies =
      '- **Uncheckable anchors.** Bare basenames and pathless anchors.\n- **Uncheckable anchors.** Restated in a later summary.'
    expect(pinProseMismatches(docFixture({ uncheckable: twoCopies }), FIXTURE_PINS)).toEqual([
      { pin: 'uncheckable', why: 'heading matched 2 times, expected exactly 1' }
    ])

    // Two copies are as bad as none: the comparison would then be against
    // whichever one happens to come first.
    const twice = docFixture({
      marked:
        '- **Marked citations, floored at 75.** One of two.\n- **Marked citations, floored at 75.** Restated in a summary.'
    })
    expect(pinProseMismatches(twice, FIXTURE_PINS)).toEqual([
      { pin: 'marked', why: 'heading matched 2 times, expected exactly 1' }
    ])
  })

  it('reds when a figureless bullet states its own pin value, and ignores the rest', () => {
    const stated = docFixture({
      uncheckable:
        '- **Uncheckable anchors.** Bare basenames and pathless anchors. The pin is\n  116 on this tree.'
    })
    expect(pinProseMismatches(stated, FIXTURE_PINS)).toEqual([
      {
        pin: 'uncheckable',
        why:
          "bullet body contains 116, this pin's own value — if that is the pin, wire it into " +
          'the heading or drop it; if it is a measurement that happens to equal the pin, spell ' +
          'it as a word, as the rest of the bullet does'
      }
    ])

    // THE KEYING IS THE POINT, and the earlier revision of this rule got it
    // wrong: "no bare integer in the body" reds on `main`, because the
    // suspicious-landings bullet measures two stale anchors as "one 81 lines
    // behind its subject and one 119". Keyed on the pin's own value it ignores
    // those, every `#NNN` issue number, every `:NNN` anchor, and a longer run
    // the digit merely starts.
    const measurements =
      '- **Suspicious landings, pinned exactly.** #344 repaired two, one 81 lines\n  behind its subject and one 119, at `docs/syncplay.md:4` and 44 lines apart.'
    expect(
      pinProseMismatches(docFixture({ suspiciousLanding: measurements }), FIXTURE_PINS)
    ).toEqual([])

    // And the same body with the pin written into it does red, so the clean
    // result above is a property of the keying rather than of a guard that
    // never fires.
    expect(
      pinProseMismatches(
        docFixture({ suspiciousLanding: `${measurements} The pin is 4.` }),
        FIXTURE_PINS
      )
    ).toEqual([
      {
        pin: 'suspiciousLanding',
        why:
          "bullet body contains 4, this pin's own value — if that is the pin, wire it into " +
          'the heading or drop it; if it is a measurement that happens to equal the pin, spell ' +
          'it as a word, as the rest of the bullet does'
      }
    ])
  })

  it('ends a bullet at the next bullet, blank line or heading, whichever comes first', () => {
    // THE QUIET OVER-REACH, in the shape it takes on the real page. Bounding on
    // the next `- **` alone does not fail loudly when a bullet moves to the end
    // of its list, because the page has 23 more top-level bullets below: the
    // body just grows across a heading and whatever prose follows, and the value
    // scan reaches digits that have nothing to do with this pin. Measured on
    // `docs/testing.md`, relocating `**Uncheckable anchors.**` takes its body
    // from 7 lines to 31 and reaches a bare `87`.
    const relocated = [
      'Pins:',
      '',
      '- **Marked citations, floored at 75.** One of two.',
      '- **Unmarked upstream `.py` anchors, capped at 262.** The other.',
      '- **Suspicious landings, pinned exactly.** Still where it was.',
      '- **Uncheckable anchors.** Moved to the end of its own list.',
      '',
      '### What `resolved` does and does not attest',
      '',
      'An unrelated paragraph that happens to say 116, well below the list.',
      '',
      '- **The marked form.** A bullet in a later list entirely.'
    ].join('\n')

    // The stray digit really is in reach of a slice that runs to the next
    // bullet — this is the misdiagnosis the three-way bound prevents, not a
    // hypothetical.
    expect(new RegExp(String.raw`(?<![#:\d])\b116\b`).test('that happens to say 116, well')).toBe(
      true
    )
    expect(pinProseMismatches(relocated, FIXTURE_PINS)).toEqual([])

    // DEFENCE, not the mechanism: with no following bullet, blank line or
    // heading, the bullet's extent is whatever the rest of the file is — a lazy
    // continuation line here, which markdown would fold into the bullet and this
    // helper will not guess about.
    const unbounded = [
      'Pins:',
      '',
      '- **Marked citations, floored at 75.** One of two.',
      '- **Unmarked upstream `.py` anchors, capped at 262.** The other.',
      '- **Uncheckable anchors.** Bare basenames and pathless anchors.',
      '- **Suspicious landings, pinned exactly.** Last bullet in the file.',
      'A lazy continuation line, with no blank line before it, that says 4.'
    ].join('\n')
    expect(pinProseMismatches(unbounded, FIXTURE_PINS)).toEqual([
      {
        pin: 'suspiciousLanding',
        why: 'bullet has no following bullet, blank line or heading, so its body is unbounded'
      }
    ])
  })

  it('reds on a figure past a continuation line that merely starts with a hash', () => {
    // THE #467 FAILURE, reproduced. The heading arm used to be the literal
    // `'\n#'`, which is not a heading: it matches any line opening with `#`. So
    // a continuation that starts with an issue reference ended the bullet right
    // there and everything after it — the pin's own value included — went
    // through SILENTLY. Revert the arm to `'\n#'` and this case returns `[]`.
    //
    // THE MISSING INDENTATION ON THE `#368` LINE IS DELIBERATE — DO NOT TIDY IT
    // UP TO MATCH ITS NEIGHBOURS. Continuations in this list are indented two
    // spaces, and `'\n#'` never matched an indented line, which is precisely why
    // this span has never truncated on the real page: `docs/testing.md` already
    // carries `  #393 inserted exactly that line…` inside the
    // suspicious-landings bullet, harmlessly. Indent the line below and the old
    // and new predicates agree, the mismatch comes back under both, and the case
    // stops reproducing anything. The unindented shape is the page's own habit
    // too: two of its paragraph lines open with a non-heading `#` today.
    const continued = docFixture({
      uncheckable:
        '- **Uncheckable anchors.** Pathless anchors, all of them upstream shorthand,\n' +
        '#368 took the mid-seek model the other way, and nothing on this line is a\n' +
        '  heading. The pin is 116 on this tree.'
    })
    expect(pinProseMismatches(continued, FIXTURE_PINS)).toEqual([
      {
        pin: 'uncheckable',
        why:
          "bullet body contains 116, this pin's own value — if that is the pin, wire it into " +
          'the heading or drop it; if it is a measurement that happens to equal the pin, spell ' +
          'it as a word, as the rest of the bullet does'
      }
    ])

    // And the halves of that, stated so the case cannot pass for the wrong
    // reason: the `#368` line really is at column 0, and the value really is
    // past it.
    expect(continued).toContain('\n#368 took')
    expect(continued.indexOf('The pin is 116')).toBeGreaterThan(continued.indexOf('\n#368'))
  })

  it('bounds the bullet at a real ATX heading, hard against the text with no blank line', () => {
    // THE OTHER MUTANT. A heading in real markdown follows a blank line, so a
    // fixture shaped that way is bounded by the `\n\n` arm whether the heading
    // arm exists or not — the `relocated` case above is exactly that, and
    // deleting the heading arm leaves it green. Here the heading is hard against
    // the bullet and the blank line is PAST the value, so the heading arm is the
    // only thing keeping `116` out of the body: delete it and the `\n\n` arm
    // wins, the body swallows the value, and this reds.
    const headedHard = [
      'Pins:',
      '',
      '- **Marked citations, floored at 75.** One of two.',
      '- **Unmarked upstream `.py` anchors, capped at 262.** The other.',
      '- **Suspicious landings, pinned exactly.** Still where it was.',
      '- **Uncheckable anchors.** Bare basenames and pathless anchors.',
      '## Next',
      'The pin is 116 on this tree, one line past the heading.',
      '',
      'A closing paragraph.'
    ].join('\n')
    expect(pinProseMismatches(headedHard, FIXTURE_PINS)).toEqual([])

    // Nothing else bounds it: no further `- **`, and the only blank line comes
    // after the value. Asserted rather than assumed, because either one would
    // make the mutant survive.
    expect(headedHard.indexOf('\n- **', headedHard.indexOf('**Uncheckable anchors.**'))).toBe(-1)
    expect(headedHard.indexOf('\n\n', headedHard.indexOf('## Next'))).toBeGreaterThan(
      headedHard.indexOf('The pin is 116')
    )
  })

  it('treats seven hashes and a hash run into text as prose, and a bare hash as a heading', () => {
    // The predicate's other edge, pinned so a later loosening shows up rather
    // than passing quietly. `#{1,6}` followed by a space, a tab or end of line
    // is the whole rule.
    const atxish = (second: string): string =>
      [
        'Pins:',
        '',
        '- **Marked citations, floored at 75.** One of two.',
        '- **Unmarked upstream `.py` anchors, capped at 262.** The other.',
        '- **Suspicious landings, pinned exactly.** Still where it was.',
        '- **Uncheckable anchors.** Bare basenames and pathless anchors.',
        second,
        'The pin is 116 on this tree, one line past it.',
        '',
        'A closing paragraph.'
      ].join('\n')

    const stated = {
      pin: 'uncheckable' as const,
      why:
        "bullet body contains 116, this pin's own value — if that is the pin, wire it into " +
        'the heading or drop it; if it is a measurement that happens to equal the pin, spell ' +
        'it as a word, as the rest of the bullet does'
    }

    // Seven hashes is not an ATX heading, so it does not end the bullet and the
    // value past it is in the body. Loosen `#{1,6}` to `#+` and this goes green.
    expect(
      pinProseMismatches(atxish('####### Seven hashes is one too many.'), FIXTURE_PINS)
    ).toEqual([stated])

    // A hash run straight into text is not one either — the `#368` shape of the
    // regression case above, in the same frame as its neighbours here.
    expect(pinProseMismatches(atxish('#368 is an issue reference.'), FIXTURE_PINS)).toEqual([
      stated
    ])
    expect(pinProseMismatches(atxish('###Three and no space.'), FIXTURE_PINS)).toEqual([stated])

    // A bare hash alone on a line IS an ATX heading — the `$` arm under `/m` —
    // so it does end the bullet. Drop `|$` from the predicate and this reds.
    expect(pinProseMismatches(atxish('#'), FIXTURE_PINS)).toEqual([])
    expect(pinProseMismatches(atxish('###'), FIXTURE_PINS)).toEqual([])

    // A tab after the hashes counts as well, so the two arms of `[ \t]` are both
    // live rather than one of them being decoration.
    expect(pinProseMismatches(atxish('##\tTab after the hashes.'), FIXTURE_PINS)).toEqual([])
  })
})
