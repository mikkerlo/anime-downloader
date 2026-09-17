// Fixtures for the prose-shape measurement (#370). Every case drives
// `analyze()` over a synthetic corpus rather than the real tree, for the reason
// test/check-line-citations.test.ts gives: the real tree's counts are the
// gate's own pin and move with every repair. Here that is not a general
// principle but a live constraint — docs/testing.md carries 13 of the 14 hits
// on this tree and is the file #366 and #369 both renumber, so an assertion
// written against a live line number is a test whose next rebase deletes it.
//
// The corpus lives INLINE, which is also why this file needs no `EXCLUDED_PATHS`
// entry: its ragged prose is a string handed to `analyze()`, never a file on
// disk, so the gate cannot scan its own test data and there is no path-shaped
// exclusion to keep in sync.
import { describe, it, expect } from 'vitest'

// @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig graph
import { analyze, classify, report } from '../scripts/check-prose-shape.mjs'

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
// line of its own. See the characterisation test at the bottom: two of the four
// red under the committed threshold, and that is reported rather than tuned away.
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

describe('check-prose-shape', () => {
  it('reds on the short line a rebase left inside a wrapped bullet', () => {
    // THE REGRESSION CASE. Line 8 is `shapes verbatim. The main→renderer half`:
    // 41 columns where its neighbours run to 79, ending mid-sentence on "half".
    // Nothing else in the bullet reds — the other sixteen lines are wrapped
    // within a few columns of each other, which is what makes the deficit rule
    // a signal here rather than a census of a hand-wrapped paragraph.
    const r = run({ 'docs/testing.md': RAGGED_BULLET })

    expect(linesOf(r)).toEqual([8])
    expect(r.hits[0]).toMatchObject({
      path: 'docs/testing.md',
      len: 41,
      blockMax: 79,
      text: 'shapes verbatim. The main→renderer half'
    })
    // Print-only in PR 1: it reports and exits 0. The pin that turns this into
    // a failure is PR 2, after the citation-anchor repairs stop moving the
    // number it would be pinned to.
    expect(report(r).ok).toBe(true)
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

    expect(linesOf(unterminated)).toEqual([3])
    expect(unterminated.hits[0]).toMatchObject({ len: 28, text: 'a short line that just stops' })

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
    expect(linesOf(fencedSample)).toEqual([3])
    expect(fencedSample.hits[0]).toMatchObject({
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
    expect(r.hits).toEqual([
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
    expect(kinds.slice(2, 5)).toEqual([
      { kind: 'skip', why: 'fenced code' },
      { kind: 'skip', why: 'fenced code' },
      { kind: 'skip', why: 'fenced code' }
    ])
    expect(kinds[5]).toEqual({ kind: 'skip', why: 'fence' })
    expect(kinds.slice(7, 10).map((k) => k.kind)).toEqual(['text', 'text', 'text'])
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
    // between them is scanned as prose: this corpus reports four hits, the raw
    // `jj` command lines. That is not hypothetical — five
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

    expect(r.scanned).toEqual(['DESIGN.md', 'docs/testing.md', 'src/shared/README.md'])
    expect(r.hits.map((h) => h.path)).toEqual([
      'DESIGN.md',
      'docs/testing.md',
      'src/shared/README.md'
    ])
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

  it('reds two lines of a hand-formatted citation run, which is an open question', () => {
    // CHARACTERISATION, NOT AN ENDORSEMENT. The issue's Testing Strategy asks
    // for a hand-formatted citation run as a GREEN class, naming this live
    // instance: four consecutive short lines, each deliberately broken so a
    // parenthetical citation sits on a line of its own.
    //
    // Under the committed threshold it is not green. Two of the four red — the
    // 61-column `Drives real …` line and the 55-column `two-peer harness below`
    // line — while the third escapes only through clause (d)'s trailing `;` and
    // the fourth only through clause (b), being the block's last line. That is
    // the contradiction mikkerlo raised in the third review on #370 (question 2:
    // are they true positives, or does the predicate get a citation-run rule?),
    // and it is a predicate-shape call reserved to the issue author: the Risks
    // section forbids settling it by adjusting the threshold once the count is
    // known.
    //
    // So this test records what the committed predicate does, exactly, rather
    // than asserting what the issue hoped it would do. If the answer is "true
    // positives", this stays and the citation-run green class is struck from the
    // issue. If the answer is a citation-run rule, this test is what has to
    // change, in the open, in the PR that changes the predicate.
    const r = run({ 'docs/testing.md': CITATION_RUN })

    expect(r.hits.map((h) => [h.line, h.len, h.blockMax])).toEqual([
      [3, 63, 84],
      [7, 61, 84],
      [10, 55, 84]
    ])
    // The two that stay green, named so a later loosening cannot drop them
    // silently: line 8 ends in `;` and line 11 is the block's last line.
    expect(linesOf(r)).not.toContain(8)
    expect(linesOf(r)).not.toContain(11)
  })

  // --- the report -------------------------------------------------------------

  it('always reports ok, because PR 1 is print-only', () => {
    // The whole point of shipping the measurement before the pin: a print-only
    // script renumbers nothing, so it does not queue behind the citation-anchor
    // repairs that are moving the very lines it would be pinned against. PR 2
    // adds the non-zero pin, following the UNCHECKABLE_PIN convention rather
    // than SUSPICIOUS_LANDING_PIN — the hits are real and unrepaired, so zero is
    // not available.
    const r = run({ 'docs/testing.md': RAGGED_BULLET })
    const { ok, out } = report(r)

    expect(ok).toBe(true)
    expect(out.join('\n')).toContain('ragged lines: 1 in 1 file(s)')
    expect(out.join('\n')).toContain('docs/testing.md:8')
    expect(out.join('\n')).toContain('PRINT-ONLY')
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
