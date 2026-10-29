// @vitest-environment happy-dom
//
// The export dialog (#574): the size-vs-free bar turns red and Export is
// disabled when the selection doesn't fit, or when the target is an own
// With metadata library; the estimate refreshes as the selection changes.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ExportDialog from '../../../src/renderer/src/components/shared-library/ExportDialog.vue'

const TITLES: ExportTreeTitle[] = [
  {
    animeId: 1,
    name: 'Alpha',
    translations: [
      {
        translationId: 11,
        author: 'A',
        translationType: 'subRu',
        quality: 720,
        episodes: [
          {
            key: '1:1:11',
            episodeInt: '1',
            label: 'E1',
            state: 'ready',
            size: 1000,
            unmerged: false
          },
          {
            key: '1:2:11',
            episodeInt: '2',
            label: 'E2',
            state: 'ready',
            size: 3000,
            unmerged: false
          }
        ]
      }
    ],
    notDownloaded: []
  }
]

function target(over: Partial<ExportTarget>): ExportTarget {
  return {
    dir: '/drive',
    root: '/drive/Anime Library',
    kind: 'new',
    mode: 'videos',
    libraryName: 'Anime Library',
    blocked: null,
    free: 1_000_000,
    present: [],
    presentMerged: [],
    ...over
  }
}

let api: Record<string, unknown>

function stubApi(
  t: ExportTarget | ((req: ExportPlanRequest) => ExportTarget),
  pf: ExportPreflight | null = null,
  account: Partial<Pick<ExportPlan, 'canExportMetadata' | 'nickname'>> = {}
): void {
  api = {
    exportPlan: vi.fn(async (req: ExportPlanRequest) => ({
      titles: TITLES,
      target: req.target ? (typeof t === 'function' ? t(req) : t) : null,
      preflight: req.target ? pf : null,
      ...account
    })),
    exportPickTarget: vi.fn(async () => '/drive'),
    exportStart: vi.fn(async () => ({ ok: false, reason: 'refused by main' })),
    exportListJobs: vi.fn(async () => []),
    onExportJobUpdated: () => () => {}
  }
  ;(window as unknown as { api: unknown }).api = api
}

async function open(
  t: ExportTarget | ((req: ExportPlanRequest) => ExportTarget),
  preselect = true,
  pf: ExportPreflight | null = null,
  account: Partial<Pick<ExportPlan, 'canExportMetadata' | 'nickname'>> = {}
) {
  stubApi(t, pf, account)
  const w = mount(ExportDialog, { props: { animeIds: [1], preselect } })
  await flushPromises()
  await w.find('[data-testid="export-pick"]').trigger('click')
  await flushPromises()
  return w
}

const startButton = (w: ReturnType<typeof mount>): HTMLButtonElement =>
  w.find('[data-testid="export-start"]').element as HTMLButtonElement

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('ExportDialog (#574)', () => {
  it('enables Export when the selection fits a new library', async () => {
    const w = await open(target({}))
    expect(w.find('[data-testid="export-target-line"]').text()).toBe("New library 'Anime Library'")
    expect(w.find('[data-testid="export-space-bar"]').classes()).not.toContain('over')
    expect(startButton(w).disabled).toBe(false)
    expect(w.text()).toContain('3.9 KB to copy (2 episodes)')
  })

  it('turns the bar red and disables Export when the selection does not fit (1% margin)', async () => {
    // 4000 bytes need 4040 free.
    const w = await open(target({ free: 4039 }))
    expect(w.find('[data-testid="export-space-bar"]').classes()).toContain('over')
    expect(startButton(w).disabled).toBe(true)
    expect(w.text()).toContain('doesn’t fit')
  })

  it('refreshes live: deselecting an episode makes it fit', async () => {
    const w = await open(target({ free: 3000 }))
    expect(startButton(w).disabled).toBe(true)
    await w.find('[data-testid="tree-episode-1:2:11"]').trigger('change')
    expect(w.find('[data-testid="export-space-bar"]').classes()).not.toContain('over')
    expect(startButton(w).disabled).toBe(false)
  })

  it('routes a Videos only add into an own With metadata library to With metadata, and says why (#586)', async () => {
    const w = await open(
      target({ kind: 'own-metadata', mode: 'metadata', libraryName: 'Trip' }),
      true,
      null,
      {
        canExportMetadata: true,
        nickname: 'akira'
      }
    )
    expect(w.find('[data-testid="export-target-line"]').text()).toBe(
      "Adds to 'Trip' (With metadata)"
    )
    expect(radio(w, 'export-mode-metadata').checked).toBe(true)
    expect(radio(w, 'export-mode-videos').checked).toBe(false)
    expect(radio(w, 'export-mode-videos').disabled).toBe(true)
    expect(w.find('[data-testid="export-mode-routed"]').text()).toBe(
      'This library carries watch state, so new titles are added with it.'
    )
    expect(startButton(w).disabled).toBe(false)
    await w.find('[data-testid="export-start"]').trigger('click')
    await flushPromises()
    expect(api.exportStart).toHaveBeenCalledWith(expect.objectContaining({ mode: 'metadata' }))
  })

  it('says a foreign library gets a sibling, and Export stays enabled', async () => {
    const w = await open(target({ kind: 'foreign', ownerNickname: 'friend' }))
    expect(w.find('[data-testid="export-target-line"]').text()).toBe(
      "This drive has friend's library. Your export goes into a new library next to it."
    )
    expect(startButton(w).disabled).toBe(false)
  })

  it('next to a foreign library, says the export adds to the earlier sibling', async () => {
    const w = await open(
      target({ kind: 'add', ownerNickname: 'friend', libraryName: 'Trip', root: '/drive/Trip (2)' })
    )
    expect(w.find('[data-testid="export-target-line"]').text()).toBe(
      "This drive has friend's library. Your export adds to 'Trip' (Videos only) next to it."
    )
    expect(startButton(w).disabled).toBe(false)
  })

  it('does not count items already on the drive', async () => {
    const w = await open(target({ kind: 'add', present: ['1:2:11'], free: 1500 }))
    expect(w.find('[data-testid="export-target-line"]').text()).toBe(
      "Adds to 'Anime Library' (Videos only)"
    )
    expect(startButton(w).disabled).toBe(false)
    expect(w.text()).toContain('1 already on the drive')
  })

  it('starts with nothing selected without preselect, and Export disabled', async () => {
    const w = await open(target({}), false)
    expect(startButton(w).disabled).toBe(true)
  })

  it('shows main’s refusal and sends the selection', async () => {
    const w = await open(target({}))
    await w.find('[data-testid="export-start"]').trigger('click')
    await flushPromises()
    expect(api.exportStart).toHaveBeenCalledWith({
      selection: [
        { animeId: 1, translationId: 11, episodeInt: '1' },
        { animeId: 1, translationId: 11, episodeInt: '2' }
      ],
      target: '/drive',
      name: 'Anime Library',
      unmerged: 'copy-as-is',
      codec: 'copy',
      mode: 'videos'
    })
    expect(w.text()).toContain('refused by main')
  })
})

describe('ExportDialog With metadata (#586)', () => {
  const ME = { canExportMetadata: true, nickname: 'akira' }
  const byMode =
    (videos: Partial<ExportTarget>, metadata: Partial<ExportTarget>) => (req: ExportPlanRequest) =>
      req.mode === 'metadata'
        ? target({ mode: 'metadata', ...metadata })
        : target({ mode: 'videos', ...videos })

  it('logged out: With metadata is disabled, with the reason', async () => {
    const w = await open(target({}), true, null, { canExportMetadata: false, nickname: null })
    expect(radio(w, 'export-mode-metadata').disabled).toBe(true)
    expect(radio(w, 'export-mode-videos').checked).toBe(true)
    expect(w.find('[data-testid="export-mode-hint"]').text()).toBe(
      'Log in to Shikimori to include watch state'
    )
  })

  it('logged in: offered with its help text; choosing it names the library after the account and re-plans', async () => {
    const w = await open(byMode({}, { libraryName: 'Anime Library (akira)' }), true, null, ME)
    expect(radio(w, 'export-mode-metadata').disabled).toBe(false)
    expect(w.find('[data-testid="export-mode-hint"]').text()).toBe(
      'Includes watch progress, Shikimori status, stars and priority for these titles only. Never includes passwords or tokens.'
    )
    await w.find('[data-testid="export-mode-metadata"]').trigger('change')
    await flushPromises()
    expect((w.find('[data-testid="export-name"]').element as HTMLInputElement).value).toBe(
      'Anime Library (akira)'
    )
    const calls = (api.exportPlan as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as ExportPlanRequest
    )
    expect(calls[calls.length - 1]).toMatchObject({
      mode: 'metadata',
      name: 'Anime Library (akira)'
    })
    await w.find('[data-testid="export-start"]').trigger('click')
    await flushPromises()
    expect(api.exportStart).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'metadata', name: 'Anime Library (akira)' })
    )
  })

  it('a Videos-only target With metadata: the upgrade needs the confirmation, which goes to main', async () => {
    const w = await open(
      byMode({ kind: 'add', libraryName: 'Trip' }, { kind: 'upgrade', libraryName: 'Trip' }),
      true,
      null,
      ME
    )
    expect(w.find('[data-testid="export-takeover"]').exists()).toBe(false)
    await w.find('[data-testid="export-mode-metadata"]').trigger('change')
    await flushPromises()
    expect(w.find('[data-testid="export-target-line"]').text()).toBe(
      "Upgrade 'Trip' to With metadata"
    )
    expect(w.find('[data-testid="export-takeover"]').text()).toBe(
      "You'll become the owner of this library. Other PCs that use it will see it as akira's library."
    )
    expect(startButton(w).disabled).toBe(true)
    await w.find('[data-testid="export-takeover-confirm"]').setValue(true)
    expect(startButton(w).disabled).toBe(false)
    await w.find('[data-testid="export-start"]').trigger('click')
    await flushPromises()
    expect(api.exportStart).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'metadata', confirmTakeover: true })
    )
  })

  it('a claimed target: the claim message, and a sibling', async () => {
    const w = await open(target({ kind: 'claimed', ownerNickname: 'friend' }))
    expect(w.find('[data-testid="export-target-line"]').text()).toBe(
      'You use this library through a claim. Your export goes into a new library next to it.'
    )
    expect(startButton(w).disabled).toBe(false)
  })
})

// One unmerged pair (E2) next to a merged episode (E1).
const PAIR_TITLES: ExportTreeTitle[] = [
  {
    ...TITLES[0],
    translations: [
      {
        ...TITLES[0].translations[0],
        episodes: [
          { ...TITLES[0].translations[0].episodes[0] },
          { ...TITLES[0].translations[0].episodes[1], unmerged: true }
        ]
      }
    ]
  }
]

async function openWithPairs(merge: ExportMergeSupport | undefined, free = 1_000_000) {
  stubApi(target({ free }))
  api.exportPlan = vi.fn(async (req: ExportPlanRequest) => ({
    titles: PAIR_TITLES,
    target: req.target ? target({ free }) : null,
    preflight: null,
    ...(merge ? { merge } : {})
  }))
  const w = mount(ExportDialog, { props: { animeIds: [1], preselect: true } })
  await flushPromises()
  await w.find('[data-testid="export-pick"]').trigger('click')
  await flushPromises()
  return w
}

const radio = (w: ReturnType<typeof mount>, id: string): HTMLInputElement =>
  w.find(`[data-testid="${id}"]`).element as HTMLInputElement

describe('ExportDialog unmerged pairs (#576)', () => {
  it('shows no merge option when the selection has no unmerged pair', async () => {
    const w = await open(target({}))
    expect(w.find('[data-testid="export-unmerged"]').exists()).toBe(false)
  })

  it('with ffmpeg: Merge into MKV is the default, the codec list comes from its encoders, and the codec is No', async () => {
    const w = await openWithPairs({ available: true, encoders: ['libx265', 'hevc_nvenc'] })
    const block = w.find('[data-testid="export-unmerged"]')
    expect(block.text()).toContain('Unmerged episodes (1):')
    expect(radio(w, 'export-unmerged-merge').checked).toBe(true)
    expect(radio(w, 'export-unmerged-merge').disabled).toBe(false)
    const select = w.find('[data-testid="export-codec"]')
    expect(select.findAll('option').map((o) => o.text())).toEqual([
      'No (fastest)',
      'H.265 (CPU)',
      'H.265 (NVIDIA GPU)'
    ])
    expect((select.element as HTMLSelectElement).value).toBe('copy')
    expect(block.text()).toContain('Resolution is never reduced.')
    expect(block.text()).toContain('Other PCs need ffmpeg to play .mkv files.')

    await w.find('[data-testid="export-start"]').trigger('click')
    await flushPromises()
    expect(api.exportStart).toHaveBeenCalledWith(
      expect.objectContaining({ unmerged: 'merge', codec: 'copy' })
    )
  })

  it('the option goes when the unmerged pair is deselected', async () => {
    const w = await openWithPairs({ available: true, encoders: [] })
    expect(w.find('[data-testid="export-unmerged"]').exists()).toBe(true)
    await w.find('[data-testid="tree-episode-1:2:11"]').trigger('change')
    expect(w.find('[data-testid="export-unmerged"]').exists()).toBe(false)
  })

  it('without ffmpeg: Merge is disabled with the reason, and Copy as they are is selected', async () => {
    const w = await openWithPairs({ available: false, encoders: [] })
    expect(radio(w, 'export-unmerged-merge').disabled).toBe(true)
    expect(radio(w, 'export-unmerged-copy').checked).toBe(true)
    expect(w.find('[data-testid="export-merge-missing"]').text()).toBe(
      "ffmpeg isn't installed on this PC. Download it in Settings → Merging"
    )
    expect(w.find('[data-testid="export-codec"]').exists()).toBe(false)
    await w.find('[data-testid="export-start"]').trigger('click')
    await flushPromises()
    expect(api.exportStart).toHaveBeenCalledWith(
      expect.objectContaining({ unmerged: 'copy-as-is' })
    )
  })

  describe('pairs already on the drive as a merged MKV (#623)', () => {
    // E2 is on the drive merged; E3 is a new pair.
    const TITLES3: ExportTreeTitle[] = [
      {
        ...PAIR_TITLES[0],
        translations: [
          {
            ...PAIR_TITLES[0].translations[0],
            episodes: [
              ...PAIR_TITLES[0].translations[0].episodes,
              {
                key: '1:3:11',
                episodeInt: '3',
                label: 'E3',
                state: 'ready',
                size: 2000,
                unmerged: true
              }
            ]
          }
        ]
      }
    ]

    async function openMergedThere(presentMerged: string[]) {
      const t = target({ kind: 'add', present: ['1:2:11'], presentMerged })
      stubApi(t)
      api.exportPlan = vi.fn(async (req: ExportPlanRequest) => ({
        titles: TITLES3,
        target: req.target ? t : null,
        preflight: null,
        merge: { available: true, encoders: ['libx265'] }
      }))
      const w = mount(ExportDialog, { props: { animeIds: [1], preselect: true } })
      await flushPromises()
      await w.find('[data-testid="export-pick"]').trigger('click')
      await flushPromises()
      return w
    }
    const note = (w: ReturnType<typeof mount>) => w.find('[data-testid="export-not-reencoded"]')

    it('says they won’t be re-encoded only with Merge on and a codec other than copy', async () => {
      const w = await openMergedThere(['1:2:11'])
      expect(w.text()).toContain('1 already on the drive')
      expect(note(w).exists()).toBe(false)

      await w.find('[data-testid="export-codec"]').setValue('libx265')
      await flushPromises()
      expect(note(w).text()).toBe(
        '1 episode is already on the drive as MKV and won’t be re-encoded.'
      )

      await w.find('[data-testid="export-unmerged-copy"]').setValue(true)
      await flushPromises()
      expect(note(w).exists()).toBe(false)
    })

    it('counts only selected pairs main reports as merged', async () => {
      const w = await openMergedThere([])
      await w.find('[data-testid="export-codec"]').setValue('libx265')
      await flushPromises()
      expect(note(w).exists()).toBe(false)

      const m = await openMergedThere(['1:2:11'])
      await m.find('[data-testid="export-codec"]').setValue('libx265')
      await flushPromises()
      expect(note(m).exists()).toBe(true)
      await m.find('[data-testid="tree-episode-1:2:11"]').trigger('change')
      expect(note(m).exists()).toBe(false)
    })

    const block = (w: ReturnType<typeof mount>) => w.find('[data-testid="export-unmerged"]')
    const codecSelect = (w: ReturnType<typeof mount>) => w.find('[data-testid="export-codec"]')

    it('with only pairs already on the drive as MKV selected, the merge options stay, and the codec drives the note', async () => {
      const w = await openMergedThere(['1:2:11'])
      // E1 (not a pair) and E3 (the pair still to copy) deselected: E2 alone.
      await w.find('[data-testid="tree-episode-1:1:11"]').trigger('change')
      await w.find('[data-testid="tree-episode-1:3:11"]').trigger('change')
      await flushPromises()
      expect(w.text()).toContain('1 already on the drive')
      expect(block(w).exists()).toBe(true)
      expect(block(w).text()).toContain('Unmerged episodes: all already on the drive')
      expect(radio(w, 'export-unmerged-merge').checked).toBe(true)
      expect(codecSelect(w).exists()).toBe(true)
      expect(note(w).exists()).toBe(false)
      expect(startButton(w).disabled).toBe(true)
      expect(w.find('.why').text()).toBe('Nothing to copy.')

      await codecSelect(w).setValue('libx265')
      await flushPromises()
      expect(note(w).text()).toBe(
        '1 episode is already on the drive as MKV and won’t be re-encoded.'
      )
      expect(startButton(w).disabled).toBe(true)

      await codecSelect(w).setValue('copy')
      await flushPromises()
      expect(note(w).exists()).toBe(false)
    })

    it('unticking the only pair still to copy keeps the codec select next to the note', async () => {
      const w = await openMergedThere(['1:2:11'])
      await codecSelect(w).setValue('libx265')
      await flushPromises()
      await w.find('[data-testid="tree-episode-1:3:11"]').trigger('change')
      await flushPromises()
      expect(note(w).exists()).toBe(true)
      expect(codecSelect(w).exists()).toBe(true)
    })

    it('a pair on the drive copied as-is (not merged) brings no merge options back', async () => {
      const w = await openMergedThere([])
      await w.find('[data-testid="tree-episode-1:3:11"]').trigger('change')
      await flushPromises()
      expect(w.text()).toContain('1 already on the drive')
      expect(block(w).exists()).toBe(false)
    })
  })

  it('a re-encode says the size will change, counts the pair plus 10%, and re-plans with the choice', async () => {
    // E1 1000 + E2 3000: a copy merge needs 4040 free, a re-encode 1000 + 3300 → 4343.
    const w = await openWithPairs({ available: true, encoders: ['libx265'] }, 4100)
    expect(startButton(w).disabled).toBe(false)
    expect(w.text()).not.toContain('size will change')
    await w.find('[data-testid="export-codec"]').setValue('libx265')
    await flushPromises()
    expect(w.text()).toContain('size will change')
    expect(w.text()).toContain('doesn’t fit')
    expect(startButton(w).disabled).toBe(true)
    const calls = (api.exportPlan as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as ExportPlanRequest
    )
    expect(calls[calls.length - 1]).toMatchObject({ unmerged: 'merge', codec: 'libx265' })
  })
})

function preflight(over: Partial<ExportPreflight>): ExportPreflight {
  return {
    ok: true,
    fsType: 'fat32',
    blockers: [],
    warnings: [],
    driveWarnings: [],
    skipped: [],
    mayBeSkipped: [],
    renamed: [],
    renames: {},
    overflow: [],
    ...over
  }
}

describe('ExportDialog preflight panel (#575)', () => {
  it('shows the plan’s preflight narrowed to the selection, and skipped files leave the estimate', async () => {
    const w = await open(
      target({}),
      true,
      preflight({
        skipped: ['1:2:11'],
        renamed: ['1:1:11'],
        renames: { '1:1:11': { from: 'CON/CON - 01 [A].mkv', to: 'CON_/CON - 01 [A].mkv' } },
        overflow: ['1:1:11']
      })
    )
    const panel = w.find('[data-testid="export-preflight"]')
    expect(panel.find('[data-testid="pf-skipped"] summary').text()).toBe(
      'This drive is FAT32: 1 file over 4 GB will be skipped.'
    )
    expect(panel.find('[data-testid="pf-skipped"]').text()).toContain('Alpha — E2 (A)')
    expect(panel.find('[data-testid="pf-renamed"]').text()).toContain(
      'CON/CON - 01 [A].mkv → CON_/CON - 01 [A].mkv'
    )
    expect(panel.find('[data-testid="pf-overflow"] summary').text()).toBe(
      '1 file will have paths too long for some Windows apps. Choose a shorter folder.'
    )
    // Only E1 (1000 bytes) is copied.
    expect(w.text()).toContain('to copy (1 episodes)')
    expect(startButton(w).disabled).toBe(false)

    // E1 deselected: its rename and overflow lines go, E2's skip stays.
    await w.find('[data-testid="tree-episode-1:1:11"]').trigger('change')
    expect(w.find('[data-testid="pf-renamed"]').exists()).toBe(false)
    expect(w.find('[data-testid="pf-overflow"]').exists()).toBe(false)
    expect(w.find('[data-testid="pf-skipped"]').exists()).toBe(true)
    expect(startButton(w).disabled).toBe(true)
  })

  it('a blocker disables Export and says why', async () => {
    const msg = 'This drive is read-only on this computer (NTFS on macOS).'
    const w = await open(
      target({}),
      true,
      preflight({ ok: false, fsType: 'ntfs', blockers: [msg] })
    )
    expect(w.find('[data-testid="export-preflight"]').text()).toContain(msg)
    expect(startButton(w).disabled).toBe(true)
    expect(w.find('.why').text()).toBe(msg)
  })

  it('no panel when there is nothing to say', async () => {
    const w = await open(target({}), true, preflight({ fsType: 'exfat' }))
    expect(w.find('[data-testid="export-preflight"]').exists()).toBe(false)
  })

  it('every plan of one dialog carries the same session, so main probes each folder once', async () => {
    vi.useFakeTimers()
    try {
      const w = await open(target({}))
      await w.find('[data-testid="export-name"]').setValue('Other')
      await vi.advanceTimersByTimeAsync(400)
      await flushPromises()
      const calls = (api.exportPlan as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as ExportPlanRequest
      )
      const withTarget = calls.filter((c) => c.target !== null)
      expect(withTarget.map((c) => c.name)).toEqual(['Anime Library', 'Other'])
      expect(typeof withTarget[0].session).toBe('string')
      expect(withTarget[1].session).toBe(withTarget[0].session)
    } finally {
      vi.useRealTimers()
    }
  })
})
