import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {
  assertNoDownloads,
  assertUserData,
  launchApp,
  makeProfile,
  type LaunchedApp
} from './helpers/profile'
import { createLibrary, writeState } from '../src/main/lib/shared-library/write'
import { readLibrary } from '../src/main/lib/shared-library/read'

/**
 * The review sheet (#585) on the built app. An owned library and this PC
 * agree on score 8 (a library result still pending for Shikimori); shikimori.one
 * has 9; both bases are 7. Sync now holds the Shikimori-side conflict, the toast
 * offers Review, and Keep mine queues an entry with `resolvedFields: ['score']`.
 * The badge on the Shared Libraries tab clears.
 *
 * Shikimori is a local stub (`ANIME_DL_SHIKIMORI_ORIGIN`); smotret-anime.ru is
 * pointed at it too, so nothing leaves the machine. The stub answers the
 * drain's read with a 503 once the choice is made, so the entry stays queued
 * where the spec can read it.
 */
const OWNER = { id: 4242, nickname: 'owner', avatar: '' }
const ANIME = 101
const MAL = 9001
const LIB = '3b0e7a52-5c1f-4d8e-9a6b-2f4c8d1e7a90'
const T = Date.UTC(2026, 9, 1)
const iso = (t: number): string => new Date(t).toISOString()

test('a held Shikimori-side score conflict: Review from the toast, Keep mine queues resolvedFields [score], the badge clears', async () => {
  const row = { id: MAL * 10, episodes: 3, status: 'watching', score: 9, rewatches: 0 }
  const calls: string[] = []
  let holdDrain = false
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    req.resume()
    req.on('end', () => {
      const json = (code: number, v: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(v))
      }
      calls.push(`${req.method} ${url.pathname}`)
      if (url.pathname === `/api/users/${OWNER.id}/anime_rates`) {
        return json(200, [
          {
            ...row,
            updated_at: iso(T + 5000),
            target_type: 'Anime',
            anime: { id: MAL, name: 'Frieren', russian: '', episodes: 28, kind: 'tv' }
          }
        ])
      }
      if (url.pathname === '/api/v2/user_rates' && req.method === 'GET') {
        if (holdDrain) return json(503, { message: 'held by the spec' })
        return json(200, [{ ...row, target_id: MAL, target_type: 'Anime' }])
      }
      if (url.pathname === '/api/users/whoami') return json(200, OWNER)
      return json(404, { message: 'stub' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port

  const creds = {
    access_token: 'a',
    refresh_token: 'r',
    token_type: 'Bearer',
    created_at: Math.floor(Date.now() / 1000),
    expires_in: 30 * 86400,
    scope: 'user_rates'
  }
  const smotretAnime = {
    id: ANIME,
    title: 'Frieren',
    titles: {},
    posterUrlSmall: '',
    numberOfEpisodes: 28,
    type: 'tv',
    typeTitle: 'TV',
    year: 2023,
    season: ''
  }
  const profile = makeProfile({
    prefix: 'anime-dl-shared-review-',
    config: {
      prefetchNextEpisode: 'off',
      installId: 'pc-e2e',
      shikimoriUser: OWNER,
      shikimoriCredentials: creds,
      shikimoriUserRates: [
        {
          rate: {
            id: row.id,
            target_id: MAL,
            episodes: 3,
            status: 'watching',
            score: 8,
            rewatches: 0,
            updated_at: iso(T),
            serverUpdatedAt: iso(T)
          },
          shikiAnime: { id: MAL, name: 'Frieren' },
          smotretAnime
        }
      ],
      malIdMap: { [MAL]: { id: ANIME, title: 'Frieren' } }
    }
  })
  const mounts = path.join(profile.root, 'mounts')
  const root = path.join(mounts, 'DRIVE', 'Lib')
  fs.mkdirSync(path.dirname(root), { recursive: true })
  const actor = {
    installId: 'pc-export',
    appVersion: '5.0.0',
    shikimoriUserId: OWNER.id,
    claim: null
  }
  await createLibrary(
    root,
    {
      libraryId: LIB,
      name: 'Drive',
      owner: { shikimoriId: OWNER.id, nickname: OWNER.nickname },
      mode: 'metadata',
      titles: [{ animeId: ANIME, name: 'Frieren' }],
      items: [],
      naming: { rule: 'v1', renamed: [] }
    },
    actor
  )
  const field = <T>(value: T, at: number, origin = 'pc-export') => ({ value, at, origin })
  const rate = (score: number, at: number, origin?: string) => ({
    malId: MAL,
    episodes: field(3, at, origin),
    status: field('watching', at, origin),
    score: field(score, at, origin),
    rewatches: field(0, at, origin)
  })
  const doc = (score: number, at: number, origin?: string) => ({
    stateVersion: 1,
    stateMinor: 0,
    installId: 'pc-export',
    titles: { [ANIME]: { rate: rate(score, at, origin) } },
    priorityOrder: { value: [], at: 0, origin: 'legacy' },
    tombstones: {}
  })
  await writeState(root, doc(8, T + 100) as never, actor, null)
  const read = await readLibrary(root)
  if (read.status !== 'ok') throw new Error('fixture library unreadable')
  const bases = path.join(profile.userData, 'sync-bases')
  fs.mkdirSync(bases, { recursive: true })
  const base = (party: string, stateGeneration: number | null, d: unknown) =>
    fs.writeFileSync(
      path.join(bases, `${party}.json`),
      JSON.stringify({ baseVersion: 1, party, stateGeneration, doc: d })
    )
  base(`library-${LIB}`, read.manifest.stateGeneration, doc(8, T + 100))
  base(`shikimori-${OWNER.id}`, null, doc(7, T, 'shikimori'))
  // The library's 8, merged here earlier and not yet pushed.
  fs.mkdirSync(path.join(profile.userData, 'sync-pending'))
  fs.writeFileSync(
    path.join(profile.userData, 'sync-pending', `${OWNER.id}.json`),
    JSON.stringify({
      version: 1,
      ownerId: OWNER.id,
      rates: {
        [MAL]: {
          score: {
            value: 8,
            clock: { at: T + 100, origin: 'pc-export' },
            provenance: { libraryId: LIB },
            prePatch: { value: 7, serverUpdatedAt: iso(T) }
          }
        }
      }
    })
  )
  const config = JSON.parse(fs.readFileSync(path.join(profile.userData, 'config.json'), 'utf8'))
  config.attachedLibraries = {
    [LIB]: {
      root,
      name: 'Drive',
      mode: 'metadata',
      owner: { shikimoriId: OWNER.id, nickname: OWNER.nickname },
      access: 'read-write',
      lastSeenAt: T,
      lastSyncAt: null
    }
  }
  fs.writeFileSync(path.join(profile.userData, 'config.json'), JSON.stringify(config), {
    mode: 0o600
  })
  const queue = (): Record<string, unknown>[] =>
    JSON.parse(fs.readFileSync(path.join(profile.userData, 'config.json'), 'utf8'))
      .shikimoriUpdateQueue ?? []

  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp(profile, {
      env: {
        ANIME_DL_SHIKIMORI_ORIGIN: `http://127.0.0.1:${port}`,
        ANIME_DL_SMOTRET_API_BASE: `http://127.0.0.1:${port}/smotret`,
        ANIME_DL_MOUNT_PARENTS: mounts
      }
    })
    const { app } = launched
    await assertUserData(app, profile)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    await page.locator('.sidebar').getByRole('button', { name: 'Library', exact: true }).click()
    const tab = page.locator('.pill-tab', { hasText: 'Shared Libraries' })
    await tab.click()
    await page.getByTestId('sync-now').click()

    const toast = page.getByTestId('sync-toast')
    await expect(toast).toContainText('1 needs your input', { timeout: 30_000 })
    await expect(tab.getByTestId('conflict-badge')).toHaveText('1')
    await toast.getByTestId('sync-toast-review').click()

    const sheet = page.getByTestId('conflict-review-sheet')
    await expect(sheet.getByTestId('review-title')).toHaveText('Needs your input (1)')
    const row = sheet.getByTestId('conflict-row')
    await expect(row.getByTestId('col-shikimori')).toHaveAttribute('data-involved', 'true')
    await expect(row.getByTestId('col-shikimori')).toContainText('★ 9')
    await expect(row.getByTestId('col-library')).toContainText('★ 8')
    await expect(row.getByTestId('col-local')).toContainText('★ 8')

    holdDrain = true
    await row.locator('[data-choice="party:local"] input').check()
    await sheet.getByTestId('apply-picked').click()
    await expect(sheet.getByTestId('review-empty'))
      .toBeVisible()
      .catch(async (err: Error) => {
        throw new Error(`${err.message}\n--- sheet ---\n${await sheet.innerText()}`)
      })

    await expect
      .poll(() => queue().find((q) => q.malId === MAL) ?? null, { timeout: 15_000 })
      .toMatchObject({ fields: ['score'], resolvedFields: ['score'], after: { score: 8 } })
    await page.getByRole('button', { name: 'Close' }).click()
    await expect(tab.getByTestId('conflict-badge')).toHaveCount(0)
    expect(calls.filter((c) => c.startsWith('PATCH'))).toEqual([])
  } finally {
    try {
      if (launched) assertNoDownloads(launched)
    } finally {
      await launched?.app.close()
      profile.cleanup()
      server.close()
    }
  }
})
