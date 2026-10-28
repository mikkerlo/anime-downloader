// @vitest-environment happy-dom
//
// Library → Shared Libraries (#578). The load-bearing case is a fresh PC: an
// empty local library and no Shikimori statuses, where `statusTabs` used to be
// `[All]` and the filter row hidden, so an attached library had no way in.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import LibraryView from '../../src/renderer/src/components/views/LibraryView.vue'
import OpenLibraryDialog from '../../src/renderer/src/components/shared-library/OpenLibraryDialog.vue'

function anime(id: number, title: string): AnimeSearchResult {
  return {
    id,
    title,
    titles: {},
    posterUrlSmall: `anime-poster://${id}`,
    numberOfEpisodes: 12,
    type: 'tv',
    typeTitle: 'TV',
    year: 2023,
    season: 'fall'
  }
}

function title(
  animeId: number,
  name: string,
  container: 'mp4' | 'mkv',
  onThisPc = false
): AttachedLibraryTitle {
  const target = { episodeInt: '1', translationId: animeId * 10, container }
  return {
    animeId,
    name,
    anime: anime(animeId, name),
    hasPoster: false,
    onThisPc,
    itemCount: 1,
    mkvCount: container === 'mkv' ? 1 : 0,
    play: { any: target, withoutFfmpeg: container === 'mp4' ? target : null }
  }
}

function library(titles: AttachedLibraryTitle[]): AttachedLibraryInfo {
  return {
    libraryId: '5d7c1f3e-8a2b-4c6d-9e0f-1a2b3c4d5e6f',
    root: '/media/usb/Fixture library',
    name: 'Fixture library',
    mode: 'metadata',
    ownerNickname: 'owner',
    role: 'owner',
    access: 'read-write',
    available: true,
    pathOverflow: 0,
    mkvCount: titles.reduce((n, t) => n + t.mkvCount, 0),
    titles
  }
}

let changed: (() => void) | null
let list: AttachedLibraryInfo[]

function stubApi(overrides: Record<string, unknown>): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(overrides, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
}

function mountLibrary(opts: {
  local?: AnimeSearchResult[]
  downloaded?: number[]
  libraries: AttachedLibraryInfo[]
  ffmpeg?: boolean
}) {
  list = opts.libraries
  stubApi({
    libraryGet: vi.fn().mockResolvedValue(opts.local ?? []),
    libraryGetStatus: vi
      .fn()
      .mockImplementation(async (ids: number[]) =>
        Object.fromEntries(
          ids.map((id) => [id, { starred: false, downloaded: !!opts.downloaded?.includes(id) }])
        )
      ),
    libraryGetPriority: vi.fn().mockResolvedValue([]),
    sharedLibraryList: vi.fn().mockImplementation(async () => list),
    ffmpegCheck: vi.fn().mockResolvedValue({ available: opts.ffmpeg ?? true }),
    onSharedLibrariesChanged: (cb: () => void) => {
      changed = cb
      return () => {}
    }
  })
  return mount(LibraryView)
}

const tabLabels = (w: ReturnType<typeof mount>): string[] =>
  w.findAll('.pill-tab').map((t) => t.text())

async function selectShared(w: ReturnType<typeof mount>): Promise<void> {
  const tab = w.findAll('.pill-tab').find((t) => t.text() === 'Shared Libraries')!
  await tab.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  changed = null
})

describe('LibraryView — the Shared Libraries tab on a fresh PC', () => {
  it('shows [All, Shared Libraries] with an empty local library and no statuses', async () => {
    const w = mountLibrary({ libraries: [library([title(101, 'Frieren', 'mp4')])] })
    await flushPromises()
    expect(w.find('.pill-tabs').exists()).toBe(true)
    expect(tabLabels(w)).toEqual(['All', 'Shared Libraries'])
  })

  it("selecting Shared Libraries shows the drive's titles, not 'No saved anime yet'", async () => {
    const w = mountLibrary({ libraries: [library([title(101, 'Frieren', 'mp4')])] })
    await flushPromises()
    await selectShared(w)
    expect(w.findAll('[data-testid="drive-title"] .acard-title').map((n) => n.text())).toEqual([
      'Frieren'
    ])
    expect(w.text()).not.toContain('No saved anime yet')
    expect(w.find('[data-testid="mode-badge"]').text()).toBe('With metadata')
    expect(w.text()).toContain('Sync arrives in a later update.')
  })

  it('with nothing attached the row stays hidden (control)', async () => {
    const w = mountLibrary({ libraries: [] })
    await flushPromises()
    expect(w.find('.pill-tabs').exists()).toBe(false)
    expect(w.text()).toContain('No saved anime yet')
  })

  it('detaching the last library while the tab is selected keeps the tab until the user leaves', async () => {
    const w = mountLibrary({ libraries: [library([title(101, 'Frieren', 'mp4')])] })
    await flushPromises()
    await selectShared(w)
    list = []
    changed!()
    await flushPromises()
    expect(tabLabels(w)).toEqual(['All', 'Shared Libraries'])
    expect(w.find('[data-testid="shared-libraries-tab"]').exists()).toBe(true)
    expect(w.text()).not.toContain('No saved anime yet')
    expect(w.text()).not.toContain('No anime with this status')
    await w.findAll('.pill-tab')[0].trigger('click')
    await flushPromises()
    expect(w.find('.pill-tabs').exists()).toBe(false)
  })
})

describe('a title both local and attached', () => {
  it('shows "Also on <library>" in All and "On this PC" in Shared Libraries', async () => {
    const w = mountLibrary({
      local: [anime(101, 'Frieren'), anime(303, 'Local only')],
      downloaded: [101, 303],
      libraries: [library([title(101, 'Frieren', 'mp4', true), title(202, 'Dungeon Meshi', 'mkv')])]
    })
    await flushPromises()
    const badges = w.findAll('[data-testid="also-on"]')
    expect(badges.map((b) => b.text())).toEqual(['Also on Fixture library'])
    await selectShared(w)
    const onPc = w
      .findAll('[data-testid="drive-title"]')
      .map((card) => [
        card.find('.acard-title').text(),
        card.find('[data-testid="on-this-pc"]').exists()
      ])
    expect(onPc).toEqual([
      ['Frieren', true],
      ['Dungeon Meshi', false]
    ])
  })
})

describe('missing ffmpeg', () => {
  async function shared(ffmpeg: boolean) {
    const w = mountLibrary({
      libraries: [library([title(101, 'Frieren', 'mp4'), title(202, 'Dungeon Meshi', 'mkv')])],
      ffmpeg
    })
    await flushPromises()
    await selectShared(w)
    const play = (name: string) =>
      w
        .findAll('[data-testid="drive-title"]')
        .find((c) => c.find('.acard-title').text() === name)!
        .find('[data-testid="play-from-drive"]')
    return { w, play }
  }

  it('renders the banner, disables the .mkv title and keeps the .mp4 title playable', async () => {
    const { w, play } = await shared(false)
    expect(w.find('[data-testid="ffmpeg-missing-banner"]').text()).toBe(
      "ffmpeg isn't installed on this PC, so 1 MKV episode can't play. MP4 episodes with .ass subtitles still play. Connect to the internet once to download it, or use Prepare for offline."
    )
    expect(play('Dungeon Meshi').attributes('disabled')).toBeDefined()
    expect(play('Dungeon Meshi').attributes('title')).toContain("ffmpeg isn't installed")
    expect(play('Frieren').attributes('disabled')).toBeUndefined()
  })

  it('with ffmpeg available there is no banner and both play', async () => {
    const { w, play } = await shared(true)
    expect(w.find('[data-testid="ffmpeg-missing-banner"]').exists()).toBe(false)
    expect(play('Dungeon Meshi').attributes('disabled')).toBeUndefined()
    expect(play('Frieren').attributes('disabled')).toBeUndefined()
  })
})

describe('OpenLibraryDialog', () => {
  function candidate(
    name: string,
    libraryId: string,
    identity: SharedLibraryCandidate['identity']
  ): SharedLibraryCandidate {
    return {
      root: `/media/usb/${name}`,
      libraryId,
      name,
      ownerNickname: identity === 'videos' ? null : 'owner',
      mode: identity === 'videos' ? 'videos' : 'metadata',
      titleCount: 2,
      identity
    }
  }

  function mountDialog(candidates: SharedLibraryCandidate[]) {
    const attach = vi.fn().mockResolvedValue({ ok: true, library: library([]) })
    stubApi({
      sharedLibraryPickAndDiscover: vi.fn().mockResolvedValue({ dir: '/media/usb', candidates }),
      sharedLibraryAttach: attach,
      sharedLibraryList: vi.fn().mockResolvedValue([]),
      ffmpegCheck: vi.fn().mockResolvedValue({ available: true })
    })
    return { w: mount(OpenLibraryDialog), attach }
  }

  it('a drive with two libraries asks the user to pick', async () => {
    const { w, attach } = mountDialog([
      candidate('A', 'aaaaaaaa-0000-4000-8000-000000000001', 'owner'),
      candidate('B', 'bbbbbbbb-0000-4000-8000-000000000002', 'videos')
    ])
    await flushPromises()
    const rows = w.findAll('[data-testid="library-candidate"]')
    expect(rows.map((r) => r.find('.candidate-name').text())).toEqual(['A', 'B'])
    expect(attach).not.toHaveBeenCalled()
    await rows[1].trigger('click')
    await flushPromises()
    expect(attach).toHaveBeenCalledWith('bbbbbbbb-0000-4000-8000-000000000002', undefined)
  })

  it('no account: the claim needs an explicit confirmation', async () => {
    const { w, attach } = mountDialog([
      candidate('A', 'aaaaaaaa-0000-4000-8000-000000000001', 'choose')
    ])
    await flushPromises()
    expect(w.text()).not.toContain('never online')
    await w.find('[data-testid="use-as-owner"]').trigger('click')
    expect(w.text()).toContain('Only do this if you are owner.')
    expect(attach).not.toHaveBeenCalled()
    await w.find('[data-testid="confirm-claim"]').trigger('click')
    await flushPromises()
    expect(attach).toHaveBeenCalledWith('aaaaaaaa-0000-4000-8000-000000000001', 'claim')
  })

  it("someone else's library: the warning, then videos only", async () => {
    const { w, attach } = mountDialog([
      candidate('A', 'aaaaaaaa-0000-4000-8000-000000000001', 'foreign')
    ])
    await flushPromises()
    expect(w.text()).toContain(
      'To keep your own progress on this drive, create your own Shared Library next to it.'
    )
    await w.find('[data-testid="use-videos"]').trigger('click')
    await flushPromises()
    expect(attach).toHaveBeenCalledWith('aaaaaaaa-0000-4000-8000-000000000001', 'videos')
  })
})

describe('PlayerView passes animeId to playerFindLocalFile', () => {
  // PlayerView has no mount harness (see episode-walk-release.test.ts), so the
  // source is read: next / previous / a translation switch from a drive
  // episode resolve on the drive only when the id goes along.
  it('every call passes props.animeId as the trailing argument', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/views/PlayerView.vue'),
      'utf8'
    )
    const calls = [...src.matchAll(/window\.api\.playerFindLocalFile\(([^)]*)\)/g)].map((m) =>
      m[1]
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
    )
    expect(calls).toHaveLength(2)
    for (const args of calls) {
      expect(args).toHaveLength(5)
      expect(args[4]).toBe('props.animeId')
    }
  })
})
