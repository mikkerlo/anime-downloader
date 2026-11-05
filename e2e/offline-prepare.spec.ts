import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertNoDownloads,
  assertUserData,
  launchApp,
  makeProfile,
  type LaunchedApp,
  type Profile
} from './helpers/profile'

/**
 * Prepare for offline (#592) on the built app, over worlds of the offline
 * scenario matrix (#659, `test/integration/offline-matrix/`), with Work offline
 * on. The matrix calls the production deps builders of steps 3 and 4
 * (`prepare-offline/wiring.ts`), but builds steps 1, 2, 5 and 6 by hand and
 * repeats `index.ts`'s step order. Case 1 here is the only check that the real
 * step order and the production wiring of all six steps match that copy: it
 * runs from Settings → General through `index.ts`, with a real ffprobe
 * (`makeProfile` links it from `PATH`), so every file it expects ok is a copy
 * of `fixtures/test-pattern.mp4`. Case 2 checks O9 on the real route, once per
 * title with a line: the line's link opens the title's page offline. The page
 * paints from `GET_ANIME_CACHE` and falls back to offline `GET_ANIME`, and both
 * answer from the title's `animeCache` entry.
 *
 * Each world is seeded as the store the matrix row leaves, so no download or
 * Delete runs here. Made-up ids and names only; `downloadDir` is inside
 * `profile.root`, so `cleanup()` removes it.
 */

const FIXTURE = path.resolve(__dirname, 'fixtures', 'test-pattern.mp4')
const DAY = 24 * 60 * 60 * 1000
const STEP_ORDER = [
  'binaries',
  'shikimori-rates',
  'metadata',
  'local-integrity',
  'attached-integrity',
  'library-sync'
]

// Nothing here needs the network: both API clients point at a closed local port.
const NO_NETWORK = {
  ANIME_DL_SMOTRET_API_BASE: 'http://127.0.0.1:9/api',
  ANIME_DL_SHIKIMORI_ORIGIN: 'http://127.0.0.1:9'
}

const record = (id: number, name: string): Record<string, unknown> => ({
  id,
  title: name,
  titles: { romaji: name },
  posterUrlSmall: '',
  numberOfEpisodes: 2,
  type: 'tv',
  typeTitle: 'TV Series',
  year: 2024,
  season: 'spring'
})

const cached = (id: number, name: string, eps: string[]): Record<string, unknown> => ({
  animeDetail: {
    ...record(id, name),
    posterUrl: '',
    descriptions: [],
    genres: [],
    episodes: eps.map((ep, i) => ({
      id: id * 100 + i,
      episodeFull: `${ep} серия`,
      episodeInt: ep,
      episodeType: 'tv',
      isActive: 1
    }))
  },
  episodes: {},
  qualityProbes: {},
  cachedAt: Date.now(),
  posterCached: false
})

const entry = (translationId: number): Record<string, unknown> => ({
  translationType: 'subRu',
  author: 'Author',
  quality: 720,
  translationId
})

/** A copy of the fixture where the player looks for `name`'s episode `ep`. */
function placeEpisode(downloads: string, name: string, ep: string): void {
  fs.mkdirSync(path.join(downloads, name), { recursive: true })
  fs.copyFileSync(
    FIXTURE,
    path.join(downloads, name, `${name} - ${ep.padStart(2, '0')} [Author].mp4`)
  )
}

function seed(prefix: string, config: (downloads: string) => Record<string, unknown>): Profile {
  const profile = makeProfile({ prefix })
  const downloads = path.join(profile.root, 'downloads')
  fs.mkdirSync(downloads)
  fs.writeFileSync(
    path.join(profile.userData, 'config.json'),
    JSON.stringify({
      playerVolume: 0,
      playerMuted: true,
      workOffline: true,
      prefetchNextEpisode: 'off',
      downloadDir: downloads,
      ...config(downloads)
    }),
    { mode: 0o600 }
  )
  return profile
}

async function withApp(profile: Profile, body: (page: Page) => Promise<void>): Promise<void> {
  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp(profile, { env: NO_NETWORK })
    await assertUserData(launched.app, profile)
    const page = await launched.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('offline-pill')).toHaveText('Offline (manual)')
    await body(page)
  } finally {
    try {
      if (launched) assertNoDownloads(launched)
    } finally {
      await launched?.app.close()
      profile.cleanup()
    }
  }
}

/** Starts a run from Settings → General and waits for it to finish. */
async function runPrepare(page: Page): Promise<Locator> {
  await page.locator('.sidebar').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('.settings-tab', { hasText: 'General' }).click()
  await page.getByTestId('prepare-offline-button').click()
  const panel = page.getByTestId('prepare-offline-panel')
  await expect(panel.getByTestId('prepare-offline-run')).toHaveText('Run again')
  return panel
}

/** The Downloaded episodes row's status and its detail texts. */
async function downloadedEpisodes(
  panel: Locator
): Promise<{ status: string | null; text: string; details: Locator }> {
  const row = panel.locator('.po-step[data-step="local-integrity"]')
  await row.getByRole('button', { name: 'Details' }).click()
  return {
    status: await row.getAttribute('data-status'),
    text: (await row.locator('.po-status').textContent()) ?? '',
    details: row.locator('.po-details li')
  }
}

test("Prepare for offline's real six steps, in index.ts's order, over S01, S10 and S14 (#659)", async () => {
  const profile = seed('anime-dl-offline-prepare-', (downloads) => {
    // S01: recorded, cached under the same name, a healthy hot file.
    placeEpisode(downloads, 'Show', '1')
    // S10: no record, a recentAnimeMeta name, watched 5 days ago, cached by an
    // earlier online step 3.
    placeEpisode(downloads, 'Watched', '1')
    // S14: what Library → Delete leaves when a file is locked: the entry and
    // the file stay, with no record, no cache and no other name source.
    placeEpisode(downloads, 'Locked Bare', '1')
    return {
      downloadedAnime: { 101: record(101, 'Show') },
      recentAnimeMeta: { 110: record(110, 'Watched') },
      animeCache: { 101: cached(101, 'Show', ['1']), 110: cached(110, 'Watched', ['1']) },
      watchProgress: {
        '110:1': { position: 600, duration: 1440, updatedAt: Date.now() - 5 * DAY }
      },
      downloadedEpisodes: {
        '101:1:1011': entry(1011),
        '110:1:1101': entry(1101),
        '114:1:1141': entry(1141)
      }
    }
  })

  await withApp(profile, async (page) => {
    const panel = await runPrepare(page)
    await expect(panel.locator('.po-step')).toHaveCount(STEP_ORDER.length)
    expect(
      await panel.locator('.po-step').evaluateAll((els) => els.map((e) => e.dataset.step))
    ).toEqual(STEP_ORDER)
    // Offline, the network steps are skipped, and with no library attached
    // steps 5 and 6 aren't available.
    for (const [id, status] of [
      ['shikimori-rates', 'skipped'],
      ['metadata', 'skipped'],
      ['attached-integrity', 'unavailable'],
      ['library-sync', 'unavailable']
    ]) {
      await expect(panel.locator(`.po-step[data-step="${id}"]`)).toHaveAttribute(
        'data-status',
        status
      )
    }

    // S14 is skipped (#657): no record and no name, so its file isn't found.
    // ffprobe read both other files, so there is no ffprobe line.
    const step = await downloadedEpisodes(panel)
    expect(step.status).toBe('ok')
    expect(step.text).toBe('Ready')
    await expect(step.details).toHaveText(['2 of 2 episodes ok'])
  })
})

// One run per launch, written that way for #675: the panel's store dropped
// every event of a run whose wall-clock `startedAt` was earlier than the run it
// held, so a clock that stepped back between two runs (an NTP correction, or
// this WSL box's ~1 s step every half minute) left the panel stuck on Cancel.
// Case 2 can go back to two runs in one launch now that #675 is fixed.
for (const { id, opens, link } of [
  { id: 'S07', opens: 'New Name', link: /^New Name episode 1:/ },
  { id: 'S17', opens: 'Away', link: /^Away episode 2:/ }
]) {
  test(`a Downloaded episodes line's link opens its title offline: ${id} (#659 O9)`, async () => {
    await linksOpenOffline(opens, link)
  })
}

async function linksOpenOffline(opens: string, link: RegExp): Promise<void> {
  let cold = ''
  const profile = seed('anime-dl-offline-prepare-links-', (downloads) => {
    cold = path.join(path.dirname(downloads), 'cold')
    // S07 (#660): the record says "Old Name", the cached details "New Name",
    // and the file is under "Old Name".
    placeEpisode(downloads, 'Old Name', '1')
    // S17 (#664): advanced mode, the cold drive unplugged with episodes 1 and 2
    // of a recorded title on it; `cold` is never created.
    return {
      storageMode: 'advanced',
      hotStorageDir: downloads,
      coldStorageDir: cold,
      downloadedAnime: { 107: record(107, 'Old Name'), 117: record(117, 'Away') },
      animeCache: { 107: cached(107, 'New Name', ['1']), 117: cached(117, 'Away', ['1', '2']) },
      downloadedEpisodes: {
        '107:1:1071': entry(1071),
        '117:1:1171': entry(1171),
        '117:2:1172': entry(1172)
      }
    }
  })
  const away = (ep: string): string =>
    `Away episode ${ep}: cold storage isn't connected (${cold}), so this episode wasn't checked`

  await withApp(profile, async (page) => {
    const panel = await runPrepare(page)
    const step = await downloadedEpisodes(panel)
    expect(step.status).toBe('warning')
    await expect(step.details.first()).toHaveText('0 of 3 episodes ok')
    // Production runs two entries at a time, so the lines come in either order.
    expect((await step.details.allTextContents()).slice(1).sort()).toEqual(
      [
        'New Name episode 1: the file is in the "Old Name" folder, but the player looks in "New Name"',
        away('1'),
        away('2')
      ].sort()
    )

    await step.details.getByRole('link', { name: link }).click()
    await expect(panel).toHaveCount(0)
    await expect(page.locator('.detail-view h1')).toHaveText(opens)
    await expect(page.getByTestId('saved-offline-badge')).toContainText('offline')
  })
}
