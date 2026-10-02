// Fixtures for the prose-shape measurement (#370). Every case that drives
// `analyze()` drives it over a synthetic corpus rather than the real tree, for
// the reason test/check-line-citations.test.ts gives: the real tree's counts are
// the gate's own pin and move with every repair. Here that is not a general
// principle but a live constraint — most of the ragged population sits in
// docs/testing.md, the file #366 and #369 both renumber, so an assertion
// written against a live line number is a test whose next rebase deletes it.
// #379 proved the renumbering half of that between PR 1 and PR 2: it added four
// ragged lines to that file and moved every other one, taking the count from 14
// to 18 without touching this gate at all.
//
// WHERE the population lives is stated above; HOW BIG it is deliberately is not.
// This header used to say "docs/testing.md carries 8 of the 9 hits on this tree"
// and was wrong on both halves from #368 until #464 came back for it. A
// hand-copied census figure in the test file for the gate that polices
// hand-copied figures is the defect this file now guards against below, so no
// replacement figure is written here: the pin moves down whenever one of those
// lines is genuinely repaired, and its distribution across files moves with it,
// so any count stated here is one repair away from being the #368 defect again.
//
// The one block that does read a real file — the `RAGGED_PIN` restatement cases
// at the foot of this file (#464) — reads docs/testing.md and compares it with
// the pin constant, never with a count taken off the tree, so the reason above
// still holds there.
//
// The corpus lives INLINE, which is also why this file needs no `EXCLUDED_PATHS`
// entry: its ragged prose is a string handed to `analyze()`, never a file on
// disk, so the gate cannot scan its own test data and there is no path-shaped
// exclusion to keep in sync. The one real-file read above does not change that:
// it reads another page as text and never hands it to `analyze()`.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig graph
import { analyze, classify, report, RAGGED_PIN } from '../scripts/check-prose-shape.mjs'

type Corpus = Record<string, string>

type Hit = { path: string; line: number; len: number; blockMax: number; text: string }

type Kind = { kind: 'skip' | 'break' | 'item' | 'text'; why?: string }

type Result = {
  scannedCount: number
  scanned: string[]
  hits: Hit[]
  byFile: Map<string, number>
  deficit: number
}

const run = (files: Corpus, scanRoots: string[] = ['.', 'docs']): Result =>
  analyze({
    files: Object.keys(files),
    readLines: (p: string) => files[p].split('\n'),
    scanRoots
  }) as Result

const linesOf = (r: Result): number[] => r.hits.map((h) => h.line)

// THE MOTIVATING DEFECT, frozen. This is the `docs/testing.md` bullet a rebase
// conflict in the #362/#363/#364 series left ragged: its eighth line stops at 41
// columns in the middle of a sentence, inside a block whose longest line is 79.
// Human review is what caught it, because nothing in `typecheck`, `lint`,
// `format:check` or the suite reads prose shape — `.prettierignore` carries
// `**/*.md`, and with it removed Prettier still leaves the line byte-identical
// because no `proseWrap` is set.
//
// Copied verbatim rather than paraphrased: the widths ARE the fixture, and a
// tidied-up imitation would be a test of a shape nobody wrote.
//
// THE UPPER CUT IS LOAD-BEARING. The excerpt runs to
// `docs/testing.md:122` ("replaces this module wholesale") and must, because
// `docs/testing.md:121` ("structured-clones them") is the 79-column line that
// SETS `blockMax`. Every other line of the bullet is 66-78. Cut the excerpt
// anywhere above that line and `blockMax` falls with it, the assertion below
// silently stops being 41/79, and the case STILL REDS — on a different deficit,
// for a different reason, with nobody the wiser. That is why the cut is named
// here rather than left to look arbitrary to whoever next shortens the fixture.
// (The last line is 52 columns and contributes nothing: it is the block's last
// line, so clause (b) exempts it.) Raised in review on #370.
//
// The two anchors above are spelled with their path, rather than as a bare
// colon-and-number. A pathless anchor lands in `UNCHECKABLE_PIN` and reds
// check:line-citations — measured, not assumed: the first draft of this comment
// carried three of them and took that pin from 117 to 120, and the rewrite left
// two behind in this very sentence, which named the bare form by writing it.
// Marked, so the sibling gate verifies the quote rather than merely the line's
// existence, which is what keeps this comment honest the next time
// docs/testing.md is renumbered.
const RAGGED_BULLET = [
  '- **In-process IPC loop** (`test/setup/electron-mock.ts` → `test/ipc/`) — the',
  '  global `electron` mock can close the bridge on itself: `ipcMain.handle`',
  '  registrations are always recorded, and `__enableIpcLoop()` makes',
  "  `ipcRenderer.invoke` route into them and return the handler's result. Both",
  '  failure paths reject with the string a renderer actually sees — `Error',
  "  invoking remote method '<channel>': <Name>: <message>` — for a handler that",
  '  throws and for a channel nobody handled; `syncplay-bridge.test.ts` pins both',
  '  shapes verbatim. The main→renderer half',
  '  was already closed — a broadcaster that calls `__emit` lands on the same',
  "  `ipcRenderer.on` registry the preload's `subscribe()` writes to — so a test",
  '  can drive a real router, the real `src/preload/index.ts` and a real',
  '  broadcast module against each other with no Electron runtime. Opt-in per',
  "  file, because routing `invoke` changes what every other suite's bare spy",
  '  returns; `__reset()` clears both registries and disarms it. It is **not** an',
  '  IPC emulation: arguments and return values pass by reference where real IPC',
  "  structured-clones them, and a file that declares its own `vi.mock('electron',",
  '  …)` replaces this module wholesale, loop included.',
  ''
].join('\n')

// A hand-formatted run of parenthetical citations, copied from the same file.
// Four consecutive short lines, each deliberately broken so a citation sits on a
// line of its own. See the characterisation test at the bottom: three of the four
// red before clause (e) and ONE after it, and each of the three that stay green
// does so for a different reason, which is what the case is there to record.
const CITATION_RUN = [
  "  equivalent. A `doSeek` or a pause change takes the reference's other path instead:",
  '  a forced update that bypasses the election, carries the `ignoringOnTheFly`',
  '  server counter and re-seats every watcher on the new position',
  "  (`Room.setPosition`) — while deliberately *not* refreshing the room's",
  '  `_lastUpdate`, so the next re-election runs from the last election rather than',
  '  the last write and a playing room reads ahead of the playhead a seek just set.',
  '  Drives real `SyncplayClient`s through the `net`/`tls` mocks',
  '  (`test/services/syncplay-mirror-election.test.ts`, #277;',
  '  `test/services/syncplay-mirror-drift.test.ts`, #279), and, through the',
  '  two-peer harness below, real renderers on top of them',
  '  (`test/services/syncplay-seek-crossfire.test.ts`, #361).',
  ''
].join('\n')

// The one repair instruction that belongs to the RISING arm of the pin and must
// never reach the falling one. Held as a constant because both arms assert on it
// — the rising arm that it is there, the falling arm that it is not — and a `not`
// with no positive twin passes against wording nothing produces.
const REWRAP_ADVICE = 'rewrap the line you just wrote'

describe('check-prose-shape', () => {
  it('reds on the short line a rebase left inside a wrapped bullet', () => {
    // THE REGRESSION CASE. Line 8 is `shapes verbatim. The main→renderer half`:
    // 41 columns where its neighbours run to 79, ending mid-sentence on "half".
    // Nothing else in the bullet reds — the other sixteen lines are wrapped
    // within a few columns of each other, which is what makes the deficit rule
    // a signal here rather than a census of a hand-wrapped paragraph.
    const r = run({ 'docs/testing.md': RAGGED_BULLET })

    // SOFT, so the 41/79 is observed even when the line set is wrong. A hard
    // `toEqual` on `linesOf` short-circuits everything under it, and the widths
    // are the whole fixture: a defect that reports the right line at the wrong
    // deficit would be invisible behind a green line-set assertion, and a defect
    // that reports the wrong line would hide the widths rather than show them.
    expect.soft(linesOf(r)).toEqual([8])
    expect.soft(r.hits[0]).toMatchObject({
      path: 'docs/testing.md',
      len: 41,
      blockMax: 79,
      text: 'shapes verbatim. The main→renderer half'
    })
    // And it survives clause (e): the next line opens `was already closed`, so a
    // greedy wrapper had 34 columns of room to pull `was` up. That is what makes
    // the motivating defect a CHOSEN break rather than a forced one, and it is
    // the reason clause (e) can remove 9 of the 18 without removing this.
    expect.soft(report(r, { ragged: 1 }).ok).toBe(true)
  })

  // --- the green classes ------------------------------------------------------

  it('stays quiet on a paragraph whose final line is legitimately short', () => {
    // Clause (b). A paragraph's last line is short because the paragraph ended,
    // which is every well-wrapped paragraph in the tree. Without this clause the
    // predicate reports one hit per paragraph and measures nothing.
    const r = run({
      'docs/notes.md': [
        'The mirror election runs on every playstate the server sends, and the room',
        'reads the position it last wrote rather than the one the playhead is at.',
        'A short tail.',
        ''
      ].join('\n')
    })

    expect(r.hits).toEqual([])

    // The same class with no full stop to fall back on: a paragraph whose last
    // line is a trailing parenthetical citation. Clause (d) cannot save this
    // one, so it is clause (b) alone holding it green — which is what makes
    // deleting clause (b) observable rather than redundant with the terminal
    // rule.
    const parenthetical = run({
      'docs/notes.md': [
        'The two-peer harness starts both clients against the same in-memory server',
        'and drives them through the real transport mocks, one election at a time',
        '(`test/services/syncplay-seek-crossfire.test.ts`)',
        ''
      ].join('\n')
    })

    expect(parenthetical.hits).toEqual([])
  })

  it('stays quiet on a short list item among long ones', () => {
    // Clause (a)'s list-item boundary. A bullet is its own block, so a one-line
    // bullet is a block of one and cannot be ragged — it has no non-final line.
    // Without this boundary the whole list is one block and every short bullet
    // scores against the longest bullet in it: 116 hits on this tree against 14,
    // 45 of them in TODO.md alone.
    const r = run({
      'docs/notes.md': [
        '- **Unit** — services and `lib` helpers driven through their own seams, with',
        '  an in-memory storage fake',
        '- **Integration** — flows wired through the app harness',
        '- **End-to-end** — Playwright against a packaged build.',
        ''
      ].join('\n')
    })

    // Two of these four lines are short, carry no closing punctuation and are
    // not the last line of the list — so the ONLY thing holding them green is
    // that each bullet is its own block. Delete the boundary and this case
    // reports both of them, which is the shape of the 116-against-14 difference
    // at tree scale.
    expect(r.hits).toEqual([])
  })

  it('stays quiet on the line immediately before a fenced block', () => {
    // A fence closes the block above it, so the sentence that introduces a code
    // sample is a block's last line however short it is — and a lead-in like
    // "Run:" is short by construction.
    const r = run({
      'docs/notes.md': [
        'The two-peer harness starts both clients against the same in-memory server',
        'and drives them through the real transport mocks.',
        'Run:',
        '',
        '```bash',
        'npm run test',
        '```',
        ''
      ].join('\n')
    })

    expect(r.hits).toEqual([])
  })

  it('stays quiet on a YAML front-matter block', () => {
    // EXCLUSION 1. Front matter is short `name:` and `description:` keys sharing
    // a block with one long `description:`, which is a pure false-positive
    // generator: 14 of the 51 raw hits on this tree, every one of them an
    // agent-instruction header. In scope it is zero because the roots exclude
    // those directories; excluded by content it is zero wherever it appears.
    const r = run({
      'docs/notes.md': [
        '---',
        'name: pr-review',
        'description: Review a pull request against the repository conventions, the',
        '  architecture index and the per-subsystem pages under docs/',
        'model: opus',
        '---',
        '',
        'Body prose that is long enough to make a block of its own without tripping',
        'anything, and that ends properly.',
        ''
      ].join('\n')
    })

    expect(r.hits).toEqual([])
  })

  it('scans a file that opens with a thematic break rather than skipping it to EOF', () => {
    // The front-matter exclusion, bounded. An opening `---` alone is not front
    // matter: without a CLOSING `---` the old predicate skipped every line to
    // EOF, so the file contributed nothing while still counting towards
    // `scannedCount` — silently unmeasured, and indistinguishable in the report
    // from a file that is clean. That is the exact failure mode the header
    // argues hardest against, and PR 2 pins the difference. Raised in review on
    // #374; this six-line corpus is the one measured there.
    const unterminated = run({
      'docs/notes.md': [
        '---',
        'The two-peer harness starts both clients against the same in-memory server',
        'a short line that just stops',
        'the tail of the paragraph.',
        '',
        'A closing paragraph that ends properly.'
      ].join('\n')
    })

    // SOFT, both of them, so a defect that moves both is REPORTED as both
    // rather than as the first alone. Measured honestly, the second half here is
    // the weakest of the three pairs softened in this PR: the corpus is
    // unindented, so `len` equals the trimmed length and every defect that moves
    // `len` also moves the line set the first assertion pins. Only a
    // report-only width defect reaches it with the first still green (mutating
    // the pushed `len` to `len - 1` does, and nothing in the predicate does). It
    // stays as a width record, not as coverage of a seam the first misses.
    expect.soft(linesOf(unterminated)).toEqual([3])
    expect
      .soft(unterminated.hits[0])
      .toMatchObject({ len: 28, text: 'a short line that just stops' })

    // The other half, so the narrowing cannot become a deletion: REAL front
    // matter — an opening `---` with a closing `---` — is still skipped whole,
    // ragged `description:` keys and all.
    const realFrontMatter = run({
      'docs/notes.md': [
        '---',
        'name: pr-review',
        'description: Review a pull request against the repository conventions, and',
        '  the architecture index',
        'model: opus',
        '---',
        '',
        'Body prose that is long enough to make a block of its own without tripping',
        'anything, and that ends properly.',
        ''
      ].join('\n')
    })

    expect(realFrontMatter.hits).toEqual([])
  })

  it('does not let a `---` inside a fence stand in for the front-matter closer', () => {
    // The same narrowing, bounded again. The closer search was `some()` over the
    // whole file, so ANY later `---` satisfied it — including one inside a
    // fenced YAML sample, which is how a docs page shows front matter. The file
    // below opens with a thematic break and shows a front-matter sample in a
    // fence further down; unbounded, the opener is promoted to front matter and
    // everything down to the sample's first `---` classifies `skip`, taking the
    // ragged line 3 with it. Narrower than the pre-#374 behaviour, same shape:
    // silently unmeasured, indistinguishable from clean. Raised in review on
    // #374; this corpus is the one measured there.
    //
    // Bounding the search at the first fence AT THE LEFT MARGIN is the fix. The
    // tighter bound — requiring the closer before the first blank line — looks
    // right and is wrong: `.github/agents/todo-reviewer.agent.md` has a blank
    // line inside its front matter, and that rule starts reporting
    // `name: todo-reviewer` at 19/41. Out of scope today, but the header argues
    // the content rule holds independent of the root choice, so it is not taken.
    const fencedSample = run({
      'docs/notes.md': [
        '---',
        'The two-peer harness starts both clients against the same in-memory server',
        'a short line that just stops',
        'the tail of the paragraph.',
        '',
        '```yaml',
        '---',
        'name: pr-review',
        '---',
        '```',
        '',
        'A closing paragraph that ends properly.'
      ].join('\n')
    })

    // Under the unbounded search this is `[]` — the hit does not move, it
    // disappears.
    // SOFT, and here the second half reaches a seam the first does not: it pins
    // `blockMax`, which the line set cannot see. A `blockMax` off by one leaves
    // `[3]` green — the deficit is 46 columns, nowhere near the bar — and reds
    // only this.
    expect.soft(linesOf(fencedSample)).toEqual([3])
    expect.soft(fencedSample.hits[0]).toMatchObject({
      len: 28,
      blockMax: 74,
      text: 'a short line that just stops'
    })

    // The non-deletion arm, again: REAL front matter whose closer arrives before
    // any fence is still skipped whole, and a fenced `---` sample below it does
    // not confuse the bound.
    const realFrontMatterThenFence = run({
      'docs/notes.md': [
        '---',
        'name: pr-review',
        'description: Review a pull request against the repository conventions, and',
        '  the architecture index',
        '---',
        '',
        '```yaml',
        '---',
        'name: a sample of front matter, shown in a fence',
        '---',
        '```',
        '',
        'Body prose that is long enough to make a block of its own without tripping',
        'anything, and that ends properly.',
        ''
      ].join('\n')
    })

    expect(realFrontMatterThenFence.hits).toEqual([])
  })

  it('keeps front matter that holds a fence inside an indented block scalar', () => {
    // THE THIRD ARM, and it is a regression test: the first cut of the bound
    // above was `FENCE`, any indentation, and it re-opened the very class the
    // front-matter exclusion exists to kill. A YAML block scalar
    // (`description: |`) may hold a fenced sample, indented under its key — the
    // shape an agent-instruction header takes when it documents a command. The
    // bound stopped at that fence, the closing `---` on line 11 was never
    // reached, the file was refused as front matter, and its keys were scanned
    // as prose: `name: todo-reviewer` at 19/77 and `description: |` at 14/77,
    // two hits at the head of a file that must report none.
    //
    // A fence INSIDE front matter can only be indented, because an unindented
    // one would be a YAML key of its own. So the margin is what separates the
    // two cases, and the corpus in the test above — a fenced `---` sample at
    // column 0 — is the one that still has to bound the search.
    const blockScalar = run({
      'docs/notes.md': [
        '---',
        'name: todo-reviewer',
        'description: |',
        '  Reviews the TODO list against the tree and reports what has drifted. Run it',
        '  like this:',
        '',
        '  ```sh',
        '  npm run check:todo',
        '  ```',
        'model: opus',
        '---',
        '',
        'Body prose that is long enough to make a block of its own without tripping',
        'anything, and that ends properly.',
        ''
      ].join('\n')
    })

    expect(blockScalar.hits).toEqual([])
  })

  it('stays quiet on a raw HTML block', () => {
    // EXCLUSION 2, and the largest single class: 23 of the 51 raw hits on this
    // tree, all of them README.md's centred badge table. `<br />` is 8 columns
    // against a 247-column `<a href=…><img …/></a>`, which is a markup fact and
    // not a wrap anyone chose.
    //
    // The rule is BLOCK-SHAPED — it opens on a line whose first non-space
    // character is `<` and runs to the next blank line — so a run of plain text
    // inside a `<td>` is excluded with the tags around it. The line-shaped
    // alternative (`^\s*<` per line) measures the same 14 on this tree because
    // every badge line opens with a tag; this fixture is what tells the two
    // apart, since its `Latest release` line carries no tag of its own.
    const badges = run({
      'README.md': [
        '<p>',
        '  <a href="https://github.com/mikkerlo/anime-downloader/releases/latest"><img src="https://img.shields.io/github/v/release/mikkerlo/anime-downloader?style=flat-square" alt="Latest release" /></a>',
        '  <br />',
        '  <img src="https://img.shields.io/badge/license-ISC-blue?style=flat-square" alt="License: ISC" />',
        '</p>',
        ''
      ].join('\n')
    })

    expect(badges.hits).toEqual([])

    // And the half that tells BLOCK-shaped apart from LINE-shaped: prose inside
    // a `<td>`, wrapped by hand, carrying no tag of its own. The line-shaped
    // rule sees three ordinary prose lines and reports the short one; the
    // block-shaped rule sees the cell it is sitting in. Both measure 14 on this
    // tree — every badge line opens with a tag — so this fixture is the only
    // thing that distinguishes them, and it is why the block-shaped reading is
    // the one written down.
    const cell = run({
      'README.md': [
        '<table>',
        '  <tr>',
        '    <td>',
        '      MKV streaming — the player pulls remuxed segments straight from the source',
        '      and never writes a temp file',
        '      while the subtitles render natively.',
        '    </td>',
        '  </tr>',
        '</table>',
        ''
      ].join('\n')
    })

    expect(cell.hits).toEqual([])
  })

  it('stays quiet inside a fenced code block', () => {
    // EXCLUSION 3, and the one that decides whether this is a measurement or
    // noise. Clause (a) names a fence as a block BOUNDARY; read literally, the
    // lines between two fences then form blocks of their own and get scanned,
    // which measures 282 hits in 13 files on this tree against 14 with them
    // skipped — 85 from one data-flow diagram, 50 from an ASCII source tree, 19
    // from wire transcripts. An indented listing is not ragged prose and nobody
    // can act on the report, so fenced contents are not scanned at all.
    // An interface listing, the docs/types.md shape. Every declaration line is
    // tens of columns short of the one long member and none of them ends in
    // prose punctuation, so with fence contents scanned this fixture reports
    // three hits on code that is indented exactly as it should be.
    const r = run({
      'docs/types.md': [
        '```ts',
        'interface SyncplayRoom {',
        '  name: string',
        '  watchers: Record<string, { position: number; paused: boolean; file: FileInfo | null }>',
        '  position: number',
        '}',
        '```',
        ''
      ].join('\n')
    })

    expect(r.hits).toEqual([])
  })

  it('does not let a mismatched fence marker close the fence it is sitting in', () => {
    // EXCLUSION 3's failure mode, and it fails OPEN. Detecting a fence without
    // CAPTURING its marker lets any opener close any fence, so the lines after
    // the impostor leak into the prose population — the one exclusion priced at
    // 14 against 282 hits, defeated by a line of sample Markdown. Raised in
    // review on #374; both corpora below are the ones measured there.
    //
    // A `~~~` inside a ```-fence. With a single toggled boolean it closes the
    // fence and the two lines under it are scanned as prose, reporting `short
    // leaf` at 10/76 — a tree listing, indented exactly as it should be.
    const tildeInBacktick = run({
      'docs/notes.md': [
        '```text',
        '  ├── src/main/',
        '~~~',
        'short leaf',
        '  ├── syncplay.ts — the client, the mirror election and the drift guard here',
        '```',
        ''
      ].join('\n')
    })

    expect(tildeInBacktick.hits).toEqual([])

    // And the same defect from the other side: a ``` inside a ````-fence, which
    // is how a docs page shows a fenced sample without the sample eating the
    // page. CommonMark closes a fence only on a run of the SAME character at
    // least as long, so three backticks cannot close four. With the boolean it
    // does, and `short arg` reports at 9/76.
    const backtickInWider = run({
      'docs/notes.md': [
        '````',
        'a sample of a fenced block, shown inside a wider fence so it renders intact',
        '```',
        'short arg',
        '  --dry-run  print the plan and exit without writing anything to disk at all',
        '````',
        ''
      ].join('\n')
    })

    expect(backtickInWider.hits).toEqual([])
  })

  it('does not let a marker carrying an info string close the fence it is sitting in', () => {
    // EXCLUSION 3's third part, and the one the captured marker still let
    // through: `fence[1]` pins the character and the length, but a closing fence
    // in CommonMark is the marker and nothing but whitespace after it. Without
    // group 2 a ```js line closes a ```markdown one — and a docs page showing a
    // fenced sample with a language tag is the commonest shape in this repo.
    // Raised in review on #374; this corpus is the one measured there.
    //
    // It fails OPEN in BOTH directions at once, which is why one corpus carries
    // both halves:
    //
    //   - the sample's own lines leak into the prose population — line 4 reports
    //     `short code arg` at 14/76, a command listing indented exactly as it
    //     should be;
    //   - and the sample's REAL closer on line 6 then re-OPENS a fence, so the
    //     genuine prose on lines 8-10 classifies `fenced code` and the ragged
    //     line 9 is never measured. That is the front-matter thread's shape
    //     arriving through the fence: content that is silently not measured is
    //     indistinguishable in the report from content with nothing wrong.
    const lines = [
      '```markdown',
      'Everything below is a sample of the very page this gate had to learn to read.',
      '```js',
      'short code arg',
      '  --dry-run  print the plan and exit without writing anything to disk at all',
      '```',
      '',
      'Genuine prose after the fenced sample, wrapped by hand to a sensible width',
      'a short line that just stops',
      'the tail of the paragraph.',
      ''
    ]
    const r = run({ 'docs/notes.md': lines.join('\n') })

    // One assertion for both halves: the leaked 14/76 is absent AND the
    // swallowed 28/74 is present. Under the unfixed predicate this reads
    // `[{ line: 4, len: 14, blockMax: 76, text: 'short code arg' }]` — the wrong
    // line, from inside the sample, with the real one gone.
    expect.soft(r.hits).toEqual([
      {
        path: 'docs/notes.md',
        line: 9,
        len: 28,
        blockMax: 74,
        text: 'a short line that just stops'
      }
    ])

    // And the classification directly, because `hits` can only observe a line
    // the predicate would have flagged: every line the impostor guards stays
    // fenced code, including the impostor itself.
    const kinds = classify(lines) as Kind[]
    expect.soft(kinds.slice(2, 5)).toEqual([
      { kind: 'skip', why: 'fenced code' },
      { kind: 'skip', why: 'fenced code' },
      { kind: 'skip', why: 'fenced code' }
    ])
    expect.soft(kinds[5]).toEqual({ kind: 'skip', why: 'fence' })
    expect.soft(kinds.slice(7, 10).map((k) => k.kind)).toEqual(['text', 'text', 'text'])
  })

  it('does not let an indented marker close the fence it is sitting in', () => {
    // EXCLUSION 3's fourth part, and the last one the marker rule let through.
    // A closing fence is indented at most 3 columns past the fence it closes;
    // beyond that the line is code content. Under an unbounded `^\s*` the marker
    // below closed the ```markdown fence it sits in, and the defect arrived in
    // both directions at once, exactly as the info-string one does: `short code
    // arg` leaked out at 14/76, and line 6's real closer then RE-OPENED a fence,
    // swallowing the ragged 28/74 on line 9.
    //
    // The opener here sits at the margin, so 4 columns is past the bound. The
    // test below is the other half: the same 4 columns against an opener that is
    // itself indented, which must still close.
    const lines = [
      '```markdown',
      'Everything below is a sample of the very page this gate had to learn to read.',
      '    ```',
      'short code arg',
      '  --dry-run  print the plan and exit without writing anything to disk at all',
      '```',
      '',
      'Genuine prose after the fenced sample, wrapped by hand to a sensible width',
      'a short line that just stops',
      'the tail of the paragraph.',
      ''
    ]
    const r = run({ 'docs/notes.md': lines.join('\n') })

    // SOFT, deliberately. A hard `toEqual` on `hits` short-circuits the
    // classification assertions below, so a mutation that breaks all three is
    // observed through one of them and the other two are never exercised — which
    // is how a mutation control can come back green-looking on coverage it never
    // had. Soft runs every assertion and reports each that reds.
    expect.soft(r.hits).toEqual([
      {
        path: 'docs/notes.md',
        line: 9,
        len: 28,
        blockMax: 74,
        text: 'a short line that just stops'
      }
    ])

    // The classification directly: the indented marker is fenced CODE, not a
    // fence, and so is everything it guards.
    const kinds = classify(lines) as Kind[]
    expect.soft(kinds.slice(2, 5)).toEqual([
      { kind: 'skip', why: 'fenced code' },
      { kind: 'skip', why: 'fenced code' },
      { kind: 'skip', why: 'fenced code' }
    ])
    expect.soft(kinds[5]).toEqual({ kind: 'skip', why: 'fence' })
    expect.soft(kinds.slice(7, 10).map((k) => k.kind)).toEqual(['text', 'text', 'text'])
  })

  it('closes an indented fence with a closer indented to match it', () => {
    // The other half of the indent bound, and the reason it is measured against
    // the OPENER rather than the left margin. CommonMark takes fence
    // indentation from the CONTAINER's content column, so a fence inside a list
    // item indented to column 4 opens and closes at column 4 and is legal.
    //
    // An absolute `^ {0,3}` refuses both markers here, and then every line
    // between them is scanned as prose: this corpus gains two hits, the
    // `` ```bash `` marker at 11/58 and a raw `jj` command line at 32/58, on top
    // of the genuine one below. That is not hypothetical — five
    // `.gemini/skills/*/SKILL.md` files carry exactly this shape, and the
    // absolute bound takes the broad tree count from 14 to 40, all 26 of them
    // fenced code. The bound exists to stop code leaking into the prose
    // population; an absolute one leaks more than it stops.
    const lines = [
      '8.  **Commit, Push, and PR**: use `jj` for the commit and `gh` for the PR,',
      '    which is the step this list has been building towards all along',
      '',
      '    ```bash',
      '    jj describe -m "Commit message. Fixes #<issue-number>"',
      '    jj bookmark create <branch-name> -r @',
      '    jj git push -b <branch-name>',
      '    ```',
      '',
      'Genuine prose after the list, wrapped by hand to a sensible width indeed',
      'a short line that just stops',
      'the tail of the paragraph.',
      ''
    ]
    const r = run({ 'docs/notes.md': lines.join('\n') })

    // Only the genuine ragged line, from AFTER the list: nothing from inside the
    // fence, and the fence really did close, so line 11 is prose and not code.
    expect.soft(r.hits).toEqual([
      {
        path: 'docs/notes.md',
        line: 11,
        len: 28,
        blockMax: 72,
        text: 'a short line that just stops'
      }
    ])

    const kinds = classify(lines) as Kind[]
    expect.soft(kinds[3]).toEqual({ kind: 'skip', why: 'fence' })
    expect
      .soft(kinds.slice(4, 7).map((k) => k.why))
      .toEqual(['fenced code', 'fenced code', 'fenced code'])
    expect.soft(kinds[7]).toEqual({ kind: 'skip', why: 'fence' })
    // And the fence is CLOSED, not still open: the prose below classifies as
    // prose. Under an absolute bound the opener never opened, so these read
    // `text` for the wrong reason — hence the `hits` assertion above as well.
    expect.soft(kinds.slice(9, 12).map((k) => k.kind)).toEqual(['text', 'text', 'text'])
  })

  // --- the clauses, one at a time ---------------------------------------------

  it('takes the deficit against the block maximum, absolutely and not as a ratio', () => {
    // Clause (c). 20 columns exactly is the bar, so 19 is silent and 20 reds —
    // written as a pair because a threshold pinned on one side only is satisfied
    // by any looser rule. Absolute rather than ratio: a ratio makes the bar
    // depend on how long the longest line in the block happens to be, so the
    // same 60-column line is a hit in one paragraph and clean in another.
    const block = (short: string): Corpus => ({
      'docs/notes.md': [
        'x'.repeat(80),
        short,
        'the tail of the paragraph, which is never judged',
        ''
      ].join('\n')
    })

    expect(run(block('y'.repeat(61))).hits).toEqual([])
    expect(linesOf(run(block('y'.repeat(60))))).toEqual([2])
  })

  it('leaves a short line that ends a thought alone', () => {
    // Clause (d). A line ending in `.`, `:`, `;`, `!` or `?` stopped on purpose.
    // Dropping the rule takes this tree from 14 hits to 19 inside the prose
    // roots and from 374 to 443 at the issue's widest measurement — it is the
    // second of the two parameters that decide whether this is a gate.
    const block = (short: string): Corpus => ({
      'docs/notes.md': ['x'.repeat(80), short, 'the tail of the paragraph.', ''].join('\n')
    })

    for (const ending of ['.', ':', ';', '!', '?']) {
      expect(run(block('a short deliberate stop' + ending)).hits).toEqual([])
    }
    expect(linesOf(run(block('a short line that just stops')))).toEqual([2])
  })

  it('leaves a short line alone when the next token could not have fitted on it', () => {
    // CLAUSE (e), GREEN SIDE, and the boundary is pinned on BOTH sides in the
    // next case, because a threshold pinned on one side only is satisfied by any
    // looser rule — including "never report anything".
    //
    // `blockMax` is 80 and the short line is 55, so a greedy wrapper had exactly
    // 24 columns left after the joining space. A 25-column next token does not
    // fit, no wrapper could have produced any other break here, and the line is
    // short for a MECHANICAL reason rather than a chosen one.
    //
    // Deliberately content-free: the next token is a run of `z`. On the live
    // tree the class this catches is the unbreakable backticked path, but the
    // rule is arithmetic over two lengths and does not consult what the token
    // contains — which is exactly what separates it from the rejected
    // "next line opens with a parenthesis" rule, written against the very lines
    // it was meant to pardon.
    const block = (nextToken: string): Corpus => ({
      'docs/notes.md': [
        'x'.repeat(80),
        'y'.repeat(55),
        nextToken + ' and the paragraph then runs on for a while yet',
        'the tail of the paragraph.',
        ''
      ].join('\n')
    })

    expect(run(block('z'.repeat(25))).hits).toEqual([])
  })

  it('still reds a short line when the next token would have fitted on it', () => {
    // CLAUSE (e), RED SIDE — the same corpus one column narrower. 55 + 1 + 24 is
    // exactly 80, so the next token fits the block maximum precisely and the
    // break was CHOSEN. Written as the pair to the case above: with only the
    // green half, deleting clause (e)'s condition and always returning "could
    // not fit" would still pass.
    const block = (nextToken: string): Corpus => ({
      'docs/notes.md': [
        'x'.repeat(80),
        'y'.repeat(55),
        nextToken + ' and the paragraph then runs on for a while yet',
        'the tail of the paragraph.',
        ''
      ].join('\n')
    })

    expect.soft(linesOf(run(block('z'.repeat(24))))).toEqual([2])
    expect.soft(run(block('z'.repeat(24))).hits[0]).toMatchObject({ len: 55, blockMax: 80 })
  })

  it('reports three hits around a lone unbreakable token and four behind a word', () => {
    // CLAUSE (e)'S SECOND-ORDER EFFECT, which is the number the script's comment
    // and docs/testing.md both quote at the reader. Pinned here because nothing
    // in this suite pinned it and the sentence drifted: both texts called the
    // four-hit shape a *bare* URL until review on #380, and a bare URL is the
    // shape that reports three.
    //
    // One six-line paragraph wrapped at 76-77 columns whose fourth line is 103
    // columns EITHER WAY, so `blockMax` is 103 in both corpora and the only
    // difference between them is what `firstToken` of that line returns:
    //
    //   the whole line is one token   -> 3 hits, lines 1, 2 and 5
    //   a short word, then the token  -> 4 hits, lines 1, 2, 3 and 5
    //
    // Line 3 is the one that moves and clause (e) is what takes it. With a
    // single 103-column token below it, `76 + 1 + 103 > 103`: the break after
    // line 3 was FORCED, so (e) pardons the line above the token as well as the
    // token's own break. Put a three-column word in front and `76 + 1 + 3` fits
    // inside 103, the break becomes a chosen one, and the fourth hit appears.
    // Four is therefore the count for word-then-link, the commoner shape in
    // prose, and never for a URL sitting alone on its line.
    //
    // Content-free in the idiom of the two cases above: the token is a run of
    // `z`. On the live tree the class is a bare URL or a long backticked path,
    // but the rule reads two lengths and consults neither.
    const paragraph = (fourth: string): Corpus => ({
      'docs/notes.md': [
        'a paragraph wrapped by hand at the usual bar, in which every one of these six',
        'lines sits at seventy-six or seventy-seven columns, and not one of them stops',
        'early on purpose, so the only line a greedy wrapper could not have broken is',
        fourth,
        'and the paragraph itself carries on past the long line for another line or so',
        'so that the block is comfortably long enough for this deficit to be measured.',
        ''
      ].join('\n')
    })

    const alone = run(paragraph('z'.repeat(103)))
    const behindAWord = run(paragraph('see ' + 'z'.repeat(99)))

    expect.soft(linesOf(alone)).toEqual([1, 2, 5])
    expect.soft(linesOf(behindAWord)).toEqual([1, 2, 3, 5])
    // Both sides measured against the same 103, so the extra hit is clause (e)
    // and nothing else — and it is the 76-column line, not a wider one.
    expect.soft(alone.hits[0]).toMatchObject({ len: 77, blockMax: 103 })
    expect.soft(behindAWord.hits[2]).toMatchObject({ line: 3, len: 76, blockMax: 103 })
  })

  // NO TEST FOR "the next line in the BLOCK, not in the FILE". One was written
  // and then deleted, because it could not fail: a block's line indices are
  // contiguous by construction (every non-`text`/`item` kind flushes the block,
  // and `item` opens a new one), so `block[b + 1]` and `i + 1` are the same
  // index in every corpus that can be built. Mutating the script to `i + 1` left
  // all cases green and the live-tree count unmoved. Recorded here rather than
  // kept as a green case that looks like coverage of a seam it never touched.

  it('breaks a block on a heading, a table row, a blockquote and a rule', () => {
    // The rest of clause (a). Each of these lines is markup rather than prose,
    // so it is neither scanned nor counted into a neighbour's `blockMax`: the
    // short cell of a table would otherwise be ragged against the widest row.
    const r = run({
      'docs/notes.md': [
        '## A heading that is quite long indeed, and is not prose to be judged',
        'short prose',
        '',
        '| a | b |',
        '| - | - |',
        '| a very long cell indeed, long enough to dominate a block | x |',
        '',
        '> a quoted line that runs on for a good long while, as quotations do',
        'short again',
        '',
        '---',
        ''
      ].join('\n')
    })

    expect(r.hits).toEqual([])
  })

  // --- scan scope -------------------------------------------------------------

  it('scans the prose roots and leaves agent-instruction markdown out', () => {
    // The scope choice is worth 3.4x on the raw count — 18 of the 44 tracked
    // `.md` live under `.claude/`, `.gemini/` and `.github/`, and every
    // front-matter hit comes from them. This is NOT `SCAN_ROOTS` in
    // scripts/check-line-citations.mjs, which governs outbound anchors and
    // covers `src`, `test`, `e2e` and `scripts` as well.
    const ragged = ['x'.repeat(80), 'a short line that just stops', 'the tail.', ''].join('\n')
    const corpus: Corpus = {
      'DESIGN.md': ragged,
      'docs/testing.md': ragged,
      'src/shared/README.md': ragged,
      '.claude/skills/pr-review/SKILL.md': ragged,
      '.github/agents/todo-reviewer.agent.md': ragged,
      'test/fixtures/shikimori/README.md': ragged,
      'src/main/syncplay.ts': ragged
    }

    // No `scanRoots` here: `analyze` falls back to the exported `SCAN_ROOTS`, so
    // this pins the config as well as the arm in `underRoot` that reads it.
    const r = analyze({
      files: Object.keys(corpus),
      readLines: (p: string) => corpus[p].split('\n')
    }) as Result

    // Split, and this is the STRONGEST of the three pairs: `scanned` pins which
    // files the root filter admits, `hits` pins that each admitted file was
    // actually read and measured. Restricting the read loop to the first
    // selected file reds this second assertion and NOTHING ELSE in the file —
    // every other case drives a one-file corpus — so it is the only thing
    // standing between "selected the right files" and "measured them".
    expect.soft(r.scanned).toEqual(['DESIGN.md', 'docs/testing.md', 'src/shared/README.md'])
    expect
      .soft(r.hits.map((h) => h.path))
      .toEqual(['DESIGN.md', 'docs/testing.md', 'src/shared/README.md'])
  })

  it('does not scan a file under an excluded path', () => {
    // The parameter exists for symmetry with the sibling's seam and is empty by
    // default, because this gate's fixtures are inline strings rather than files
    // on disk. Pinned so the seam cannot be dropped as unused.
    const ragged = ['x'.repeat(80), 'a short line that just stops', 'the tail.', ''].join('\n')
    const r = analyze({
      files: ['docs/testing.md', 'docs/generated/api.md'],
      readLines: () => ragged.split('\n'),
      excludedPaths: ['docs/generated/']
    }) as Result

    expect(r.scanned).toEqual(['docs/testing.md'])
  })

  // --- the citation run -------------------------------------------------------

  it('reds one line of a hand-formatted citation run and clears two by arithmetic', () => {
    // CHARACTERISATION, AND THE PLACE WHERE CLAUSE (e) EARNS ITS KEEP. PR 1
    // recorded this corpus reporting three of the four short lines, and left
    // open the question mikkerlo raised in the third review on #370: are they
    // true positives, or does the predicate need a citation-run rule?
    //
    // Clause (e) answers it without a citation-run rule, and the distinction is
    // the whole point. Lines 7 and 10 go green because the next token is 49 and
    // 48 columns against a blockMax of 84 — no greedy wrapper could have pulled
    // it up, so the break was FORCED. That is arithmetic over two lengths; it
    // would hold identically if the next token were a German compound noun.
    //
    // Line 3 STAYS RED, at exactly 84-against-84: 63 columns, a joining space
    // and a 20-column `(`Room.setPosition`)` fit the block maximum precisely, so
    // that break was CHOSEN. A citation-run rule would have pardoned all three,
    // because all three are citation runs. Clause (e) pardons two, because only
    // two were forced — and the one it refuses is the one the amnesty would have
    // been wrong about.
    const r = run({ 'docs/testing.md': CITATION_RUN })

    expect.soft(r.hits.map((h) => [h.line, h.len, h.blockMax])).toEqual([[3, 63, 84]])
    // The three that stay green, each for a DIFFERENT reason, named so a later
    // loosening cannot drop them silently: 7 and 10 by clause (e), 8 by clause
    // (d)'s trailing `;`, 11 by clause (b) being the block's last line.
    // Positive assertion, not a `not.toContain` on a list that could be empty
    // for the wrong reason — `hits` is pinned exactly above, so the line set is
    // already closed.
    expect.soft(linesOf(r)).toEqual([3])
  })

  // --- the report -------------------------------------------------------------

  it('reports the count, the files and the pin it was measured against', () => {
    const r = run({ 'docs/testing.md': RAGGED_BULLET })
    const { ok, out, err } = report(r, { ragged: 1 })

    expect.soft(ok).toBe(true)
    expect.soft(out.join('\n')).toContain('ragged lines: 1 in 1 file(s)')
    expect.soft(out.join('\n')).toContain('— pin 1')
    expect.soft(out.join('\n')).toContain('docs/testing.md:8')
    expect.soft(out.join('\n')).toContain('OK')
    // Nothing on the error channel when the count is at its pin. Not vacuous:
    // `ok` is asserted true above, so this is the green arm and an empty `err`
    // is the claim, not an accident of the failure arm being taken.
    expect.soft(err).toEqual([])
    // The default arm CI actually runs: no `pins` argument falls back to the
    // exported constant. A fallback pointing at some other number would print
    // the wrong pin here while every injected-pin case above stayed green.
    expect.soft(report(r).out.join('\n')).toContain(`— pin ${RAGGED_PIN}`)
  })

  it('reds when the ragged count drifts in either direction, not just upward', () => {
    // THE PIN, and it is exact-equality in both directions — the UNCHECKABLE_PIN
    // convention in scripts/check-line-citations.mjs, not SUSPICIOUS_LANDING_PIN.
    // A landing pin of 0 says "what you just added is a defect"; this one cannot
    // be 0, because the lines it counts are real, unrepaired, and not repairable
    // without reflowing docs/testing.md and renumbering the citation anchors the
    // sibling gate pins. So it bounds a known blindness instead.
    const r = run({ 'docs/testing.md': RAGGED_BULLET })
    expect.soft(r.hits).toHaveLength(1)

    // A ragged line ARRIVING reds, with the line named so the repair is
    // mechanical and the advice is one the author can act on.
    const rose = report(r, { ragged: 0 })
    expect.soft(rose.ok).toBe(false)
    expect.soft(rose.err.join('\n')).toContain('Ragged-line count rose: 1, pinned at 0.')
    expect.soft(rose.err.join('\n')).toContain('docs/testing.md:8  41/79')
    expect.soft(rose.err.join('\n')).toContain(REWRAP_ADVICE)
    // The rising arm must ALSO name the over-report class (#380 review): a line
    // no wrapper could break sets `blockMax` for its neighbours, and the
    // neighbours are then reported although they are wrapped correctly. Advice
    // to rewrap is wrong for them, so the arm that gives that advice has to say
    // what to check first, or it sends the author to reflow correct prose.
    expect.soft(rose.err.join('\n')).toContain('raises the bar for every neighbour')
    // And it must not send them to a list that does not exist: the RAGGED_PIN
    // comment carries a per-file split, not a line-by-line baseline.
    expect.soft(rose.err.join('\n')).toContain('per-file split')

    // And one LEAVING reds too, which is the half a one-sided pin would miss: a
    // pin left behind by a repair would otherwise quietly license a new ragged
    // line in the repaired one's place, and the printed number nobody diffs
    // would stay at the pin the whole time.
    const fell = report(r, { ragged: 2 })
    expect.soft(fell.ok).toBe(false)
    expect.soft(fell.err.join('\n')).toContain('Ragged-line count fell: 1, pinned at 2.')
    expect.soft(fell.err.join('\n')).toContain('lower the pin to match')
    // The one instruction the falling arm must NOT give. THE `not` IS PAIRED
    // WITH THE POSITIVE ABOVE ON PURPOSE, and that pairing is the whole of its
    // value: both read the same `REWRAP_ADVICE` constant, so a reworded or
    // mistyped instruction fails the rising arm's `toContain` instead of
    // silently satisfying this one. Before #380 this line held a literal the
    // rising arm no longer prints, which is the shape that cannot fail — a `not`
    // against a string nothing produces passes for the wrong reason, and
    // re-pointing it at the new wording without the twin would have left it
    // exactly as hollow.
    expect.soft(fell.err.join('\n')).not.toContain(REWRAP_ADVICE)
  })

  it('reports the deficit it actually selected on, not the module default', () => {
    // `analyze()` honours a `deficit` argument and `raggedLines()` selects
    // against it, but the result carried no record of which one produced it and
    // `report()` had nothing to read but the module constant — so selecting at
    // 50 printed `deficit >= 20`. Latent today because nothing passes a
    // non-default deficit; it stops being latent in PR 2, where that sentence is
    // the human-readable claim sitting immediately next to the pin. Raised in
    // review on #374.
    const ragged = ['x'.repeat(100), 'a short line that just stops', 'the tail.', ''].join('\n')
    const r = analyze({
      files: ['docs/notes.md'],
      readLines: () => ragged.split('\n'),
      deficit: 50
    }) as Result

    expect(r.deficit).toBe(50)
    expect(linesOf(r)).toEqual([2])

    const text = report(r).out.join('\n')
    expect(text).toContain('deficit >= 50 columns')
    expect(text).not.toContain('deficit >= 20 columns')

    // And the default path, so the `?? DEFICIT` fallback stays honest.
    expect(report(run({ 'docs/notes.md': ragged })).out.join('\n')).toContain(
      'deficit >= 20 columns'
    )
  })
})

// --- #464: the `RAGGED_PIN` restatement in `docs/testing.md` -------------------
//
// `scripts/check-prose-shape.mjs:100` ("export const RAGGED_PIN = 8") is
// restated in prose at `docs/testing.md:935` ("The count is **pinned exactly**"),
// and until this block nothing compared the restatement with the constant. The
// restatement states NO figure, which is the only reason it has not rotted yet:
// there is nothing there to go stale. The exposure is the next edit that adds
// one — "pinned exactly at 8" — after which the page carries a hand-copied
// number that moves only when someone remembers. #459 did exactly that to
// `MARKED_PIN`'s figure on this same page — it raised the constant and left the
// prose behind — and #460 repaired it by hand, with a human reading the
// paragraph as the only thing that caught it.
//
// THE CLASS WAS LIVE IN THIS FILE, which is the argument for guarding a pin that
// states no figure at all: the header of this file carried a stale hand-copied
// census from #368 until #464, wrong in both its numerator and its denominator.
// It is repaired and reworded above, where it now names the population instead
// of counting it.
//
// SO THE GUARD IS MIRRORED, not a figure check — there is no figure to compare.
// The anchor must occur exactly once, and the pin's own value must not appear in
// the span it opens. A figure would naturally go in as "pinned exactly at 8",
// which breaks the literal and reds on the count, so adding one forces the
// choice between wiring it into a comparison and taking it back out. This is the
// treatment #461 gives the citation gate's two figureless pins, for the same
// reason, and the boundary logic below is that block's as merged.
//
// THE LOCATOR IS THE WHOLE DESIGN RISK, as it was there: a brittle one reds on
// unrelated prose edits and trains people to adjust the pattern instead of the
// number. This anchor is a bold span inside body text rather than a `- **`
// bullet heading, so it is shorter and less distinctive than #461's headings,
// and a rewrap splitting `**pinned\nexactly**` would red it. Taken as a literal
// anyway, which is #461's split rather than a fresh judgement: it loosens its
// two FIGURE headings to `\s+` because a rewrap there must not silence a live
// comparison, and keeps its two FIGURELESS headings as literals because there is
// no comparison to silence — the whole assertion is that the span states no
// value of its own, and a rewrap is then a page edit whose loud zero-match red
// is the correct outcome rather than a false alarm. (A pattern would locate the
// span just as well: `index` and `[0].length` do what `indexOf` and `.length`
// do. Nothing about the slice forces the choice; the precedent does.) The
// exactly-once assertion is what keeps that honest in the other direction — a
// reworded anchor reds instead of quietly matching nothing.
//
// There is no collision with the sibling gate's own pinned-exactly bullet, which
// the page spells `**Suspicious landings, pinned exactly.**` — no `**` precedes
// `pinned` there, so it does not contain this literal. Left to the exactly-once
// count against the real page rather than asserted separately: if that bullet is
// ever reworded INTO the literal, the count goes to 2 and reds, which is the
// only direction that matters. Measured, not assumed — see the note at the
// assertion below.
//
// MEASURED ON THE PAGE AS IT STANDS: from the anchor to the blank line that ends
// its paragraph is 17 lines and 1216 characters, and that span contains no bare
// integer at all. The issue's first draft claimed this guard fires today on
// `docs/testing.md:927` ("8 of the 14 were short only because") as "a certainty,
// not a risk". It does not: that sentence is in the PRECEDING paragraph, and the
// span runs forward from the anchor, so it never reaches back to it. That is
// case (b) below, and it is the case this guard exists for — a guard that
// scanned the section rather than the paragraph would red on the page as it
// stands, which is the misdiagnosis the bound prevents.
//
// Accepted blind spots, recorded rather than implied closed: a figure spelled as
// a word ("pinned exactly at eight") gets through, and the guard cannot tell a
// stale pin from a measurement that happens to equal it — hence the hedge in the
// failure message rather than a flat instruction to move the pin.

const TESTING_DOC = join(import.meta.dirname, '..', 'docs', 'testing.md')

type PinName = 'ragged'
type DocPins = Record<PinName, number>
type DocMismatch = { pin: PinName; why: string }

// A literal rather than a pattern, for the reason above. Shaped as a list of one
// so the next figureless restatement on this page arrives as an entry rather
// than as a rewrite — #461 carries two in exactly this shape.
const FIGURELESS_PINS: { pin: PinName; anchor: string }[] = [
  { pin: 'ragged', anchor: '**pinned exactly**' }
]

const countLiteral = (text: string, needle: string): number => text.split(needle).length - 1

// Pure, and local to this file on purpose: `RAGGED_PIN` is an `export const` in
// an ES module, so a test cannot make it disagree with the doc by reassignment.
// The real-tree case passes `readFileSync` plus the imported constant; the
// regression cases pass doctored text and frozen pins. The gate script is
// unchanged and exports nothing new for this.
const pinProseMismatches = (docText: string, pins: DocPins): DocMismatch[] => {
  const out: DocMismatch[] = []

  for (const { pin, anchor } of FIGURELESS_PINS) {
    const found = countLiteral(docText, anchor)
    if (found !== 1) {
      out.push({ pin, why: `anchor matched ${found} times, expected exactly 1` })
      continue
    }
    const start = docText.indexOf(anchor)
    const from = start + anchor.length
    // THE END BOUNDARY IS DELIBERATE, and it is #461's as merged rather than a
    // fresh attempt. Its first version bounded on the next `- **` alone, which
    // bounds nothing: `indexOf` searches the whole remainder of the document, so
    // the slice runs to the end of the file whenever no further bullet follows —
    // and on this page nothing follows the anchor's paragraph as a top-level
    // bullet at all, so that version would take the span from 1216 characters to
    // 7684, across two headings and every paragraph under them. Measured: that
    // over-reach reaches no bare 8 on the page as it stands, which is the worse
    // half of the problem rather than a reprieve — it means the real-tree case
    // below cannot catch it, and a smaller pin collides far more easily than
    // this one does. The doctored cases are what carry it.
    //
    // So bound at the FIRST of the next bullet, the next blank line and the next
    // heading. On the real page the blank line is what fires. That leaves the -1
    // branch below as defence rather than as the mechanism: all three absent
    // means the page is not shaped the way this guard was written against — a
    // lazy continuation of the paragraph, or the end of the file — so it is
    // reported instead of guessed at.
    const ends = [
      docText.indexOf('\n- **', from),
      docText.indexOf('\n\n', from),
      docText.indexOf('\n#', from)
    ].filter((at) => at !== -1)
    if (ends.length === 0) {
      out.push({
        pin,
        why: 'span has no following bullet, blank line or heading, so its body is unbounded'
      })
      continue
    }
    const body = docText.slice(start, Math.min(...ends))
    // Keyed on the pin's OWN value rather than on digits in general, which is
    // #461's revision and matters here too: this page measures its own
    // population in prose, and the paragraph one blank line up spells a
    // measurement that happens to equal the pin. The lookbehind drops `#NNN`
    // issue references and `:NNN` anchors, and `\b` drops a longer run the digit
    // merely starts.
    if (new RegExp(String.raw`(?<![#:\d])\b${pins[pin]}\b`).test(body)) {
      // HEDGED ON PURPOSE, following #461's merged message. The span is 1216
      // characters of prose about how a pinned count is allowed to move, and it
      // is clean today only because it spells no number at all; write one of its
      // quantities as a digit and this fires on a measurement. A message that
      // only said "move the pin" would then be telling the next reader to do
      // precisely the wrong thing.
      out.push({
        pin,
        why:
          `span body contains ${pins[pin]}, this pin's own value — if that is the pin, ` +
          `nothing compares it, so wire a figure check in or take it back out; if it is a ` +
          `measurement that happens to equal the pin, spell it as a word so the two stay apart`
      })
    }
  }

  return out
}

// The number the doctored fixtures below state in their own prose. FROZEN
// deliberately: a regression case has to keep reproducing this failure after the
// next pin move, so it compares a fixture against a fixture pin and never
// against the live constant. It equals `RAGGED_PIN` today, which is exactly why
// it is written out — read the constant here instead and a pin move silently
// retunes every case below, including (b), whose preceding paragraph is a
// verbatim copy of a page that says 8 because the pin is 8.
const FIXTURE_PINS: DocPins = { ragged: 8 }

// Three paragraphs in the page's own order and shape, each replaceable: the
// preceding one, which legitimately states a measurement equal to the pin; the
// one the anchor opens; and a tail past the blank line. Every string here is
// kept free of citation shapes — and unlike #461's fixtures this is not a
// stylistic choice: that file sits in the citation gate's `EXCLUDED_PATHS` and
// this one does not, so a `path:NNN` or bare `:NNN` here is a live anchor
// against pins that are flush.
const docFixture = (over: { preceding?: string; span?: string; tail?: string } = {}): string =>
  [
    // Copied from the paragraph above the anchor on the real page, digit and
    // all. This is what makes case (b) a reproduction rather than an invention.
    over.preceding ??
      [
        '**(e) is what keeps the rest honest, and it arrived after the population was',
        'measured.** The first run reported 14 lines and claimed no false positives.',
        'Asking _why_ each line was short showed that 8 of the 14 were short only because',
        'the next thing in the paragraph was an unbreakable backticked path.'
      ].join('\n'),
    '',
    over.span ??
      [
        'The count is **pinned exactly**, following `UNCHECKABLE_PIN` rather than',
        '`SUSPICIOUS_LANDING_PIN`, and the choice is about the instruction the pin',
        'carries to whoever next reds it. Every line under this one is a real defect',
        'left unrepaired, so it moves one way only: down.',
        '**Never re-pin to clear a red.** A number moved to match whatever the tree',
        'happens to say measures nothing at all.'
      ].join('\n'),
    '',
    // A sentinel tail: it says 8 past the blank line, so a slice that runs to
    // the end of the document reds the clean case below instead of passing.
    over.tail ??
      [
        'A later paragraph that mentions 8 for its own reasons, well past the blank',
        'line that ends the span.'
      ].join('\n')
  ].join('\n')

describe('the RAGGED_PIN restatement docs/testing.md carries', () => {
  it('finds no figure in the span the real page opens at the anchor', () => {
    const doc = readFileSync(TESTING_DOC, 'utf8')

    // A renamed export would arrive here as `undefined`, which makes the
    // value-not-in-body regex `\bundefined\b` and the whole guard vacuous
    // instead of red. Stated rather than trusted.
    expect(Number.isInteger(RAGGED_PIN)).toBe(true)

    expect(pinProseMismatches(doc, { ragged: RAGGED_PIN })).toEqual([])

    // The exactly-once property, stated directly as well as enforced through the
    // helper, because it is what keeps the locator honest in the other
    // direction: an anchor that stops matching must red, not pass vacuously.
    //
    // THIS IS ALSO WHAT COVERS THE NEAR-COLLISION, and it is the only assertion
    // that needs to. The sibling gate's `**Suspicious landings, pinned
    // exactly.**` bullet is on this page and does not contain the literal, so it
    // does not count here; reword it INTO the literal and this goes to 2 and
    // reds. Measured both ways: with that bullet reworded to contain the
    // literal, the helper reports `anchor matched 2 times`. Nothing asserts that
    // bullet's own wording from here — the other direction (a reword that does
    // not create the literal) is that bullet's own business, it is pinned in
    // test/check-line-citations.test.ts, which owns it, and an assertion here
    // would only red on the page edits this guard has no opinion about.
    for (const { anchor } of FIGURELESS_PINS) {
      expect(countLiteral(doc, anchor)).toBe(1)
    }
  })

  it('reds when the span states the pin value, and ignores the paragraph above it', () => {
    // (a) THE EXPOSURE, in the shape it would arrive in: a figure written into
    // the span body, where nothing compares it with the constant.
    const stated = docFixture({
      span: [
        'The count is **pinned exactly**, following `UNCHECKABLE_PIN` rather than',
        '`SUSPICIOUS_LANDING_PIN`. The pin is 8 on this tree.'
      ].join('\n')
    })
    expect(pinProseMismatches(stated, FIXTURE_PINS)).toEqual([
      {
        pin: 'ragged',
        why:
          "span body contains 8, this pin's own value — if that is the pin, nothing compares " +
          'it, so wire a figure check in or take it back out; if it is a measurement that ' +
          'happens to equal the pin, spell it as a word so the two stay apart'
      }
    ])

    // (b) THE CASE THIS GUARD EXISTS FOR. The default fixture's preceding
    // paragraph is the real page's, digit and all: it says "8 of the 14" one
    // blank line above the anchor, and that is a legitimate measurement, not the
    // pin. A guard that scanned the section rather than the paragraph would red
    // here — and on the real page — so this clean result is the property under
    // test, not an absence of one.
    expect(docFixture()).toContain('8 of the 14')
    expect(pinProseMismatches(docFixture(), FIXTURE_PINS)).toEqual([])

    // The tail carries the other half: a bare 8 past the blank line, which a
    // slice that ran to the end of the document would reach. Both digits are in
    // the fixture and neither is in the span.
    expect(docFixture()).toContain('mentions 8 for its own reasons')
  })

  it('reds on a reworded or duplicated anchor rather than matching nothing', () => {
    // (c) A ZERO-MATCH PASS IS THE FAILURE MODE THIS GUARD HAS, and the figure
    // arrives in the wording that breaks the literal: "pinned exactly at 8"
    // leaves `**pinned exactly**` unmatched, so without the count assertion the
    // comparison would go silent at the exact moment it acquired something to
    // compare.
    const withFigure = docFixture({
      span: [
        'The count is **pinned exactly at 8**, following `UNCHECKABLE_PIN` rather',
        'than `SUSPICIOUS_LANDING_PIN`.'
      ].join('\n')
    })
    expect(pinProseMismatches(withFigure, FIXTURE_PINS)).toEqual([
      { pin: 'ragged', why: 'anchor matched 0 times, expected exactly 1' }
    ])

    // An ordinary rewording reds the same way. Loud, and the message says what
    // happened rather than reporting a clean page.
    const reworded = docFixture({
      span: 'The count is pinned to an exact figure, following `UNCHECKABLE_PIN`.'
    })
    expect(pinProseMismatches(reworded, FIXTURE_PINS)).toEqual([
      { pin: 'ragged', why: 'anchor matched 0 times, expected exactly 1' }
    ])

    // Both directions, not just the zero one: weakening `found !== 1` to
    // `found < 1` has to red here. Duplicated, the body slice would take
    // whichever copy came first and the other would go unguarded.
    const twice = docFixture({
      span: [
        'The count is **pinned exactly**, following `UNCHECKABLE_PIN`.',
        'Restated in a later summary: the count is **pinned exactly**.'
      ].join('\n')
    })
    expect(pinProseMismatches(twice, FIXTURE_PINS)).toEqual([
      { pin: 'ragged', why: 'anchor matched 2 times, expected exactly 1' }
    ])
  })

  it('ends the span at the next blank line, bullet or heading, whichever comes first', () => {
    // A bullet list immediately below the anchor's sentence bounds it just as a
    // blank line does. Not the arm the real page takes — nothing follows that
    // paragraph as a top-level bullet — but it is the arm #461's first version
    // relied on alone, and the only one of the three that can fire with no
    // whitespace in front of it.
    const bulleted = [
      'The count is **pinned exactly**, following `UNCHECKABLE_PIN`.',
      '- **A bullet immediately below.** It says 8, outside the span.',
      '',
      'And a paragraph that says 8 as well.'
    ].join('\n')
    expect(pinProseMismatches(bulleted, FIXTURE_PINS)).toEqual([])

    // Same for a heading hard against the sentence.
    const headed = [
      'The count is **pinned exactly**, following `UNCHECKABLE_PIN`.',
      '## What it does not police',
      '',
      'A section that says 8 well below the span.'
    ].join('\n')
    expect(pinProseMismatches(headed, FIXTURE_PINS)).toEqual([])

    // DEFENCE, not the mechanism: with no following bullet, blank line or
    // heading, the span's extent is whatever the rest of the file is — a lazy
    // continuation line here, which markdown folds into the paragraph and this
    // helper will not guess about.
    const unbounded = [
      'A preceding paragraph.',
      '',
      'The count is **pinned exactly**, following `UNCHECKABLE_PIN`.',
      'A lazy continuation line, with no blank line before it, that says 8.'
    ].join('\n')
    expect(pinProseMismatches(unbounded, FIXTURE_PINS)).toEqual([
      {
        pin: 'ragged',
        why: 'span has no following bullet, blank line or heading, so its body is unbounded'
      }
    ])
  })

  it('ignores an issue reference and a longer run the pin merely starts', () => {
    // The keying, in the two arms this file can demonstrate. The lookbehind's
    // third arm — a pathless anchor, spelled as a colon against the pin with no
    // path in front of it — is NOT reproduced here, and measured rather than
    // feared: the first draft of this comment spelled one out in backticks and
    // took the sibling gate's uncheckable count from 116 to 117 against a pin
    // that is exact. This file is outside that gate's `EXCLUDED_PATHS`, so it
    // cannot write the shape it wants to talk about; #461's fixtures cover that
    // arm from inside the excluded file.
    const noise = [
      'The count is **pinned exactly**, following `UNCHECKABLE_PIN`: #8 took it the',
      'other way, the widest block is 88 columns and one paragraph runs to 8572.'
    ].join('\n')
    expect(pinProseMismatches(docFixture({ span: noise }), FIXTURE_PINS)).toEqual([])

    // And the same span with a bare 8 in it does red, so the clean result above
    // is a property of the keying rather than of a guard that never fires.
    expect(
      pinProseMismatches(docFixture({ span: `${noise} The pin is 8.` }), FIXTURE_PINS)
    ).toEqual([
      {
        pin: 'ragged',
        why:
          "span body contains 8, this pin's own value — if that is the pin, nothing compares " +
          'it, so wire a figure check in or take it back out; if it is a measurement that ' +
          'happens to equal the pin, spell it as a word so the two stay apart'
      }
    ])
  })
})
