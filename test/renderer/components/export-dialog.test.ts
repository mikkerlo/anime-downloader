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
    libraryName: 'Anime Library',
    blocked: null,
    free: 1_000_000,
    present: [],
    ...over
  }
}

let api: Record<string, unknown>

function stubApi(t: ExportTarget, pf: ExportPreflight | null = null): void {
  api = {
    exportPlan: vi.fn(async (req: ExportPlanRequest) => ({
      titles: TITLES,
      target: req.target ? t : null,
      preflight: req.target ? pf : null
    })),
    exportPickTarget: vi.fn(async () => '/drive'),
    exportStart: vi.fn(async () => ({ ok: false, reason: 'refused by main' })),
    exportListJobs: vi.fn(async () => []),
    onExportJobUpdated: () => () => {}
  }
  ;(window as unknown as { api: unknown }).api = api
}

async function open(t: ExportTarget, preselect = true, pf: ExportPreflight | null = null) {
  stubApi(t, pf)
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

  it('disables Export for an own With metadata library', async () => {
    const w = await open(
      target({ kind: 'own-metadata', blocked: 'This library carries watch state.' })
    )
    expect(w.find('[data-testid="export-target-line"]').text()).toContain('needs With metadata')
    expect(startButton(w).disabled).toBe(true)
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
      name: 'Anime Library'
    })
    expect(w.text()).toContain('refused by main')
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
