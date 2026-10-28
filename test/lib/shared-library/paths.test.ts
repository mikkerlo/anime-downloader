// Paths in a Shared Library (#573): checked lexically on read, resolved with
// `realpath` at use; MAX_PATH reported; discovery; the escaped index.html.
import * as fs from 'fs'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverLibraries } from '../../../src/main/lib/shared-library/discover'
import { renderIndexHtml } from '../../../src/main/lib/shared-library/index-html'
import {
  absoluteOverflow,
  isPosterName,
  isSafeRelativePath,
  posterPath,
  resolveItem,
  resolveWriteTarget
} from '../../../src/main/lib/shared-library/paths'
import { readLibrary } from '../../../src/main/lib/shared-library/read'
import { cleanup, fixture, item, manifest, tempRoot, tree } from '../../helpers/shared-library'

afterEach(cleanup)

type Ok = Extract<SharedLibraryRead, { status: 'ok' }>

function touch(root: string, rel: string): string {
  const p = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'x')
  return p
}

describe('the lexical check', () => {
  it.each(['a.mkv', 'Frieren/Frieren - 01 [X].mkv', 'a/b/c.ass', '.hidden/x', 'x..y/z'])(
    'accepts %j',
    (p) => expect(isSafeRelativePath(p)).toBe(true)
  )
  it.each([
    '',
    '../x',
    'a/..',
    '/abs',
    'C:/x',
    'C:\\x',
    '\\\\srv\\s',
    'a\\b',
    'a\0b',
    './a',
    'a//b',
    'a/',
    '..',
    '...'
  ])('rejects %j', (p) => expect(isSafeRelativePath(p)).toBe(false))
  it('rejects a non-string', () => expect(isSafeRelativePath(42)).toBe(false))
})

describe('resolveItem: realpath at use', () => {
  it('the absolute path for a present file, missing for an absent one, for subtitlePath too', async () => {
    const root = tempRoot()
    const video = touch(root, 'T/T - 01 [A].mkv')
    const r = await resolveItem(root, {
      path: 'T/T - 01 [A].mkv',
      subtitlePath: 'T/T - 01 [A].ass'
    })
    expect(r).toEqual({ path: fs.realpathSync(video), subtitlePath: 'missing' })
    expect(await resolveItem(root, { path: 'T/nope.mkv' })).toEqual({ path: 'missing' })
  })

  it('escapes for a symlink out of the root, and for a path the lexical check refuses', async () => {
    const root = tempRoot()
    const outside = tempRoot()
    touch(outside, 'secret.mkv')
    fs.symlinkSync(outside, path.join(root, 'T'))
    fs.symlinkSync(path.join(outside, 'secret.mkv'), path.join(root, 'link.ass'))
    expect(await resolveItem(root, { path: 'T/secret.mkv', subtitlePath: 'link.ass' })).toEqual({
      path: 'escapes',
      subtitlePath: 'escapes'
    })
    expect(await resolveItem(root, { path: '../x.mkv' })).toEqual({ path: 'escapes' })
  })

  it('a symlink that stays inside the root resolves', async () => {
    const root = tempRoot()
    const real = touch(root, 'Real/x.mkv')
    fs.symlinkSync(path.join(root, 'Real'), path.join(root, 'Alias'))
    expect(await resolveItem(root, { path: 'Alias/x.mkv' })).toEqual({
      path: fs.realpathSync(real)
    })
  })
})

describe('resolveWriteTarget: the deepest existing ancestor', () => {
  it('the absolute target when the leaf and some parents don’t exist yet', async () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, 'T'))
    const real = fs.realpathSync(root)
    expect(await resolveWriteTarget(root, 'T/new/deeper/x.mkv')).toBe(
      path.join(real, 'T', 'new', 'deeper', 'x.mkv')
    )
    expect(await resolveWriteTarget(root, 'fresh/x.mkv')).toBe(path.join(real, 'fresh', 'x.mkv'))
    touch(root, 'T/existing.mkv')
    expect(await resolveWriteTarget(root, 'T/existing.mkv')).toBe(
      path.join(real, 'T', 'existing.mkv')
    )
  })

  it('escapes when an existing ancestor directory is a symlink out of the root', async () => {
    const root = tempRoot()
    fs.symlinkSync(tempRoot(), path.join(root, 'T'))
    expect(await resolveWriteTarget(root, 'T/new/x.mkv')).toBe('escapes')
  })

  it('escapes for a dangling symlink a copy would follow, and for a lexically bad path', async () => {
    const root = tempRoot()
    fs.symlinkSync(path.join(tempRoot(), 'gone'), path.join(root, 'x.mkv'))
    expect(await resolveWriteTarget(root, 'x.mkv')).toBe('escapes')
    expect(await resolveWriteTarget(root, '../x.mkv')).toBe('escapes')
  })
})

describe('MAX_PATH', () => {
  const rel = `${'T'.repeat(88)}/${'T'.repeat(88)} - 01 [Crunchyroll].mkv`
  const items = [
    { animeId: 1, episodeInt: '1', translationId: 7, path: rel },
    { animeId: 1, episodeInt: '2', translationId: 8, path: 'T/T - 02 [A].mkv' }
  ]

  it('flags an item under a 70-character Windows root whose relative path is within budget', () => {
    const root = `C:\\Users\\${'u'.repeat(28)}\\Videos\\Anime Library Collection\\`
    expect(root).toHaveLength(70)
    expect(rel.length).toBeLessThanOrEqual(200)
    expect(absoluteOverflow(root, items)).toEqual(['1:1:7'])
  })

  it('flags nothing under E:\\Anime Library\\', () => {
    expect(absoluteOverflow('E:\\Anime Library\\', items)).toEqual([])
  })

  it('checks subtitlePath too, and reports nothing for a POSIX root', () => {
    const root = `D:\\${'d'.repeat(80)}`
    const withSub = [{ ...items[1], subtitlePath: rel }]
    expect(absoluteOverflow(root, withSub)).toEqual(['1:2:8'])
    expect(absoluteOverflow(`/media/${'d'.repeat(200)}`, items)).toEqual([])
  })
})

describe('posters', () => {
  it('only posters/<int>.jpg', () => {
    expect(posterPath(101)).toBe('posters/101.jpg')
    expect(posterPath(0)).toBeNull()
    expect(posterPath(1.5)).toBeNull()
    expect(isPosterName('101.jpg')).toBe(true)
    for (const bad of ['../101.jpg', '101.png', 'x.jpg', '0.jpg', '101.jpg/x', '-1.jpg']) {
      expect(isPosterName(bad), bad).toBe(false)
    }
  })
})

describe('carried entries never reach a consumer', () => {
  it('neither the 3 KB-author item nor the ../x item reaches absoluteOverflow or index.html', async () => {
    const r = (await readLibrary(fixture('dropped-entries-manifest'))) as Ok
    const root = `C:\\${'r'.repeat(250)}`
    expect(absoluteOverflow(root, r.manifest.items)).toEqual(['101:2:9002'])
    const html = renderIndexHtml(r.manifest)!
    expect(html).not.toContain('AAAA')
    expect(html).not.toContain('../x')
    expect(html).toContain('Frieren - 02')
  })
})

describe('index.html', () => {
  it('is written only when naming.renamed is non-empty', async () => {
    const r = (await readLibrary(fixture('golden-metadata'))) as Ok
    expect(renderIndexHtml(r.manifest)).toBeNull()
  })

  it('escapes <script> in a title and every other string, and holds no script', () => {
    const m = manifest(1, null, {
      mode: 'videos',
      name: 'Lib "one" & <two>',
      titles: [{ animeId: 101, name: '<script>alert(1)</script>' }],
      items: [item('1', 9001, { author: "O'Brien <b>", subtitlePath: 'Frieren/a b#c.ass' })],
      naming: { rule: 'v1', renamed: ['101:1:9001'] }
    }) as unknown as SharedLibraryManifest
    const html = renderIndexHtml(m)!
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('Lib &quot;one&quot; &amp; &lt;two&gt;')
    expect(html).toContain('O&#39;Brien &lt;b&gt;')
    expect(html).toContain('href="Frieren/Frieren%20-%2001%20%5BCrunchyroll%5D.mkv"')
    expect(html).toContain('href="Frieren/a%20b%23c.ass"')
  })
})

describe('discovery', () => {
  it('finds the root and libraries one level down, not two', async () => {
    const drive = tempRoot()
    const lib = (dir: string): void => {
      fs.mkdirSync(path.join(dir, '.anime-dl'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.anime-dl', 'manifest.json'), '{}')
    }
    lib(drive)
    lib(path.join(drive, 'Anime'))
    lib(path.join(drive, 'Deep', 'Nested'))
    fs.mkdirSync(path.join(drive, 'Empty'))
    const torn = path.join(drive, 'Torn', '.anime-dl')
    fs.mkdirSync(torn, { recursive: true })
    fs.writeFileSync(path.join(torn, 'manifest.prev.json'), '{}')
    expect(await discoverLibraries(drive)).toEqual([
      drive,
      path.join(drive, 'Anime'),
      path.join(drive, 'Torn')
    ])
  })

  it('an unreadable or missing dir finds nothing', async () => {
    expect(await discoverLibraries(path.join(tempRoot(), 'nope'))).toEqual([])
    expect(await discoverLibraries(tree({}))).toEqual([])
  })
})
