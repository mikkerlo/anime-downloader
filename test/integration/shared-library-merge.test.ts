// Two PCs and one drive (#584): the owner's PC A exports, a claim PC B watches
// episodes 4–6 on it, the drive comes back to A, and A merges. Real stores,
// real Shared Library files, the real runner and drain, a fake Shikimori.
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ...(await import('../helpers/fake-shikimori')).fakeApi
}))

import { cleanup } from '../helpers/shared-library'
import {
  ANIME,
  MAL,
  T0,
  cacheEntry,
  driveDoc,
  makeLibrary,
  makePc,
  progressRow,
  server,
  vals,
  writeDrive
} from '../helpers/sync-runner'

const ID = String(ANIME)
const rows = (eps: number[], at: number) =>
  Object.fromEntries(eps.map((e) => [`${ID}:${e}`, progressRow(true, at + e)]))

afterEach(() => {
  cleanup()
  server.reset()
})

describe('local ↔ Shared Library ↔ Shikimori across two PCs', () => {
  it('positions and watched combine, A raises to episode 6, and one score conflict is held', async () => {
    server.set(MAL, { episodes: 3, score: 6 }, T0)
    // 1. A exports: an empty-state library, filled by A's first merge.
    const { root, libraryId } = await makeLibrary()
    const a = makePc({
      installId: 'pc-a',
      store: {
        watchProgress: rows([1, 2, 3], T0),
        shikimoriUserRates: [cacheEntry(MAL, ANIME, vals({ episodes: 3, score: 6 }), T0)]
      }
    })
    await a.attach(root)
    const first = await a.runner.runAll('attach')
    expect(first.libraries[0]).toMatchObject({ drive: 'ok', shikimori: 'ok' })
    expect(Object.keys((await driveDoc(root))!.titles![ID].watch!)).toEqual(['1', '2', '3'])
    a.store.set('attachedLibraries', {})

    // 2. B claims it and watches 4–6.
    const b = makePc({ user: null, installId: 'pc-b' })
    await b.attach(root, { claim: true })
    await b.runner.runAll('attach')
    b.store.set('watchProgress', {
      ...(b.store.get('watchProgress') as object),
      ...rows([4, 5, 6], T0 + 5000)
    })
    await b.runner.runAll('manual')
    expect(Object.keys((await driveDoc(root))!.titles![ID].watch!).sort()).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6'
    ])
    expect(b.store.get('shikimoriUpdateQueue')).toEqual([])

    // Meanwhile the owner's other PC set score 8 on the drive (a claim PC can't edit a
    // score), and A set 7 on Shikimori.
    const now = (await driveDoc(root))! as SyncDoc
    now.titles[ID].rate!.score = { value: 8, at: T0 + 6000, origin: 'pc-a2' }
    await writeDrive(root, now)
    server.set(MAL, { score: 7 })
    a.store.set('shikimoriUserRates', [
      cacheEntry(MAL, ANIME, vals({ episodes: 3, score: 7 }), server.clock)
    ])

    // 3–4. The drive comes back to A, and A merges.
    await a.attach(root)
    const vs = vi.spyOn(a.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)
    await a.runner.runAll('plug')
    const wp = a.store.get('watchProgress') as Record<string, { watched: boolean }>
    expect([1, 2, 3, 4, 5, 6].every((e) => wp[`${ID}:${e}`]?.watched)).toBe(true)
    const q = a.store.get('shikimoriUpdateQueue') as {
      after: { episodes: number }
      fields: string[]
    }[]
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ after: { episodes: 6, score: 7 }, fields: ['episodes'] })
    const records = JSON.parse(
      fs.readFileSync(path.join(a.userData, 'sync-state', 'conflicts.json'), 'utf8')
    ).records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      animeId: ID,
      fieldPath: 'rate.score',
      parties: { local: 7, [`library:${libraryId}`]: 8 }
    })
    vs.mockRestore()
    await a.runner.runAll('manual')
    expect(
      JSON.parse(fs.readFileSync(path.join(a.userData, 'sync-state', 'conflicts.json'), 'utf8'))
        .records
    ).toHaveLength(1)
  })
})
