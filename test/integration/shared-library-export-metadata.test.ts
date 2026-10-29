// Export With metadata (#586), end to end in temp dirs: the real export
// service and job, S5's reader and writer, and S9's runner (`runExport`) as
// the state step, on one in-memory store. The kills are a state step that
// never returns (between the copy and the state write) and a throw in the
// base's rename (between `state.json` and the base).

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { itemKey } from '../../src/main/lib/shared-library/format'
import { LIBRARY_DIR, readLibrary } from '../../src/main/lib/shared-library/read'
import { NotOwnerError, writeManifest, writeState } from '../../src/main/lib/shared-library/write'
import {
  JOBS_DIR,
  type SharedLibraryExportDeps
} from '../../src/main/services/shared-library-export'
import { nodeFs, type ExportFs } from '../../src/main/services/shared-library-export/copy'
import { createSyncRunner, type SyncRunner } from '../../src/main/services/sync-runner'
import {
  CLAIMED_TARGET,
  LOG_IN_FOR_METADATA,
  takeoverUnconfirmed
} from '../../src/shared/shared-library-export'
import {
  makeExportEnv,
  scan,
  seedLibrary,
  sel,
  type ExportEnv
} from '../helpers/shared-library-export'

const ME = { id: 4242, nickname: 'akira', avatar: '' }
const FRIEND: SharedLibraryOwner = { shikimoriId: 777, nickname: 'friend' }
const OTHER_LIB = '9c2d4e6f-1a3b-4c5d-8e7f-0a1b2c3d4e5f'
const T0 = Date.now() - 3_600_000
const SECRETS = ['tok-SECRET-1', 'acc-SECRET-2', 'ref-SECRET-3', 'sp-SECRET-4']

const row = (watched: boolean, at: number, position: number) => ({
  position,
  duration: 1440,
  updatedAt: at,
  watched,
  ...(watched ? { watchedAt: at } : {}),
  sync: { position: { at, origin: 'pc-export' }, watched: { at, origin: 'pc-export' } }
})

interface Rig {
  env: ExportEnv
  runner: SyncRunner
  /** Source files read for a copy: a re-copy shows here. */
  copies: { n: number }
  a1: string
  a2: string
  b1: string
  c1: string
}

const rigs: Rig[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const r of rigs.splice(0)) r.env.cleanup()
})

/**
 * A PC logged in as ME (unless `user`), with episodes of 101, 202 and 303 and
 * local watch state for all three; 303 is never exported.
 */
function rig(
  opts: {
    user?: typeof ME | null
    store?: Record<string, unknown>
    deps?: Partial<SharedLibraryExportDeps>
  } = {}
): Rig {
  // The runner needs the env's store, and the env needs the runner's leg.
  const late: { runner?: SyncRunner } = {}
  const copies = { n: 0 }
  const roots: string[] = []
  const xfs: Partial<ExportFs> = {
    createReadStream: (p) => {
      if (roots.some((r) => p.startsWith(r + path.sep))) copies.n++
      return nodeFs.createReadStream(p)
    }
  }
  const env = makeExportEnv(
    { xfs, writeLibraryState: (t) => late.runner!.runExport(t), ...opts.deps },
    { shikimoriUser: opts.user === undefined ? ME : opts.user }
  )
  roots.push(env.hot, env.cold)
  const add = (animeId: number, title: string, ep: string, tid: number): string =>
    env.addEpisode({ animeId, title, episodeInt: ep, translationId: tid }).key
  const a1 = add(101, 'Alpha Show', '1', 11)
  const a2 = add(101, 'Alpha Show', '2', 12)
  const b1 = add(202, 'Beta Show', '1', 21)
  const c1 = add(303, 'Gamma Show', '1', 31)
  const seed: Record<string, unknown> = {
    installId: 'pc-export',
    watchProgress: {
      '101:1': row(true, T0, 1400),
      '202:1': row(false, T0, 300),
      '303:1': row(true, T0, 1400)
    },
    priorityAnimeIds: [],
    dismissedContinueWatching: [],
    skipDetections: {},
    syncMeta: { titles: {}, rates: {} },
    attachedLibraries: {},
    shikimoriCredentials: { access_token: 'a', refresh_token: 'r', token_type: 'Bearer' },
    shikimoriUpdateQueue: [],
    shikimoriUserRates: [101, 303].map((id) => ({
      rate: {
        id: id * 100,
        target_id: 9000 + id,
        episodes: 1,
        status: 'watching',
        score: 7,
        rewatches: 0,
        updated_at: new Date(T0).toISOString(),
        serverUpdatedAt: new Date(T0).toISOString()
      },
      shikiAnime: { id: 9000 + id },
      smotretAnime: { id }
    })),
    malIdMap: {},
    ...opts.store
  }
  for (const [k, v] of Object.entries(seed)) env.store.set(k, v)
  const runner = createSyncRunner({
    store: env.store as never,
    userDataDir: env.userData,
    attached: {
      list: () => [],
      get: () => undefined,
      refresh: async () => {},
      reportWriteFailure: () => false,
      markSynced: () => {},
      registerForgetHook: () => () => {},
      onAvailabilityChanged: () => () => {}
    } as never,
    sync: {
      drainNow: async () => {},
      withQueueLock: async <T>(fn: () => Promise<T>) => fn(),
      onItemSettled: () => () => {},
      syncShikimoriQueue: async () => {},
      startSyncTimer: () => {}
    } as never,
    isOffline: () => true,
    broadcast: () => {},
    appVersion: '5.0.47',
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  })
  late.runner = runner
  const r = { env, runner, copies, a1, a2, b1, c1 }
  rigs.push(r)
  return r
}

async function startMeta(
  r: Rig,
  keys: string[],
  name = 'Trip',
  extra: Partial<ExportStartRequest> = {}
): Promise<ExportJobView> {
  const res = await r.env.svc.start({
    selection: sel(...keys),
    target: r.env.drive,
    name,
    mode: 'metadata',
    ...extra
  })
  if (!res.ok) throw new Error(`start refused: ${res.reason}`)
  await r.env.svc.settled(res.job.jobId)
  return r.env.svc.list().find((j) => j.jobId === res.job.jobId)!
}

async function pairOf(root: string) {
  const r = await readLibrary(root)
  if (r.status !== 'ok') throw new Error(`library at ${root} is ${r.status}`)
  return r
}

function baseOf(
  r: Rig,
  libraryId: string
): { stateGeneration: number | null; doc: SyncDoc } | null {
  const file = path.join(r.env.userData, 'sync-bases', `library-${libraryId}.json`)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

function jobFile(r: Rig, jobId: string): { phase?: ExportJobPhase; status: ExportJobStatus } {
  return JSON.parse(fs.readFileSync(path.join(r.env.userData, JOBS_DIR, `${jobId}.json`), 'utf8'))
}

/** The drive's doc and the base's, minus the doc envelope's version pair. */
const docBody = (doc: object): object => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { stateVersion, stateMinor, ...rest } = doc as Record<string, unknown>
  return rest
}

async function expectPairedWithBase(r: Rig, root: string): Promise<number> {
  const p = await pairOf(root)
  expect(p.state).not.toBeNull()
  expect(p.stateInitialized).toBe(true)
  expect(p.manifest.stateGeneration).toBe(p.state!.generation)
  expect(p.state!.manifestGeneration).toBe(p.manifest.generation)
  const base = baseOf(r, p.manifest.libraryId)
  expect(base?.stateGeneration).toBe(p.state!.generation)
  expect(docBody(base!.doc)).toEqual(docBody(p.state!.doc))
  return p.state!.generation
}

const localState = (r: Rig): string =>
  JSON.stringify(
    [
      'watchProgress',
      'library',
      'priorityAnimeIds',
      'dismissedContinueWatching',
      'skipDetections',
      'syncMeta',
      'shikimoriUserRates',
      'shikimoriUpdateQueue'
    ].map((k) => r.env.store.get(k))
  )

describe('With metadata: what leaves this PC', () => {
  it('state.json covers exactly titles[], is owned by this user, pairs with its base, and goes up by one per export', async () => {
    const r = rig()
    const root = path.join(r.env.drive, 'Trip')
    const job = await startMeta(r, [r.a1, r.a2])
    expect(job).toMatchObject({ status: 'completed', mode: 'metadata', phase: 'done' })

    const p1 = await pairOf(root)
    expect(p1.manifest).toMatchObject({
      mode: 'metadata',
      owner: { shikimoriId: ME.id, nickname: ME.nickname }
    })
    expect(p1.manifest.titles.map((t) => t.animeId)).toEqual([101])
    // 202 and 303 are watched here too, but not in titles[].
    expect(Object.keys(p1.state!.doc.titles ?? {})).toEqual(['101'])
    expect(p1.state!.doc.titles!['101'].watch!['1'].watched.value).toBe(true)
    expect(p1.state!.doc.titles!['101'].rate?.status.value).toBe('watching')
    const g1 = await expectPairedWithBase(r, root)

    await startMeta(r, [r.b1])
    const p2 = await pairOf(root)
    expect(p2.manifest.libraryId).toBe(p1.manifest.libraryId)
    expect(p2.manifest.titles.map((t) => t.animeId)).toEqual([101, 202])
    expect(Object.keys(p2.state!.doc.titles ?? {}).sort()).toEqual(['101', '202'])
    expect(p2.state!.doc.titles!['202'].watch!['1'].position.value.position).toBe(300)
    expect(await expectPairedWithBase(r, root)).toBe(g1 + 1)
  })

  it('a title with no watch state here still ends with a state.json and its base', async () => {
    const r = rig()
    const d1 = r.env.addEpisode({
      animeId: 404,
      title: 'Delta Show',
      episodeInt: '1',
      translationId: 41
    }).key
    const root = path.join(r.env.drive, 'Trip')
    const job = await startMeta(r, [d1])
    expect(job).toMatchObject({ status: 'completed', phase: 'done' })
    expect(fs.existsSync(path.join(root, LIBRARY_DIR, 'state.json'))).toBe(true)
    await expectPairedWithBase(r, root)
  })

  it('no file under the library holds the token, the Shikimori credentials or the Syncplay password', async () => {
    const r = rig({
      store: {
        token: SECRETS[0],
        shikimoriCredentials: {
          access_token: SECRETS[1],
          refresh_token: SECRETS[2],
          token_type: 'Bearer'
        },
        syncplayPassword: SECRETS[3]
      }
    })
    const root = path.join(r.env.drive, 'Trip')
    await startMeta(r, [r.a1, r.b1])
    expect((await pairOf(root)).state).not.toBeNull()
    const files = Object.keys(scan(root))
    expect(files).toContain(path.join(LIBRARY_DIR, 'state.json'))
    for (const rel of files) {
      const bytes = fs.readFileSync(path.join(root, rel))
      for (const s of SECRETS) expect(bytes.includes(s), `${rel} holds ${s}`).toBe(false)
    }
  })
})

describe('With metadata: the kills', () => {
  for (const kind of ['new', 'upgrade'] as const) {
    it(`killed between the copy and the state write (${kind}): the library reads as empty-state With metadata, and the resume writes the state and the base without copying again`, async () => {
      // The state step never returns: a kill right after `phase: 'state'` is saved.
      const r = rig({ deps: { writeLibraryState: () => new Promise(() => {}) } })
      const root = path.join(r.env.drive, 'Trip')
      if (kind === 'upgrade') await seedLibrary(root, { libraryId: OTHER_LIB, name: 'Trip' })
      const res = await r.env.svc.start({
        selection: sel(r.a1, r.b1),
        target: r.env.drive,
        name: 'Trip',
        mode: 'metadata',
        ...(kind === 'upgrade' ? { confirmTakeover: true } : {})
      })
      if (!res.ok) throw new Error(res.reason)
      const jobId = res.job.jobId
      await vi.waitFor(() => expect(jobFile(r, jobId).phase).toBe('state'))
      expect(r.copies.n).toBe(2)

      const before = await readLibrary(root)
      expect(before).toMatchObject({
        status: 'ok',
        mode: 'metadata',
        state: null,
        stateInitialized: false,
        torn: false
      })
      expect(fs.existsSync(path.join(root, LIBRARY_DIR, 'state.json'))).toBe(false)
      if (before.status === 'ok') {
        expect(before.manifest.items.map(itemKey).sort()).toEqual([r.a1, r.b1].sort())
        expect(before.manifest.owner?.shikimoriId).toBe(ME.id)
      }

      // The restart: a new service on the same userData, with the real state step.
      const svc = r.env.restart({ writeLibraryState: (t) => r.runner.runExport(t) })
      await svc.init()
      expect(svc.list()[0]).toMatchObject({ status: 'paused', phase: 'state' })
      await svc.resume(jobId)
      await svc.settled(jobId)

      expect(svc.list()[0]).toMatchObject({ status: 'completed', phase: 'done' })
      expect(jobFile(r, jobId).phase).toBe('done')
      await expectPairedWithBase(r, root)
      expect(r.copies.n).toBe(2)
    })
  }

  it('killed between state.json and the base: the resume writes once more and records the base; local state is unchanged', async () => {
    const r = rig()
    const root = path.join(r.env.drive, 'Trip')
    const rename = fs.promises.rename
    let armed = true
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (armed && /sync-bases[\\/]library-[^\\/]+\.json$/.test(String(to))) {
        throw new Error('killed before the base')
      }
      return rename(from, to)
    })
    const job = await startMeta(r, [r.a1, r.b1])
    expect(job).toMatchObject({ status: 'paused', phase: 'state' })
    expect(job.error).toMatch(/^Saving watch state failed/)
    const p1 = await pairOf(root)
    expect(p1.state).not.toBeNull()
    const libraryId = p1.manifest.libraryId
    expect(baseOf(r, libraryId)).toBeNull()
    const local = localState(r)

    armed = false
    const svc = r.env.restart()
    await svc.init()
    await svc.resume(job.jobId)
    await svc.settled(job.jobId)

    expect(svc.list()[0]).toMatchObject({ status: 'completed', phase: 'done', error: null })
    expect(await expectPairedWithBase(r, root)).toBe(p1.state!.generation + 1)
    expect(docBody((await pairOf(root)).state!.doc)).toEqual(docBody(p1.state!.doc))
    expect(localState(r)).toBe(local)
    expect(r.copies.n).toBe(2)
  })
})

describe('With metadata: a Cancel during "Saving watch state" (#636 review)', () => {
  /** A state step held on a gate: `land` runs S9's real leg, `fail` reports a failed write. */
  function gated(outcome: 'land' | 'fail') {
    let open!: () => void
    const gate = new Promise<void>((resolve) => (open = resolve))
    const holder: { r?: Rig } = {}
    const r = rig({
      deps: {
        writeLibraryState: async (t) => {
          await gate
          if (outcome === 'land') return holder.r!.runner.runExport(t)
          return {
            libraryId: t.libraryId,
            drive: 'error',
            driveReason: 'io',
            shikimori: 'skipped',
            counts: { applied: 0, conflicts: 0, clamped: 0 },
            waitingMalIds: [],
            rewatchesSuperseded: 0
          }
        }
      }
    })
    holder.r = r
    return { r, open }
  }

  async function cancelWhileSaving(outcome: 'land' | 'fail') {
    const { r, open } = gated(outcome)
    const res = await r.env.svc.start({
      selection: sel(r.a1),
      target: r.env.drive,
      name: 'Trip',
      mode: 'metadata'
    })
    if (!res.ok) throw new Error(res.reason)
    const jobId = res.job.jobId
    await vi.waitFor(() => expect(jobFile(r, jobId).phase).toBe('state'))
    // Cancel waits for the run, and the run for the state step.
    const cancelled = r.env.svc.cancel(jobId)
    open()
    await cancelled
    await r.env.svc.settled(jobId)
    return { r, jobId, root: path.join(r.env.drive, 'Trip') }
  }

  it('the write lands: the job ends cancelled, and the state and base it wrote stay', async () => {
    const { r, jobId, root } = await cancelWhileSaving('land')
    expect(r.env.svc.list()[0]).toMatchObject({ status: 'cancelled', phase: 'done', error: null })
    expect(jobFile(r, jobId)).toMatchObject({ status: 'cancelled', phase: 'done' })
    await expectPairedWithBase(r, root)
  })

  it('the write fails: the job ends cancelled, not paused asking to resume', async () => {
    const { r, jobId, root } = await cancelWhileSaving('fail')
    expect(r.env.svc.list()[0]).toMatchObject({ status: 'cancelled', phase: 'state', error: null })
    expect(jobFile(r, jobId).status).toBe('cancelled')
    expect(await readLibrary(root)).toMatchObject({ status: 'ok', state: null })
  })

  for (const stop of ['cancel', 'pause'] as const) {
    it(`a ${stop} before a resumed state step starts: no state is written`, async () => {
      // Killed in `state`, restarted, resumed, and stopped at once.
      const r = rig({ deps: { writeLibraryState: () => new Promise(() => {}) } })
      const root = path.join(r.env.drive, 'Trip')
      const res = await r.env.svc.start({
        selection: sel(r.a1),
        target: r.env.drive,
        name: 'Trip',
        mode: 'metadata'
      })
      if (!res.ok) throw new Error(res.reason)
      const jobId = res.job.jobId
      await vi.waitFor(() => expect(jobFile(r, jobId).phase).toBe('state'))
      const svc = r.env.restart({ writeLibraryState: (t) => r.runner.runExport(t) })
      await svc.init()
      await svc.resume(jobId)
      await (stop === 'cancel' ? svc.cancel(jobId) : svc.pause(jobId))
      await svc.settled(jobId)

      expect(svc.list()[0]).toMatchObject({
        status: stop === 'cancel' ? 'cancelled' : 'paused',
        phase: 'state'
      })
      expect(await readLibrary(root)).toMatchObject({ status: 'ok', state: null })
      if (stop === 'pause') {
        // Resume finishes it.
        await svc.resume(jobId)
        await svc.settled(jobId)
        expect(svc.list()[0]).toMatchObject({ status: 'completed', phase: 'done' })
        await expectPairedWithBase(r, root)
      }
    })
  }
})

describe('With metadata: who and where', () => {
  it('logged out: the plan says With metadata is off, and the start refuses', async () => {
    const r = rig({ user: null })
    const plan = await r.env.svc.plan({
      animeIds: [101],
      target: r.env.drive,
      name: '',
      mode: 'metadata'
    })
    expect(plan).toMatchObject({ canExportMetadata: false, nickname: null })
    const res = await r.env.svc.start({
      selection: sel(r.a1),
      target: r.env.drive,
      name: '',
      mode: 'metadata'
    })
    expect(res).toEqual({ ok: false, reason: LOG_IN_FOR_METADATA })
    expect(scan(r.env.drive)).toEqual({})
  })

  it('logged in: offered, and a new library is named after the account by default', async () => {
    const r = rig()
    const plan = await r.env.svc.plan({
      animeIds: [101],
      target: r.env.drive,
      name: '',
      mode: 'metadata'
    })
    expect(plan).toMatchObject({ canExportMetadata: true, nickname: ME.nickname })
    expect(plan.target).toMatchObject({
      kind: 'new',
      mode: 'metadata',
      libraryName: `Anime Library (${ME.nickname})`
    })
    await startMeta(r, [r.a1], '')
    expect((await pairOf(path.join(r.env.drive, `Anime Library (${ME.nickname})`))).state).not.toBe(
      null
    )
  })

  it('an expired session (credentials gone, shikimoriUser kept) still exports', async () => {
    const r = rig({ store: { shikimoriCredentials: null, shikimoriSessionExpired: true } })
    const root = path.join(r.env.drive, 'Trip')
    const job = await startMeta(r, [r.a1])
    expect(job.status).toBe('completed')
    expect((await pairOf(root)).manifest.owner?.shikimoriId).toBe(ME.id)
    await expectPairedWithBase(r, root)
  })

  it('a foreign target is never written; a sibling With metadata library is created', async () => {
    const r = rig()
    const foreign = path.join(r.env.drive, 'Trip')
    await seedLibrary(foreign, { libraryId: OTHER_LIB, name: 'Trip', owner: FRIEND })
    const before = scan(foreign)
    const plan = await r.env.svc.plan({
      animeIds: [101],
      target: r.env.drive,
      name: 'Trip',
      mode: 'metadata'
    })
    expect(plan.target).toMatchObject({ kind: 'foreign', ownerNickname: 'friend' })
    await startMeta(r, [r.a1])
    expect(scan(foreign)).toEqual(before)
    const sibling = await pairOf(path.join(r.env.drive, 'Trip (2)'))
    expect(sibling.manifest).toMatchObject({ mode: 'metadata', owner: { shikimoriId: ME.id } })
    expect(sibling.manifest.libraryId).not.toBe(OTHER_LIB)
    expect(sibling.state).not.toBeNull()
  })

  for (const mode of ['metadata', 'videos'] as const) {
    it(`a target this PC claimed is never written (${mode}); a sibling library is created`, async () => {
      // With metadata needs an account; a Videos only add comes from a claim PC (no account).
      const r = rig({ user: mode === 'metadata' ? ME : null })
      const claimedRoot = path.join(r.env.drive, 'Trip')
      await seedLibrary(claimedRoot, { libraryId: OTHER_LIB, name: 'Trip', owner: FRIEND })
      r.env.store.set('attachedLibraries', {
        [OTHER_LIB]: {
          root: claimedRoot,
          name: 'Trip',
          mode: 'metadata',
          owner: FRIEND,
          access: 'read-write',
          claim: { ownerId: FRIEND.shikimoriId, at: 1 },
          lastSeenAt: 0,
          lastSyncAt: null
        }
      })
      const before = scan(claimedRoot)
      const plan = await r.env.svc.plan({
        animeIds: [101],
        target: r.env.drive,
        name: 'Trip',
        mode
      })
      expect(plan.target).toMatchObject({
        kind: 'claimed',
        root: path.join(r.env.drive, 'Trip (2)')
      })
      const res = await r.env.svc.start({
        selection: sel(r.a1),
        target: r.env.drive,
        name: 'Trip',
        mode
      })
      if (!res.ok) throw new Error(res.reason)
      await r.env.svc.settled(res.job.jobId)
      expect(res.job.note).toMatch(/through a claim/)
      expect(scan(claimedRoot)).toEqual(before)
      const sibling = await pairOf(path.join(r.env.drive, 'Trip (2)'))
      expect(sibling.manifest.libraryId).not.toBe(OTHER_LIB)
      expect(sibling.manifest.mode).toBe(mode)
      expect(sibling.manifest.items.map(itemKey)).toEqual([r.a1])
    })
  }

  it('another account logged in before the state step: nothing is written for it, and the job waits for the owner', async () => {
    const OTHER = { id: 999, nickname: 'other', avatar: '' }
    const holder: { r?: Rig } = {}
    const r = rig({
      deps: {
        writeLibraryState: (t) => {
          holder.r!.env.store.set('shikimoriUser', OTHER)
          return holder.r!.runner.runExport(t)
        }
      }
    })
    holder.r = r
    const root = path.join(r.env.drive, 'Trip')
    const job = await startMeta(r, [r.a1])
    expect(job).toMatchObject({ status: 'paused', phase: 'state' })
    expect(job.error).toBe(
      'Saving watch state failed: the library’s owner isn’t logged in on this PC. Resume to try again.'
    )
    const p = await pairOf(root)
    expect(p).toMatchObject({ state: null, stateInitialized: false })
    expect(p.manifest.owner?.shikimoriId).toBe(ME.id)
    expect(baseOf(r, p.manifest.libraryId)).toBeNull()
  })

  it('the claimed target’s message is the dialog’s', () => {
    expect(CLAIMED_TARGET).toBe(
      'You use this library through a claim. Your export goes into a new library next to it.'
    )
  })
})

describe('With metadata: the takeover (owner decision 9)', () => {
  const OLD_ITEM: SharedLibraryItem = {
    animeId: 999,
    episodeInt: '1',
    translationId: 91,
    translationType: 'subRu',
    author: 'Them',
    quality: 720,
    path: 'Old Show/Old Show - 01 [Them].mkv',
    size: 10,
    sha256: 'a'.repeat(64)
  }

  async function videosOnlyByAnotherPc(r: Rig): Promise<string> {
    const root = path.join(r.env.drive, 'Trip')
    await seedLibrary(root, {
      libraryId: OTHER_LIB,
      name: 'Trip',
      items: [OLD_ITEM],
      titles: [{ animeId: 999, name: 'Old Show' }]
    })
    return root
  }

  it('needs the confirmation: without it the start refuses and the manifest is unchanged', async () => {
    const r = rig()
    const root = await videosOnlyByAnotherPc(r)
    const plan = await r.env.svc.plan({
      animeIds: [101],
      target: r.env.drive,
      name: 'Trip',
      mode: 'metadata'
    })
    expect(plan.target).toMatchObject({ kind: 'upgrade', mode: 'metadata', blocked: null })
    const before = scan(root)
    const res = await r.env.svc.start({
      selection: sel(r.a1),
      target: r.env.drive,
      name: 'Trip',
      mode: 'metadata'
    })
    expect(res).toEqual({ ok: false, reason: takeoverUnconfirmed('Trip') })
    expect(scan(root)).toEqual(before)
    expect(r.env.svc.list()).toEqual([])
  })

  it('confirmed: this user owns it With metadata, the old items are still listed, and the state is written', async () => {
    const r = rig()
    const root = await videosOnlyByAnotherPc(r)
    const job = await startMeta(r, [r.a1], 'Trip', { confirmTakeover: true })
    expect(job.status).toBe('completed')
    const p = await pairOf(root)
    expect(p.manifest).toMatchObject({
      libraryId: OTHER_LIB,
      mode: 'metadata',
      owner: { shikimoriId: ME.id, nickname: ME.nickname }
    })
    expect(p.manifest.items.map(itemKey).sort()).toEqual([itemKey(OLD_ITEM), r.a1].sort())
    expect(p.manifest.titles.map((t) => t.animeId).sort()).toEqual([101, 999])
    expect(p.state!.doc.titles!['101'].watch!['1'].watched.value).toBe(true)
    await expectPairedWithBase(r, root)
  })

  it('S5’s writer refuses takeover: true on an owned manifest (another owner, or this user), and the drive is unchanged', async () => {
    const r = rig()
    for (const owner of [FRIEND, { shikimoriId: ME.id, nickname: ME.nickname }]) {
      const root = path.join(r.env.drive, `Owned ${owner.shikimoriId}`)
      await seedLibrary(root, { libraryId: OTHER_LIB, name: 'Owned', owner })
      const m = (await pairOf(root)).manifest
      const before = scan(root)
      await expect(
        writeManifest(
          root,
          {
            libraryId: m.libraryId,
            name: m.name,
            owner: { shikimoriId: ME.id, nickname: ME.nickname },
            mode: 'metadata',
            titles: m.titles,
            items: m.items
          },
          r.env.actor,
          m.generation,
          { takeover: true }
        )
      ).rejects.toBeInstanceOf(NotOwnerError)
      expect(scan(root)).toEqual(before)
    }
  })
})

describe('With metadata: into this user’s own library', () => {
  it('a Videos only add is routed to With metadata and widens titles[] with state', async () => {
    const r = rig()
    const root = path.join(r.env.drive, 'Trip')
    await startMeta(r, [r.a1])
    const g1 = (await pairOf(root)).state!.generation

    const plan = await r.env.svc.plan({ animeIds: [202], target: r.env.drive, name: 'Trip' })
    expect(plan.target).toMatchObject({ kind: 'own-metadata', mode: 'metadata', blocked: null })
    const res = await r.env.svc.start({ selection: sel(r.b1), target: r.env.drive, name: 'Trip' })
    if (!res.ok) throw new Error(res.reason)
    expect(res.job.mode).toBe('metadata')
    await r.env.svc.settled(res.job.jobId)

    const p = await pairOf(root)
    expect(p.manifest.titles.map((t) => t.animeId)).toEqual([101, 202])
    expect(p.manifest.items.map(itemKey).sort()).toEqual([r.a1, r.b1].sort())
    expect(p.state!.doc.titles!['202'].watch!['1'].position.value.position).toBe(300)
    expect(await expectPairedWithBase(r, root)).toBe(g1 + 1)
  })

  it('merges first: a newer position the other PC wrote to the drive survives, on the drive and here', async () => {
    const r = rig()
    const root = path.join(r.env.drive, 'Trip')
    await startMeta(r, [r.a1])

    // The owner's other PC watched further into 101 episode 1.
    const p = await pairOf(root)
    const doc = structuredClone(p.state!.doc) as SharedSyncDoc
    const later = T0 + 60_000
    doc.titles!['101'].watch!['1'].position = {
      value: { position: 900, duration: 1440 },
      at: later,
      origin: 'pc-other'
    }
    await writeState(
      root,
      doc,
      { installId: 'pc-other', appVersion: '5.0.47', shikimoriUserId: ME.id, claim: null },
      p.manifest.stateGeneration
    )

    await startMeta(r, [r.b1])
    const after = await pairOf(root)
    expect(after.state!.doc.titles!['101'].watch!['1'].position).toMatchObject({
      value: { position: 900 },
      at: later
    })
    const local = r.env.store.get('watchProgress') as Record<string, { position: number }>
    expect(local['101:1'].position).toBe(900)
    expect(Object.keys(after.state!.doc.titles ?? {}).sort()).toEqual(['101', '202'])
    await expectPairedWithBase(r, root)
  })

  it('re-running With metadata with nothing new to copy just merges', async () => {
    const r = rig()
    const root = path.join(r.env.drive, 'Trip')
    await startMeta(r, [r.a1])
    const g1 = (await pairOf(root)).state!.generation
    const copies = r.copies.n
    const job = await startMeta(r, [r.a1])
    expect(job).toMatchObject({ status: 'completed', phase: 'done', filesTotal: 0 })
    expect(r.copies.n).toBe(copies)
    expect(await expectPairedWithBase(r, root)).toBe(g1 + 1)
  })
})
