// @vitest-environment happy-dom
//
// PlayerView's disconnect overlay (#582). PlayerView has no mount harness (see
// `player-lifecycle-scope.test.ts`), so as there the production text is lifted
// out of the SFC: `reportPrepareError` runs over fakes, and the open-time
// branch and the template are read. `use-drive-disconnect.test.ts` covers the
// overlay's state machine; `DriveEpisodes` is mounted below.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { transformSync } from 'esbuild'
import { ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DriveEpisodes from '../../../src/renderer/src/components/shared-library/DriveEpisodes.vue'
import ImportDialog from '../../../src/renderer/src/components/shared-library/ImportDialog.vue'

const SOURCE = readFileSync(
  resolve(__dirname, '../../../src/renderer/src/components/views/PlayerView.vue'),
  'utf8'
)

function slice(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle)
  const end = SOURCE.indexOf(endNeedle, start + startNeedle.length)
  expect(start, `missing slice start: ${startNeedle}`).toBeGreaterThan(-1)
  expect(end, `missing slice end: ${endNeedle}`).toBeGreaterThan(start)
  return SOURCE.slice(start, end)
}

describe('PlayerView: a drive-disconnected result raises the overlay', () => {
  function reportPrepareError() {
    const js = transformSync(slice('function reportPrepareError(', '\nasync function'), {
      loader: 'ts'
    }).code
    const ctx = {
      PLAYER_CLOSED_BAIL: { ok: false, error: 'player closed' },
      remuxError: ref(''),
      driveDisconnect: { onMseDisconnected: vi.fn() }
    }
    const fn = new Function(
      'ctx',
      `const { PLAYER_CLOSED_BAIL, remuxError, driveDisconnect } = ctx;\n${js}\nreturn reportPrepareError;`
    )(ctx) as (prep: { ok: false; error: string; reason?: string }) => void
    return { fn, ctx }
  }

  it('an open-time result with reason drive-disconnected shows the overlay, not the MKV error', () => {
    const { fn, ctx } = reportPrepareError()
    fn({ ok: false, error: 'File not found', reason: 'drive-disconnected' })
    expect(ctx.driveDisconnect.onMseDisconnected).toHaveBeenCalledTimes(1)
    expect(ctx.remuxError.value).toBe('')
  })

  it('without a reason it is the MKV error, as today', () => {
    const { fn, ctx } = reportPrepareError()
    fn({ ok: false, error: 'Codecs not supported for MSE' })
    expect(ctx.driveDisconnect.onMseDisconnected).not.toHaveBeenCalled()
    expect(ctx.remuxError.value).toBe('Codecs not supported for MSE')
  })

  it('the open returns the reason before trying the legacy remux of a file whose drive is gone', () => {
    const prepare = slice('async function prepareMkvForPlayback(', '\nasync function prepareHevc')
    const branch = prepare.indexOf("streamResult.reason === 'drive-disconnected'")
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(prepare.indexOf('runLegacyRemuxIpc('))
    expect(prepare.slice(branch, branch + 200)).toContain('return { ok: false')
  })

  it('the overlay: the message, Retry bound to the library being available again, and Close', () => {
    const tpl = slice('data-testid="drive-disconnected"', '<!-- Auto-advance countdown -->')
    expect(SOURCE).toContain(
      '<div v-if="driveDisconnected" class="remux-overlay" data-testid="drive-disconnected">'
    )
    expect(tpl).toContain('{{ DRIVE_DISCONNECTED_TEXT }}')
    expect(tpl).toContain(':disabled="!driveRetryEnabled"')
    expect(tpl).toContain('@click="driveDisconnect.retry()"')
    expect(tpl).toContain(`@click="emit('close')"`)
  })

  it("the MSE composable saves through saveProgress and raises the overlay through the composable's dep", () => {
    const deps = slice('const msePlayer = useMsePlayer({', '\n});')
    expect(deps).toContain('savePosition: () => void saveProgress(true)')
    expect(deps).toContain('onDriveDisconnected: () => driveDisconnect.onMseDisconnected()')
  })

  it('an anime-video:// stall starts the check too: a 404 after the drive went away never errors', () => {
    const waiting = slice('function onWaiting(): void {', '\n}')
    expect(waiting).toContain(
      'if (activeFilePath.value && !isMkv.value) void driveDisconnect.onVideoError();'
    )
    const error = slice('function onVideoElementError(): void {', '\n}')
    expect(error).toContain(
      'if (activeFilePath.value && !isMkv.value) void driveDisconnect.onVideoError();'
    )
  })
})

describe('DriveEpisodes on an unplugged drive', () => {
  const detail: AttachedTitleDetail = {
    libraryId: 'lib-1',
    libraryName: 'Fixture library',
    animeId: 101,
    anime: {
      id: 101,
      title: 'Frieren',
      titles: {},
      posterUrlSmall: 'anime-poster://101',
      numberOfEpisodes: 1,
      type: 'tv',
      typeTitle: 'TV',
      year: 2023,
      season: 'fall'
    },
    meta: null,
    hasPoster: true,
    episodes: [
      {
        episodeInt: '1',
        episodeFull: '1 episode',
        items: [
          {
            translationId: 9001,
            translationType: 'subRu',
            author: 'Crunchyroll',
            quality: 1080,
            container: 'mp4',
            hasSubtitle: true
          }
        ]
      }
    ]
  }

  let available = false
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(window as unknown as { api: unknown }).api = {
      sharedLibraryList: vi.fn(async () => [
        { libraryId: 'lib-1', name: 'Fixture library', available, lastSeenAt: 1_000, titles: [] }
      ]),
      ffmpegCheck: vi.fn(async () => ({ available: true })),
      onSharedLibrariesChanged: () => () => {},
      onSharedLibraryFound: () => () => {},
      syncGetStatus: async () => ({ running: [], libraries: {} }),
      onSyncRunFinished: () => () => {},
      importPlan: vi.fn(async () => new Promise(() => {})),
      importListJobs: async () => [],
      onImportJobUpdated: () => () => {}
    }
  })

  it('lists the episodes from the snapshot, with Play disabled', async () => {
    available = false
    const w = mount(DriveEpisodes, { props: { title: detail } })
    await flushPromises()
    expect(w.find('[data-testid="drive-episodes-unplugged"]').text()).toBe('Drive not connected')
    const play = w.find('[data-testid="play-episode-from-drive"]')
    expect(play.attributes('disabled')).toBeDefined()
    expect(play.attributes('title')).toContain('drive not connected')
  })

  it('plugged in, Play is enabled', async () => {
    available = true
    const w = mount(DriveEpisodes, { props: { title: detail } })
    await flushPromises()
    expect(w.find('[data-testid="drive-episodes-unplugged"]').exists()).toBe(false)
    expect(w.find('[data-testid="play-episode-from-drive"]').attributes('disabled')).toBeUndefined()
  })

  it('Copy to this PC (#579) sits next to Play: off unplugged, and opens the dialog for this title', async () => {
    available = false
    const off = mount(DriveEpisodes, { props: { title: detail } })
    await flushPromises()
    expect(off.find('[data-testid="detail-copy-to-pc"]').attributes('disabled')).toBeDefined()

    setActivePinia(createPinia())
    available = true
    const w = mount(DriveEpisodes, { props: { title: detail } })
    await flushPromises()
    await w.find('[data-testid="detail-copy-to-pc"]').trigger('click')
    expect(w.findComponent(ImportDialog).props()).toEqual({ libraryId: 'lib-1', animeIds: [101] })
  })
})
