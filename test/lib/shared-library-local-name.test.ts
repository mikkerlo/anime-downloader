// Safe local names for episodes copied from a Shared Library (#579). The
// library is untrusted: a title of `..` must never put a file outside the
// download root, and nothing with a control character or NUL is created.
import { describe, expect, it } from 'vitest'
import * as path from 'path'
import { sanitizeFilename } from '../../src/main/download-manager'
import {
  assertInsideRoot,
  buildLocalEpisodePath,
  type LocalEpisodeName
} from '../../src/main/lib/shared-library/local-name'

const ROOT = path.resolve('/data/hot')

const name = (over: Partial<LocalEpisodeName> = {}): LocalEpisodeName => ({
  animeId: 101,
  translationId: 9001,
  title: 'Sousou no Frieren',
  episodeInt: '1',
  author: 'Crunchyroll',
  ext: '.mkv',
  ...over
})

/** The episode filename the download folder's naming builds. */
const localFile = (n: LocalEpisodeName): string =>
  `${sanitizeFilename(`${n.title} - ${n.episodeInt.padStart(2, '0')}`)} [${sanitizeFilename(n.author)}]${n.ext}`

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

describe('buildLocalEpisodePath', () => {
  it('builds the download folder’s name under the root', () => {
    const r = buildLocalEpisodePath(ROOT, name({ author: 'Crunchyroll [Chinese]', ext: '.ass' }))
    expect(r).toEqual({
      ok: true,
      path: path.join(
        ROOT,
        'Sousou no Frieren',
        'Sousou no Frieren - 01 [Crunchyroll [Chinese]].ass'
      ),
      dirName: 'Sousou no Frieren',
      fileName: 'Sousou no Frieren - 01 [Crunchyroll [Chinese]].ass'
    })
  })

  it('keeps names that only look odd: a trailing dot, a reserved device name, a 12.5', () => {
    for (const over of [{ title: 'Show.' }, { title: 'CON' }, { episodeInt: '12.5' }]) {
      expect(buildLocalEpisodePath(ROOT, name(over)).ok, JSON.stringify(over)).toBe(true)
    }
  })

  // On main there is no such check: the plain `path.join(root,
  // sanitizeFilename(title), …)` takes every one of these, and `..` lands
  // outside the root (`../<file>`).
  const TABLE: [string, Partial<LocalEpisodeName>][] = [
    ['title .', { title: '.' }],
    ['title ..', { title: '..' }],
    ['title ...', { title: '...' }],
    ['title " .. "', { title: ' .. ' }],
    ['title .. + NUL', { title: '..\u0000' }],
    ['title a NUL b', { title: 'a\u0000b' }],
    ['title a BEL b', { title: 'a\u0007b' }],
    ['title a DEL b', { title: 'a\u007fb' }],
    ['author a NUL b', { author: 'a\u0000b' }],
    ['episodeInt with a control character', { episodeInt: '1\u001f' }],
    ['empty title', { title: '' }],
    ['episodeInt ../1', { episodeInt: '../1' }],
    ['episodeInt 1/2', { episodeInt: '1/2' }],
    ['ext outside the allowlist', { ext: '.exe' }],
    ['ext without the dot', { ext: 'mkv' }],
    ['animeId 0', { animeId: 0 }],
    ['translationId -1', { translationId: -1 }],
    ['animeId 1.5', { animeId: 1.5 }]
  ]
  it.each(TABLE)('rejects %s', (_label, over) => {
    const r = buildLocalEpisodePath(ROOT, name(over))
    expect(r.ok).toBe(false)
  })

  it('a title of .. never resolves outside the root (the naive join does)', () => {
    const naive = path.join(ROOT, sanitizeFilename('..'), localFile(name({ title: '..' })))
    expect(path.relative(ROOT, naive).startsWith('..')).toBe(true)
    const r = buildLocalEpisodePath(ROOT, name({ title: '..' }))
    expect(r.ok && path.relative(ROOT, r.path).startsWith('..')).toBe(false)
    expect(r.ok).toBe(false)
  })
})

/** mulberry32: a seeded PRNG, so a failing case reproduces. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = [
  '.',
  '/',
  '\\',
  '\u0000',
  '\u0001',
  '\u001f',
  '\u007f',
  ' ',
  ':',
  '*',
  '?',
  'a',
  'Я',
  // RIGHT-TO-LEFT OVERRIDE, DIVISION SLASH, FULLWIDTH FULL STOP
  String.fromCharCode(0x202e),
  String.fromCharCode(0x2215),
  String.fromCharCode(0xff0e)
]
const EDGE = ['.', '..', '...', ' . ', ' .. ', '']
const SEED = 0x579
const CASES = 5000

describe('the fuzz: rejected, or exactly root/<one non-dot component>/<file>', () => {
  const rand = mulberry32(SEED)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
  const randomString = (): string => {
    const len = Math.floor(rand() * 17)
    let s = ''
    for (let i = 0; i < len; i++) s += pick(ALPHABET)
    return s
  }
  // The alphabet has no digits, so a random episode number is always refused
  // by the grammar; half the cases take a valid one, so the title and author
  // rules are reached.
  const randomEpisode = (): string =>
    rand() < 0.5 ? randomString() : pick(['1', '7', '12', '12.5', '0100', '9999'])

  function check(n: LocalEpisodeName): void {
    const r = buildLocalEpisodePath(ROOT, n)
    if (!r.ok) return
    const segments = path.relative(ROOT, r.path).split(path.sep)
    const where = JSON.stringify(n)
    expect(segments, where).toHaveLength(2)
    const [dir, file] = segments
    expect(dir, where).not.toBe('')
    expect(dir, where).not.toBe('.')
    expect(dir, where).not.toBe('..')
    expect(/^[\s.]*$/.test(dir), where).toBe(false)
    expect(file, where).toBe(localFile(n))
    expect(CONTROL.test(dir) || CONTROL.test(file), where).toBe(false)
  }

  it('the fixed edge corpus first, as titles, authors and episode numbers', () => {
    for (const s of EDGE) {
      check(name({ title: s }))
      check(name({ author: s }))
      check(name({ episodeInt: s }))
    }
  })

  it(`${CASES} seeded cases (seed ${SEED})`, () => {
    let accepted = 0
    for (let i = 0; i < CASES; i++) {
      const n = name({
        title: randomString(),
        author: randomString(),
        episodeInt: randomEpisode(),
        ext: pick(['.mkv', '.mp4', '.ass', '.exe', ''])
      })
      if (buildLocalEpisodePath(ROOT, n).ok) accepted++
      check(n)
    }
    // Some cases get through, so the invariant above is exercised, not vacuous.
    expect(accepted).toBeGreaterThan(50)
  })
})

describe('assertInsideRoot, on its own (the backstop)', () => {
  it.each([
    ['root/../x', path.join(ROOT, '..', 'x')],
    ['root/..', path.join(ROOT, '..')],
    ['the root itself', ROOT],
    ['the root with a trailing separator', ROOT + path.sep],
    ['an absolute path elsewhere', path.resolve('/etc/passwd')],
    ['a sibling with a shared prefix', path.resolve('/data/hot2/x')]
  ])('refuses %s', (_label, dest) => {
    expect(() => assertInsideRoot(ROOT, dest)).toThrow()
  })

  it('accepts root/a/b', () => {
    expect(() => assertInsideRoot(ROOT, path.join(ROOT, 'a', 'b'))).not.toThrow()
  })
})
