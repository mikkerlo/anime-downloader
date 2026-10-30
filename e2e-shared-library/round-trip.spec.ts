import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  filesUnder,
  launchInstance,
  makeClip,
  nav,
  pickNext,
  seedProfile,
  sharedTab,
  speedUpClock,
  stateDoc,
  stateGeneration,
  type Instance
} from './helpers/duo'
import { startStubs, type Stubs } from './helpers/stub-servers'

/**
 * The Shared Library story end to end, across two installs (#587, epic #563):
 * export on PC A → open on PC B, offline → watch there → bring the drive back
 * → merge on A → Shikimori ends up right.
 *
 * A is logged in as user 1001 (seeded `shikimoriUser` and credentials) and
 * starts offline; B has no account and stays offline. Shikimori and smotret
 * are local stubs (`helpers/stub-servers.ts`). The drive is a temp folder
 * renamed between A's mount parent (`ANIME_DL_MOUNT_PARENTS`) and a folder B
 * opens by hand.
 *
 * Everything B does is something a no-account claim PC may do: watch, and
 * star. It never edits a rate. Around each merge run the spec triggers, it
 * waits for S9's `sync:get-status` to be idle, reads `state.json`'s
 * `generation`, triggers the run, waits for idle again, and asserts the
 * generation went up by exactly 1. Runs it doesn't trigger (after an attach,
 * the online edge) finish before the baseline is read.
 */

const USER = { id: 1001, nickname: 'akira', avatar: '' }
const T = 5101
const T_NAME = 'Round Trip Show'
const MAL = 9101
const T2 = 5102
const T2_NAME = 'Second Trip Show'
const LIB_NAME = 'Trip (akira)'
const SECRETS = {
  access: 'e2e-access-SECRET-587',
  refresh: 'e2e-refresh-SECRET-587',
  smotret: 'e2e-smotret-SECRET-587',
  syncplay: 'e2e-syncplay-SECRET-587'
}
const FIXTURE = path.resolve(__dirname, '..', 'e2e', 'fixtures', 'test-pattern.mp4')
const CLIP_SECONDS = 45

function anime(id: number, title: string, episodes: number): Record<string, unknown> {
  return {
    id,
    title,
    titles: { romaji: title },
    posterUrlSmall: '',
    numberOfEpisodes: episodes,
    type: 'tv',
    typeTitle: 'TV Series',
    year: 2024,
    season: 'spring'
  }
}

function detailCache(id: number, title: string, malId: number | null, eps: number) {
  return {
    animeDetail: {
      ...anime(id, title, eps),
      ...(malId ? { myAnimeListId: malId } : {}),
      posterUrl: '',
      descriptions: [],
      genres: [],
      episodes: Array.from({ length: eps }, (_, i) => ({
        id: id * 10 + i + 1,
        episodeFull: `${i + 1} серия`,
        episodeInt: String(i + 1),
        episodeType: 'tv',
        isActive: 1
      }))
    },
    episodes: {},
    qualityProbes: {},
    cachedAt: Date.now() - 3_600_000,
    posterCached: false
  }
}

const conflictsOf = (pc: Instance): { animeId: string; fieldPath: string }[] => {
  const f = path.join(pc.profile.userData, 'sync-state', 'conflicts.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).records : []
}

const watchRow = (pc: Instance, ep: number): Record<string, any> | undefined =>
  (pc.config().watchProgress as Record<string, Record<string, any>> | undefined)?.[`${T}:${ep}`]

/** Opens an episode of T from the drive on B and plays it past the watched rule. */
async function playToWatched(b: Instance, ep: number): Promise<void> {
  const page = b.page
  const before = watchRow(b, ep)?.sync?.watched?.at ?? 0
  await sharedTab(page)
  await page.getByTestId('drive-title').filter({ hasText: T_NAME }).locator('.acard').click()
  const detail = page.getByTestId('attached-detail')
  await expect(detail).toBeVisible()
  const row = detail
    .locator('.drive-row')
    .filter({ has: page.locator('.ep-label', { hasText: `${ep} серия` }) })
  const clock = await speedUpClock(page, 6)
  try {
    await row.getByTestId('play-episode-from-drive').click()
    const video = page.locator('video').first()
    await expect
      .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2)
    await video.evaluate((v) => (v as HTMLVideoElement).play())
    // Watched: 80% of the clip, and 180 s of (sped-up) playback.
    await expect
      .poll(
        () => {
          const r = watchRow(b, ep)
          return !!r?.watched && (r.sync?.watched?.at ?? 0) > before
        },
        { timeout: 90_000, intervals: [1000] }
      )
      .toBe(true)
  } finally {
    await page
      .locator('.close-btn')
      .first()
      .click()
      .catch(() => {})
    await clock.restore()
  }
  await expect(page.locator('video')).toHaveCount(0)
}

/**
 * Runs `trigger` and asserts the drive's state generation went up by exactly 1.
 * `from` is where the drive is before the trigger, when it moves.
 */
async function oneWrite(
  pc: Instance,
  root: string,
  trigger: () => Promise<void>,
  from = root
): Promise<void> {
  await pc.syncIdle()
  const before = await stateGeneration(from)
  await trigger()
  await expect
    .poll(() => stateGeneration(root), { timeout: 30_000 })
    .toBeGreaterThan(before)
    .catch((err: Error) => {
      throw new Error(`${err.message}\n--- ${pc.name} ---\n${pc.log.join('\n')}`)
    })
  await pc.syncIdle()
  expect(await stateGeneration(root)).toBe(before + 1)
}

async function syncNow(page: Page): Promise<void> {
  await sharedTab(page)
  await page.getByTestId('sync-now').click()
}

test('export on A → watch on B offline → merge back on A → Shikimori ends up right', async () => {
  test.setTimeout(8 * 60_000)
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anime-dl-shared-e2e-')))
  const mountsA = path.join(base, 'mountsA')
  const stickA = path.join(mountsA, 'STICK')
  const deskB = path.join(base, 'pc-b-desk')
  const mountsB = path.join(base, 'mountsB')
  for (const d of [stickA, deskB, mountsB]) fs.mkdirSync(d, { recursive: true })
  const rootA = path.join(stickA, LIB_NAME)
  const rootB = path.join(deskB, LIB_NAME)

  const t0 = Date.now() - 3_600_000
  let stubs: Stubs | undefined
  let a: Instance | undefined
  let b: Instance | undefined
  try {
    stubs = await startStubs({
      user: USER,
      anime: [{ malId: MAL, name: T_NAME, episodes: 3 }],
      rates: [
        { id: 7001, target_id: MAL, episodes: 1, status: 'watching', score: 6, rewatches: 0 }
      ],
      at: t0
    })
    const env = (mounts: string): Record<string, string> => ({
      ANIME_DL_SHIKIMORI_ORIGIN: stubs!.origin,
      ANIME_DL_SMOTRET_API_BASE: stubs!.smotretBase,
      ANIME_DL_MOUNT_PARENTS: mounts
    })

    // ── 1. A: T (episodes 1–3) and T2 downloaded, episode 1 watched, logged in.
    const profileA = seedProfile(base, 'a', {})
    const downloads = path.join(profileA.root, 'downloads')
    const file = (title: string, ep: number): string =>
      path.join(downloads, title, `${title} - 0${ep} [Studio].mp4`)
    makeClip(file(T_NAME, 1), CLIP_SECONDS)
    makeClip(file(T_NAME, 2), CLIP_SECONDS)
    fs.copyFileSync(FIXTURE, file(T_NAME, 3))
    fs.mkdirSync(path.join(downloads, T2_NAME), { recursive: true })
    fs.copyFileSync(FIXTURE, file(T2_NAME, 1))
    const episode = { translationType: 'subRu', author: 'Studio', quality: 720, translationId: 91 }
    const serverAt = new Date(t0).toISOString()
    fs.writeFileSync(
      path.join(profileA.userData, 'config.json'),
      JSON.stringify({
        playerVolume: 0,
        playerMuted: true,
        playerMode: 'builtin',
        prefetchNextEpisode: 'off',
        workOffline: true,
        installId: 'pc-a',
        downloadDir: downloads,
        token: SECRETS.smotret,
        syncplayPassword: SECRETS.syncplay,
        shikimoriUser: USER,
        shikimoriCredentials: {
          access_token: SECRETS.access,
          refresh_token: SECRETS.refresh,
          token_type: 'Bearer',
          created_at: Math.floor(Date.now() / 1000),
          expires_in: 30 * 86400,
          scope: 'user_rates'
        },
        shikimoriUserRates: [
          {
            rate: {
              id: 7001,
              target_id: MAL,
              episodes: 1,
              status: 'watching',
              score: 6,
              rewatches: 0,
              updated_at: serverAt,
              serverUpdatedAt: serverAt
            },
            shikiAnime: { id: MAL, name: T_NAME },
            smotretAnime: anime(T, T_NAME, 3)
          }
        ],
        malIdMap: { [MAL]: { id: T, title: T_NAME } },
        downloadedAnime: { [T]: anime(T, T_NAME, 3), [T2]: anime(T2, T2_NAME, 1) },
        downloadedEpisodes: {
          [`${T}:1:91`]: episode,
          [`${T}:2:91`]: episode,
          [`${T}:3:91`]: episode,
          [`${T2}:1:91`]: episode
        },
        animeCache: {
          [T]: detailCache(T, T_NAME, MAL, 3),
          [T2]: detailCache(T2, T2_NAME, null, 1)
        },
        watchProgress: {
          [`${T}:1`]: {
            position: 0,
            duration: CLIP_SECONDS,
            updatedAt: t0,
            watched: true,
            watchedAt: t0
          }
        }
      }),
      { mode: 0o600 }
    )
    a = await launchInstance('A', profileA, env(mountsA))
    const pageA = a.page

    await test.step('1. A exports With metadata to the drive, and opens it', async () => {
      await nav(pageA, 'Library')
      await pageA.getByTestId('library-select-toggle').click()
      await pageA.locator('.library-view .acard', { hasText: T_NAME }).click()
      await pageA.locator('.library-view .acard', { hasText: T2_NAME }).click()
      await pageA.getByTestId('library-export-selected').click()
      const dialog = pageA.getByTestId('export-dialog')
      await dialog.getByTestId('export-mode-metadata').check()
      await dialog.getByTestId('export-name').fill(LIB_NAME)
      await pickNext(a!.app, stickA)
      await dialog.getByTestId('export-pick').click()
      await expect(dialog.getByTestId('export-target-line')).toHaveText(`New library '${LIB_NAME}'`)
      await dialog.getByTestId('export-start').click()
      await expect(dialog).toHaveCount(0)
      await nav(pageA, 'Downloads')
      await expect(pageA.getByTestId('export-job-completed')).toContainText(
        `Exported to ${LIB_NAME} — 4 / 4 files`,
        { timeout: 60_000 }
      )
      const doc = await stateDoc(rootA)
      expect(doc.titles[String(T)].watch?.['1'].watched.value).toBe(true)
      expect(doc.titles[String(T)].rate).toMatchObject({
        episodes: { value: 1 },
        status: { value: 'watching' },
        score: { value: 6 }
      })

      // The owner attaches it, so the drive's comings and goings reach A's merge.
      await nav(pageA, 'Library')
      await pickNext(a!.app, stickA)
      await pageA.locator('.library-view').getByTestId('open-shared-library').click()
      await pageA.getByTestId('show-library').click()
      await expect(pageA.getByTestId('role-badge')).toHaveText('Owner')
      await a!.syncIdle()
    })

    await test.step('the drive leaves A', async () => {
      fs.renameSync(rootA, rootB)
      await a!.pollNow()
      await expect(pageA.getByTestId('availability-dot')).toHaveAttribute(
        'data-available',
        'false',
        { timeout: 15_000 }
      )
    })

    // ── 2. B: a fresh profile, offline, no account.
    const profileB = seedProfile(base, 'b', { workOffline: true, installId: 'pc-b' })
    b = await launchInstance('B', profileB, env(mountsB))
    const pageB = b.page

    await test.step('2. B claims the library, watches, re-watches, stars, and syncs', async () => {
      await nav(pageB, 'Library')
      await pickNext(b!.app, deskB)
      await pageB.locator('.library-view').getByTestId('open-shared-library').click()
      await expect(pageB.getByTestId('identity-warning')).toContainText(
        `This library belongs to ${USER.nickname}`
      )
      await pageB.getByTestId('use-as-owner').click()
      await pageB.getByTestId('confirm-claim').click()
      await pageB.getByTestId('show-library').click()
      await expect(pageB.getByTestId('role-badge')).toHaveText('Claimed')
      // The attach run brings A's state in, and stores B's library base.
      await b!.syncIdle()
      await expect.poll(() => watchRow(b!, 1)?.watched).toBe(true)

      await playToWatched(b!, 2)
      // A re-watch: the row stays watched, and its clock moves past the base's.
      await playToWatched(b!, 1)

      await sharedTab(pageB)
      await pageB
        .getByTestId('drive-title')
        .filter({ hasText: T2_NAME })
        .locator('.star-btn')
        .click()
      await expect
        .poll(() => Object.keys((b!.config().library as object | undefined) ?? {}))
        .toContain(String(T2))

      await oneWrite(b!, rootB, () => syncNow(pageB))
      const doc = await stateDoc(rootB)
      expect(doc.titles[String(T)].watch?.['2'].watched.value).toBe(true)
      expect(doc.titles[String(T2)].starred?.value).toBe(true)
      // A claim PC never edits a rate, and never queues one.
      expect(doc.titles[String(T)].rate?.score.value).toBe(6)
      expect(b!.config().shikimoriUpdateQueue ?? []).toEqual([])
    })
    await b.close()
    b = undefined

    // ── 3. A, offline: score 7 (queued) and an explicit unwatch of episode 1.
    await test.step('3. A rates T at 7 and unwatches episode 1, offline', async () => {
      await nav(pageA, 'Library')
      await pageA.locator('.library-view .pill-tab', { hasText: 'All' }).click()
      await pageA.locator('.library-view .acard', { hasText: T_NAME }).click()
      await expect(pageA.locator('.detail-view h1')).toHaveText(T_NAME)
      await pageA.locator('.score-pick button', { hasText: /^7$/ }).click()
      await pageA.locator('.sk-save-btn').click()
      await expect
        .poll(() => a!.config().shikimoriUpdateQueue)
        .toEqual([
          expect.objectContaining({ malId: MAL, after: expect.objectContaining({ score: 7 }) })
        ])
      await pageA
        .locator('.ep-row', { hasText: '1 серия' })
        .getByRole('button', { name: 'Mark as unwatched' })
        .click()
      await expect.poll(() => watchRow(a!, 1)?.watched).toBe(false)
    })

    // ── 4. The drive comes back to A: the poller sees it, and the merge runs.
    await test.step("4. the drive returns to A: B's changes merge, episode 1 is held", async () => {
      await sharedTab(pageA)
      await oneWrite(
        a!,
        rootA,
        async () => {
          fs.renameSync(rootB, rootA)
          await a!.pollNow()
        },
        rootB
      )
      // The run's toast (8 s) offers Review (S10 #585).
      await expect(pageA.getByTestId('sync-toast')).toContainText('1 needs your input')
      await expect(pageA.getByTestId('sync-toast-review')).toBeVisible()
      await expect(pageA.getByTestId('availability-dot')).toHaveAttribute('data-available', 'true')
      // local ↔ library: B's episode 2 and star come in. (The store reaches
      // `config.json` on a 500 ms coalescing timer, hence the polls.)
      await expect.poll(() => watchRow(a!, 2)?.watched).toBe(true)
      await expect
        .poll(() => Object.keys((a!.config().library as object | undefined) ?? {}))
        .toContain(String(T2))
      // Episode 1: unwatched here, re-watched on B after the base. Held, neither side changed.
      expect(conflictsOf(a!)).toEqual([
        expect.objectContaining({ animeId: String(T), fieldPath: 'watch.1.watched' })
      ])
      expect(watchRow(a!, 1)?.watched).toBe(false)
      const doc = await stateDoc(rootA)
      expect(doc.titles[String(T)].watch?.['1'].watched.value).toBe(true)
      // The score is A's alone; the raise from B's episode 2 reaches the drive too.
      expect(doc.titles[String(T)].rate).toMatchObject({
        episodes: { value: 2 },
        status: { value: 'watching' },
        score: { value: 7 }
      })

      // Online: the queue drains to the stub. Only the final rate is asserted.
      await pageA.getByTestId('offline-pill').click()
      await expect
        .poll(() => stubs!.rate(MAL), { timeout: 30_000 })
        .toMatchObject({ episodes: 2, score: 7, status: 'watching' })
      await expect.poll(() => a!.config().shikimoriUpdateQueue ?? []).toEqual([])
      await a!.syncIdle()
    })

    // ── 5. Review from the toast: Keep mine (unwatched).
    await test.step('5. Keep mine: episode 1 unwatched everywhere, no decrement to Shikimori', async () => {
      const writes = (): string[] =>
        stubs!.calls.filter((c) => c.startsWith('PATCH') || c.startsWith('POST'))
      const writesBefore = writes().length
      await oneWrite(a!, rootA, async () => {
        await syncNow(pageA)
        const toast = pageA.getByTestId('sync-toast')
        await expect(toast).toContainText('1 needs your input')
        await toast.getByTestId('sync-toast-review').click()
        const sheet = pageA.getByTestId('conflict-review-sheet')
        await expect(sheet.getByTestId('review-title')).toHaveText('Needs your input (1)')
        const row = sheet.getByTestId('conflict-row')
        await expect(row).toHaveAttribute('data-field', 'watch.1.watched')
        await row.locator('[data-choice="party:local"] input').check()
        await sheet.getByTestId('apply-picked').click()
        await expect(sheet.getByTestId('review-empty')).toBeVisible()
        await pageA.getByRole('button', { name: 'Close' }).click()
        // The follow-up merge: S10's resolve already wrote the drive, so it writes nothing.
        await a!.syncIdle()
        await syncNow(pageA)
      })
      await expect.poll(() => watchRow(a!, 1)?.watched).toBe(false)
      expect((await stateDoc(rootA)).titles[String(T)].watch?.['1'].watched.value).toBe(false)
      expect(conflictsOf(a!)).toEqual([])
      await expect(
        pageA
          .locator('.library-view .pill-tab', { hasText: 'Shared Libraries' })
          .getByTestId('conflict-badge')
      ).toHaveCount(0)
      await expect.poll(() => a!.config().shikimoriUpdateQueue ?? []).toEqual([])
      expect(stubs!.rate(MAL)).toMatchObject({ episodes: 2, score: 7, status: 'watching' })
      expect(writes()).toHaveLength(writesBefore)
    })

    await test.step('6. on disk: no secret on the drive, and the sync log', async () => {
      for (const f of filesUnder(rootA)) {
        const bytes = fs.readFileSync(f)
        for (const s of [
          ...Object.values(SECRETS),
          'shikimoriCredentials',
          'syncplayPassword',
          'access_token',
          'refresh_token'
        ]) {
          expect(bytes.includes(Buffer.from(s)), `${s} in ${path.relative(rootA, f)}`).toBe(false)
        }
      }
      const logDir = path.join(a!.profile.userData, 'sync-log')
      const records = fs
        .readdirSync(logDir)
        .flatMap((f) => fs.readFileSync(path.join(logDir, f), 'utf8').split('\n'))
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, any>)
        .sort((x, y) => x.at - y.at)
      const held = records.findIndex(
        (r) =>
          r.kind === 'run' &&
          (r.conflicts as { animeId: string; fieldPath: string }[]).some(
            (c) => c.animeId === String(T) && c.fieldPath === 'watch.1.watched'
          )
      )
      expect(held).toBeGreaterThanOrEqual(0)
      expect(
        records
          .slice(held + 1)
          .some(
            (r) =>
              r.kind === 'resolution' &&
              r.animeId === String(T) &&
              r.fieldPath === 'watch.1.watched' &&
              r.value === false
          )
      ).toBe(true)
    })
  } catch (err) {
    for (const pc of [a, b]) {
      await pc?.page
        .screenshot({ path: test.info().outputPath(`pc-${pc.name}.png`) })
        .catch(() => {})
      if (pc) console.log(`--- ${pc.name} main log ---\n${pc.log.join('\n')}`)
      if (pc)
        console.log(
          `--- ${pc.name} watchProgress ---\n${JSON.stringify(pc.config().watchProgress)}`
        )
    }
    throw err
  } finally {
    await b?.close().catch(() => {})
    await a?.close()
    await stubs?.close()
    fs.rmSync(base, { recursive: true, force: true })
  }
})
