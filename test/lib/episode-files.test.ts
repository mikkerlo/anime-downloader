// The pin for the episode-file extension sets and the episode-file type (#429).
//
// Three layers, because "enumerated in exactly one place" and "still means the
// same thing" are different claims:
//
//   1. A VALUE PIN on `src/shared/episode-files.ts` — a future container
//      addition reds here first, in a test that names itself, and the
//      compile-time lock below also forces the ambient `EpisodeArtifactExt`
//      union to move with the runtime list.
//   2. A SOURCE SCAN over `src/**` asserting that no second site enumerates
//      the set. This is the layer that reaches the six regex sites: a test
//      cannot import a regex literal sitting inside a `player.ipc.ts` handler,
//      but it can see that the literal is gone. Its detectors are themselves
//      checked against a corpus of the exact pre-#429 shapes, so a detector
//      that silently stopped matching anything would red rather than pass.
//   3. CHARACTERISATION of the derived regexes, with the case-sensitivity
//      differences first: those are the behaviour most at risk in an
//      extraction that shares the lists and deliberately does not share the
//      matching.
//
// `test/lib/` rather than `test/shared/`: there is no `test/shared/`, and the
// consumers pinned here (`episode-file-scan`, `filename`) live in `src/main/lib`.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import * as path from 'path'
import {
  VIDEO_EXTS,
  EPISODE_ARTIFACT_EXTS,
  VIDEO_EXT_ALTERNATION,
  EPISODE_ARTIFACT_EXT_ALTERNATION,
  VIDEO_EXT_RE,
  VIDEO_EXT_OR_PART_RE,
  extAlternation
} from '@shared/episode-files'
import {
  EPISODE_FILE_TAGGED_RE,
  EPISODE_FILE_LEGACY_RE,
  accumulateEpisodeFiles,
  type FileCheckResult
} from '../../src/main/lib/episode-file-scan'
import { FILENAME_EP_RE, parseEpisodeFromFilename } from '../../src/main/lib/filename'

const SRC_ROOT = path.resolve(__dirname, '../../src')

// ---------------------------------------------------------------------------
// 1. Value pin
// ---------------------------------------------------------------------------

describe('episode-file extension sets', () => {
  it('pins the two sets — a new container is added HERE and nowhere else', () => {
    expect(VIDEO_EXTS).toEqual(['.mkv', '.mp4'])
    expect(EPISODE_ARTIFACT_EXTS).toEqual(['.mkv', '.mp4', '.ass'])
    // The artifact set is the video set plus the subtitle sidecar, in that
    // order — `EPISODE_ARTIFACT_EXT_ALTERNATION` is spliced into a regex, and
    // `moveEpisodeToColdStorage` builds its `wanted` name set by iterating it.
    expect(EPISODE_ARTIFACT_EXTS.slice(0, VIDEO_EXTS.length)).toEqual([...VIDEO_EXTS])
  })

  it('derives the alternations by stripping the leading dot', () => {
    // The constants carry dots because they feed `endsWith`; a regex needs the
    // bare form inside `\.(…)$`.
    expect(VIDEO_EXT_ALTERNATION).toBe('mkv|mp4')
    expect(EPISODE_ARTIFACT_EXT_ALTERNATION).toBe('mkv|mp4|ass')
    expect(extAlternation(['.a', 'b', '.c'])).toBe('a|b|c')
    expect(extAlternation([])).toBe('')
  })

  it('locks the ambient `EpisodeArtifactExt` union to the runtime list', () => {
    // A `.d.ts` cannot import, so `EpisodeArtifactExt` cannot be derived from
    // `EPISODE_ARTIFACT_EXTS`. This is the compile-time stand-in: adding
    // `'.webm'` to the list without adding `'webm'` to the union (or vice
    // versa) fails `npm run typecheck`, not just this assertion.
    type StripDot<T extends string> = T extends `.${infer R}` ? R : never
    type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    const unionMatchesList: Eq<
      StripDot<(typeof EPISODE_ARTIFACT_EXTS)[number]>,
      EpisodeArtifactExt
    > = true
    const videoUnionMatchesList: Eq<StripDot<(typeof VIDEO_EXTS)[number]>, EpisodeFileType> = true
    expect(unionMatchesList).toBe(true)
    expect(videoUnionMatchesList).toBe(true)
  })

  it("keeps sumShowFiles' cleanup set a superset of the artifact set", () => {
    // `sumShowFiles` is the deliberate holdout (#429): it also counts `.srt`,
    // because it measures what `CLEANUP_EXECUTE`'s recursive directory removal
    // reclaims rather than what the downloader wrote. It is private to
    // `src/main/index.ts` and reaches `cleanup.ipc.ts` only through `AppDeps`,
    // so it is asserted from source rather than called — the point is that a
    // future container cannot land in the delete lists and leave the cleanup
    // estimate behind.
    const src = readFileSync(path.join(SRC_ROOT, 'main/index.ts'), 'utf8')
    const start = src.indexOf('async function sumShowFiles(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}\n', start))
    const cleanupSet = [...body.matchAll(/endsWith\('(\.[a-z0-9]+)'\)/g)].map((m) => m[1])
    expect(cleanupSet).toEqual(['.mkv', '.mp4', '.ass', '.srt'])
    for (const ext of EPISODE_ARTIFACT_EXTS) expect(cleanupSet).toContain(ext)
  })
})

// ---------------------------------------------------------------------------
// 2. Source scan — "enumerated in exactly one place"
// ---------------------------------------------------------------------------

const EXT_ALT = ['mkv', 'mp4', 'ass', 'srt'].join('|')

/**
 * The three shapes the 15 pre-#429 enumeration sites actually used, plus the
 * episode-file type literal. Each is checked against a corpus below, so a
 * detector cannot rot into one that matches nothing and passes.
 */
const DETECTORS: Record<string, RegExp> = {
  // `(mkv|mp4)`, `(mp4|mkv)`, `(mkv|mp4|ass)` — the six regex sites.
  alternation: new RegExp(`\\((?:${EXT_ALT})(?:\\|(?:${EXT_ALT}))+\\)`),
  // `['.mkv', '.mp4']`, `['.mkv', '.mp4', '.ass']`.
  arrayLiteral: new RegExp(`\\[\\s*'\\.(?:${EXT_ALT})'(?:\\s*,\\s*'\\.(?:${EXT_ALT})')+\\s*\\]`),
  // `f.endsWith('.mkv') || f.endsWith('.mp4')`, across line breaks.
  endsWithChain: new RegExp(
    `endsWith\\('\\.(?:${EXT_ALT})'\\)[\\s\\S]{0,200}?\\|\\|[\\s\\S]{0,200}?endsWith\\('\\.(?:${EXT_ALT})'\\)`
  ),
  // The 11-times-repeated episode-file shape.
  typeLiteral: /\{\s*type:\s*'mkv'\s*\|\s*'mp4'/
}

/**
 * The enumerations that are allowed to survive, each for a stated reason.
 * Anything else in `src/**` is a re-inlined set.
 */
const ALLOWED: Record<string, string[]> = {
  // The single source of truth.
  'shared/episode-files.ts': ['arrayLiteral'],
  // `sumShowFiles` — the 4-element cleanup set, out of scope by decision and
  // covered by the superset assertion above.
  'main/index.ts': ['endsWithChain']
}

/** Drop whole-line comments so documentation of a shape is not read as a use. */
function stripCommentLines(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const t = line.trimStart()
      const isComment =
        t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')
      return isComment ? '' : line
    })
    .join('\n')
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(p, out)
    else if (/\.(ts|vue)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe('episode-file set duplication guard', () => {
  it('detects every shape the pre-#429 sites used', () => {
    // Mutation control. These are verbatim excerpts of the code this issue
    // replaced; if a detector stops matching its own corpus it is no longer
    // guarding anything, and the scan below would go green for the wrong
    // reason.
    const corpus = {
      alternation: [
        "filePath.replace(/\\.(mp4|mkv)(\\.part)?$/i, '.ass')",
        "fp.replace(/\\.(mp4|mkv)$/i, '.ass')",
        'file.match(/^(.+?) \\[(.+?)\\]\\.(mkv|mp4)$/)',
        'file.match(/^(.+)\\.(mkv|mp4)$/)',
        '/\\s-\\s(\\d{1,4})\\.(mkv|mp4|ass)$/i'
      ],
      arrayLiteral: [
        "for (const ext of ['.mkv', '.mp4']) {",
        "for (const ext of ['.mkv', '.mp4', '.ass']) {",
        "if (!['.mkv', '.mp4', '.ass'].some((ext) => file.endsWith(ext))) continue"
      ],
      endsWithChain: [
        "files.some((f) => f.endsWith('.mkv') || f.endsWith('.mp4'))",
        "(file.endsWith('.mkv') || file.endsWith('.mp4') || file.endsWith('.ass'))",
        "        lower.endsWith('.mkv') ||\n        lower.endsWith('.mp4') ||"
      ],
      typeLiteral: [
        "{ type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]",
        "type FileEntry = {\n  type: 'mkv' | 'mp4'\n  filePath: string\n}"
      ]
    }
    for (const [name, samples] of Object.entries(corpus)) {
      for (const sample of samples) {
        expect(DETECTORS[name].test(sample), `${name} must match: ${sample}`).toBe(true)
      }
    }
    // And must not fire on a single-container predicate, which is a different
    // question — `.mkv`-only player branches, the `.mp4` `.part` shadow guards,
    // the mp4-stats probe gate. Those are correctly outside the set.
    for (const re of Object.values(DETECTORS)) {
      expect(re.test("if (fp.toLowerCase().endsWith('.mp4')) {")).toBe(false)
      expect(re.test("filePath.toLowerCase().endsWith('.mkv')")).toBe(false)
      expect(re.test("file.endsWith('.mp4') && files.includes(file + '.part')")).toBe(false)
      expect(re.test("group.video.filename.replace(/\\.mp4$/, '.mkv')")).toBe(false)
    }
  })

  it('finds no extension-set enumeration outside the shared module', () => {
    const found: Record<string, string[]> = {}
    for (const file of sourceFiles(SRC_ROOT)) {
      const src = stripCommentLines(readFileSync(file, 'utf8'))
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/')
      for (const [name, re] of Object.entries(DETECTORS)) {
        if (!re.test(src)) continue
        if (ALLOWED[rel]?.includes(name)) continue
        ;(found[rel] ??= []).push(name)
      }
    }
    // Every entry here is a site that re-enumerates a set `@shared/episode-files`
    // already names, or re-declares `EpisodeFileEntry`. Point it at the
    // constant / the ambient global instead of widening this allow-list.
    expect(found).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// 3. Characterisation of the derived regexes
// ---------------------------------------------------------------------------

describe('derived regex characterisation', () => {
  it('keeps the player sidecar regexes case-INSENSITIVE', () => {
    // `/i` at all three `player.ipc.ts` sites. This is the half of the
    // behaviour the shared *lists* must not quietly unify with cold-storage's.
    expect('Show - 01.MP4'.replace(VIDEO_EXT_RE, '.ass')).toBe('Show - 01.ass')
    expect('Show - 01.MKV'.replace(VIDEO_EXT_RE, '.ass')).toBe('Show - 01.ass')
    expect('Show - 01.MkV'.replace(VIDEO_EXT_RE, '.ass')).toBe('Show - 01.ass')
    expect('Show - 01.MP4.PART'.replace(VIDEO_EXT_OR_PART_RE, '.ass')).toBe('Show - 01.ass')
  })

  it('matches only a trailing container, and only these containers', () => {
    expect(VIDEO_EXT_RE.test('a.mkv')).toBe(true)
    expect(VIDEO_EXT_RE.test('a.mp4')).toBe(true)
    expect(VIDEO_EXT_RE.test('a.ass')).toBe(false)
    expect(VIDEO_EXT_RE.test('a.srt')).toBe(false)
    expect(VIDEO_EXT_RE.test('a.webm')).toBe(false)
    expect(VIDEO_EXT_RE.test('a.mkv.part')).toBe(false)
    expect(VIDEO_EXT_RE.test('a.mp4.b')).toBe(false)
    // The dot is required — `amp4` is not a match.
    expect(VIDEO_EXT_RE.test('amp4')).toBe(false)
  })

  it('accepts a growing `.part` only at the OR_PART site', () => {
    // Only `PLAYER_GET_LOCAL_SUBTITLES` tolerates `.part` (#63); the resolver
    // regex does not, and that asymmetry predates the extraction.
    expect(VIDEO_EXT_OR_PART_RE.test('a.mp4.part')).toBe(true)
    expect(VIDEO_EXT_OR_PART_RE.test('a.mkv.part')).toBe(true)
    expect(VIDEO_EXT_OR_PART_RE.test('a.mp4')).toBe(true)
    expect(VIDEO_EXT_OR_PART_RE.test('a.part')).toBe(false)
    expect(VIDEO_EXT_OR_PART_RE.test('a.ass.part')).toBe(false)
    // Unrecognized extension leaves the path untouched, which is what the
    // handler's `assPath === filePath` early return keys off.
    expect('a.avi'.replace(VIDEO_EXT_OR_PART_RE, '.ass')).toBe('a.avi')
  })

  it('carries no `g` flag, so sharing one object across call sites is safe', () => {
    // Three handlers reuse `VIDEO_EXT_RE`; a global regex would carry
    // `lastIndex` between them.
    for (const re of [VIDEO_EXT_RE, VIDEO_EXT_OR_PART_RE, FILENAME_EP_RE]) {
      expect(re.global).toBe(false)
    }
    expect(VIDEO_EXT_RE.test('a.mkv')).toBe(true)
    expect(VIDEO_EXT_RE.test('a.mkv')).toBe(true)
  })

  it('keeps the scanner regexes case-SENSITIVE', () => {
    // `episode-file-scan.ts` has always been case-sensitive, unlike the player
    // sites. Upper-case names are invisible to the scanner, and stay so.
    expect(EPISODE_FILE_TAGGED_RE.test('Show - 01 [Sub].mkv')).toBe(true)
    expect(EPISODE_FILE_TAGGED_RE.test('Show - 01 [Sub].MKV')).toBe(false)
    expect(EPISODE_FILE_LEGACY_RE.test('Show - 01.mp4')).toBe(true)
    expect(EPISODE_FILE_LEGACY_RE.test('Show - 01.MP4')).toBe(false)
    expect(EPISODE_FILE_TAGGED_RE.flags).toBe('')
    expect(EPISODE_FILE_LEGACY_RE.flags).toBe('')
    // `.ass` is not a video: the producer must not start reporting sidecars.
    expect(EPISODE_FILE_LEGACY_RE.test('Show - 01.ass')).toBe(false)
    expect(EPISODE_FILE_TAGGED_RE.test('Show - 01 [Sub].ass')).toBe(false)
  })

  it('keeps the scanner capture groups in the same positions', () => {
    // The tagged regex is base/author/ext and the legacy one base/ext;
    // `accumulateEpisodeFiles` indexes them positionally.
    expect('Show - 01 [Sub].mkv'.match(EPISODE_FILE_TAGGED_RE)?.slice(1)).toEqual([
      'Show - 01',
      'Sub',
      'mkv'
    ])
    expect('Show - 01.mp4'.match(EPISODE_FILE_LEGACY_RE)?.slice(1)).toEqual(['Show - 01', 'mp4'])
    // Behavioural, through the producer the IPC payload comes from.
    const result: FileCheckResult = {}
    accumulateEpisodeFiles(result, '/d', [
      'Show - 01 [Sub].mkv',
      'Show - 02.mp4',
      'Show - 03.MKV',
      'Show - 04.ass',
      'Show - 05.mp4.part'
    ])
    expect(Object.keys(result).sort()).toEqual(['Show - 01', 'Show - 02'])
    expect(result['Show - 01'][0]).toEqual({
      type: 'mkv',
      filePath: path.join('/d', 'Show - 01 [Sub].mkv'),
      author: 'Sub'
    })
    expect(result['Show - 02'][0].type).toBe('mp4')
  })

  it('keeps `FILENAME_EP_RE` case-INSENSITIVE over all three artifact exts', () => {
    expect(FILENAME_EP_RE.flags).toBe('i')
    for (const ext of ['mkv', 'MKV', 'mp4', 'MP4', 'ass', 'ASS']) {
      expect(parseEpisodeFromFilename(`Show - 07.${ext}`)).toEqual({
        episodeInt: '7',
        ext: ext.toLowerCase()
      })
    }
    // `.part` is in the format comment above the regex but has never been in
    // the regex: an in-progress download has no parsed episode.
    expect(parseEpisodeFromFilename('Show - 07.mp4.part')).toBeNull()
    expect(parseEpisodeFromFilename('Show - 07.srt')).toBeNull()
    expect(parseEpisodeFromFilename('Show - 07.webm')).toBeNull()
  })
})
