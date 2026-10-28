// The Shared Library naming rule v1 (#573), Windows-safety included. This
// table moved here from S6b (#575), which now only consumes the rule.
import { describe, expect, it } from 'vitest'
import { sanitizeFilename } from '../../../src/main/download-manager'
import {
  COMPONENT_BUDGET,
  PATH_BUDGET,
  nameItem,
  nameItems,
  type NamingInput
} from '../../../src/main/lib/shared-library/naming'

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i

/** Whether Windows (NTFS, exFAT) takes `component` as a file or folder name verbatim. */
function windowsValid(component: string): boolean {
  if (component === '' || /^\.+$/.test(component)) return false
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(component)) return false
  if (/[. ]$/.test(component)) return false
  return !RESERVED.test(component.split('.')[0])
}

function assertFits(path: string): void {
  expect(path.length, path).toBeLessThanOrEqual(PATH_BUDGET)
  for (const c of path.split('/')) {
    expect(Buffer.byteLength(c, 'utf8'), c).toBeLessThanOrEqual(COMPONENT_BUDGET)
    expect(windowsValid(c), JSON.stringify(c)).toBe(true)
  }
}

const input = (over: Partial<NamingInput> = {}): NamingInput => ({
  animeId: 101,
  episodeInt: '1',
  translationId: 9001,
  title: 'Frieren',
  author: 'Crunchyroll',
  ext: '.mkv',
  ...over
})

/** The name `download-manager.ts`'s `enqueue` builds today. */
function downloadFolderName(i: NamingInput): string {
  const padded = i.episodeInt.padStart(2, '0')
  const animeDirName = sanitizeFilename(i.title)
  const authorTag = sanitizeFilename(i.author)
  const baseFilename = sanitizeFilename(`${i.title} - ${padded}`) + ` [${authorTag}]`
  return `${animeDirName}/${baseFilename}${i.ext}`
}

const T115 =
  'Sousou no Frieren: The Journey Beyond the End of an Era and the Mage Who Outlived Her Party, Season Two (2026) xyzw'
const A128 =
  'A'.repeat(54) + ' Fansub Collective International Translation Group With A Very Long Name!!'
const CYRILLIC_295 = 'Ж'.repeat(147) + 'x'

describe('the real worst cases from the review stay within budget and Windows-valid', () => {
  it('has inputs of the sizes the review named', () => {
    expect(T115).toHaveLength(115)
    expect(A128).toHaveLength(128)
    expect(Buffer.byteLength(CYRILLIC_295, 'utf8')).toBe(295)
  })

  it.each([
    ['a 115-character title with Crunchyroll', input({ title: T115 })],
    ['a 115-character title with the 128-character author', input({ title: T115, author: A128 })],
    ['the 295-byte Cyrillic author', input({ author: CYRILLIC_295 })],
    [
      'the 295-byte Cyrillic author with a 115-character title',
      input({ title: T115, author: CYRILLIC_295 })
    ]
  ])('%s', (_, i) => {
    const named = nameItem({ ...i, subtitle: true })
    assertFits(named.path)
    assertFits(named.subtitlePath!)
    expect(named.renamed).toBe(true)
    expect(named.path).toMatch(/~[0-9a-f]{6}/)
  })

  it('cuts only the title when that leaves enough of it', () => {
    const named = nameItem(input({ title: T115 }))
    expect(named.path).toContain('[Crunchyroll].mkv')
  })

  it('cuts only the author tag when the title isn’t the problem', () => {
    const named = nameItem(input({ author: CYRILLIC_295 }))
    expect(named.path.startsWith('Frieren/Frieren - 01 [')).toBe(true)
  })
})

describe('Windows-safety', () => {
  it.each([
    ['a trailing dot', 'Frieren...', 'Frieren'],
    ['a trailing space left by a dropped control character', 'Frieren \u0001', 'Frieren'],
    ['CON', 'CON', 'CON_'],
    ['nul.mkv', 'nul.mkv', 'nul_.mkv'],
    ['COM1', 'com1', 'com1_'],
    ['LPT¹', 'LPT¹', 'LPT¹_'],
    ['control characters', 'Fri\u0001er\u007fen', 'Frieren'],
    ['a title of ..', '..', '_']
  ])('%s', (_, title, dir) => {
    const named = nameItem(input({ title }))
    expect(named.path.split('/')[0]).toBe(dir)
    for (const c of named.path.split('/')) expect(windowsValid(c), JSON.stringify(c)).toBe(true)
    expect(named.renamed).toBe(true)
  })

  it('a cut that lands on a space leaves no trailing space or dot', () => {
    for (let pad = 0; pad < 12; pad++) {
      const title = `${'Long title word '.repeat(9)}${'x'.repeat(pad)}. .`
      const named = nameItem(input({ title, author: A128 }))
      assertFits(named.path)
    }
  })
})

describe('determinism and today’s names', () => {
  it('the same input always gives the same name', () => {
    for (const i of [input(), input({ title: T115, author: A128 }), input({ title: 'CON.' })]) {
      expect(nameItem(i)).toEqual(nameItem({ ...i }))
    }
  })

  it.each([
    input(),
    input({ episodeInt: '12.5' }),
    input({ episodeInt: '100', ext: '.mp4' }),
    input({ title: 'Провожающая в последний путь Фрирен', author: 'AniLibria.TV' }),
    input({ title: 'Re:Zero  kara?', author: 'Studio <Band>' }),
    input({ title: 'Kaguya-sama: Love Is War', author: 'Ancord & Jade' })
  ])('a Windows-valid name under budget is byte-identical to download-manager (%#)', (i) => {
    const named = nameItem(i)
    expect(named.path).toBe(downloadFolderName(i))
    expect(named.renamed).toBe(false)
  })

  it('the sidecar shares the video’s base name', () => {
    const named = nameItem(input({ subtitle: true }))
    expect(named.subtitlePath).toBe('Frieren/Frieren - 01 [Crunchyroll].ass')
  })
})

describe('case-insensitive collisions', () => {
  it('a title directory that collides only in case gets the hash suffix, the later one', () => {
    const [a, b] = nameItems([
      input({ animeId: 1, title: 'Frieren' }),
      input({ animeId: 2, title: 'FRIEREN' })
    ])
    expect(a.path).toBe('Frieren/Frieren - 01 [Crunchyroll].mkv')
    expect(a.renamed).toBe(false)
    expect(b.path).toMatch(/^FRIEREN~[0-9a-f]{6}\//)
    expect(b.renamed).toBe(true)
  })

  it('a file that collides only in case gets the hash suffix, the later one', () => {
    const [a, b] = nameItems([
      input({ translationId: 1, author: 'AniDub' }),
      input({ translationId: 2, author: 'anidub' })
    ])
    expect(a.renamed).toBe(false)
    expect(b.path.split('/')[0]).toBe('Frieren')
    expect(b.path).toMatch(/\[anidub\]~[0-9a-f]{6}\.mkv$/)
    expect(b.path.toUpperCase()).not.toBe(a.path.toUpperCase())
  })

  it('the same directory spelled the same way is shared, not a collision', () => {
    const named = nameItems([
      input({ episodeInt: '1' }),
      input({ episodeInt: '2', translationId: 2 })
    ])
    expect(named.map((n) => n.renamed)).toEqual([false, false])
  })
})
