// #684: smotret left `.ru`. A subtitle or mp4-fallback item persisted in
// queue.json before that keeps its absolute `.ru` URL, and `resume()` refetches
// `item.url` as is — Node's fetch never passes the session redirect. Once
// `/translations/ass` stops answering on `.ru`, the item would save the "site
// moved" page as its `.ass`. `loadQueue` moves such URLs to the new host.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DownloadManager, type DownloadItem } from '../../src/main/download-manager'

const ASS = '[Script Info]\nTitle: made up\n'

function persisted(overrides: Partial<DownloadItem>): DownloadItem {
  return {
    id: 'subtitle-9001',
    translationId: 9001,
    kind: 'subtitle',
    url: 'https://smotret-anime.ru/translations/ass/9001?download=1&access_token=made-up',
    filename: path.join('Made Up', 'Made Up - 01 [Author].ass'),
    animeName: 'Made Up',
    episodeLabel: 'ep1',
    animeId: 4242,
    episodeInt: '1',
    quality: 0,
    translationType: 'subRu',
    author: 'Author',
    status: 'downloading',
    bytesReceived: 0,
    totalBytes: 0,
    speed: 0,
    ...overrides
  }
}

describe('DownloadManager — legacy smotret URLs in queue.json (#684)', () => {
  let userDataDir: string
  let downloadDir: string
  let dm: DownloadManager
  let realFetch: typeof globalThis.fetch

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-legacy-ud-'))
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-legacy-dl-'))
    realFetch = globalThis.fetch
  })

  afterEach(() => {
    dm?.destroy()
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  })

  function load(items: DownloadItem[]): DownloadManager {
    fs.writeFileSync(
      path.join(userDataDir, 'queue.json'),
      JSON.stringify({ queue: items, mergeStatuses: {} })
    )
    dm = new DownloadManager(downloadDir, {} as never, userDataDir)
    dm.loadQueue()
    return dm
  }

  it('a persisted .ru subtitle item resumes against smotret-anime.app', async () => {
    const fetchStub: Mock = vi.fn(async () => new Response(ASS))
    globalThis.fetch = fetchStub as unknown as typeof fetch
    load([persisted({})])

    dm.resume('subtitle-9001')
    await vi.waitFor(() => expect(dm.getItem('subtitle-9001')?.status).toBe('completed'))

    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(String(fetchStub.mock.calls[0][0])).toBe(
      'https://smotret-anime.app/translations/ass/9001?download=1&access_token=made-up'
    )
    expect(
      fs.readFileSync(path.join(downloadDir, 'Made Up', 'Made Up - 01 [Author].ass'), 'utf8')
    ).toBe(ASS)
  })

  it('rewrites every legacy host once at load, and leaves CDN and live-mirror URLs alone', () => {
    const cdn = 'https://cdn.example.invalid/v/9002.mp4?sig=made-up'
    const co = 'https://smotret-anime.co/translations/ass/9004?download=1'
    load([
      persisted({}),
      persisted({ id: 'video-9002', kind: 'video', url: cdn }),
      persisted({
        id: 'video-9003',
        kind: 'video',
        url: 'https://www.anime-365.ru/translations/mp4/9003?format=mp4&height=720'
      }),
      persisted({ id: 'subtitle-9004', translationId: 9004, url: co })
    ])
    const queue = (dm as unknown as { queue: DownloadItem[] }).queue
    expect(queue.map((i) => i.url)).toEqual([
      'https://smotret-anime.app/translations/ass/9001?download=1&access_token=made-up',
      cdn,
      'https://smotret-anime.app/translations/mp4/9003?format=mp4&height=720',
      co
    ])
  })
})
