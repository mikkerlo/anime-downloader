// The export run's outer catch (#574 review, r4405273818): a drive errno with
// the library still present ends the job as `failed`, not "Waiting for drive".
// Only `writeManifest` is replaced, so S5's `createLibrary` writes a real
// manifest that stays readable while every checkpoint write fails with ENOENT.

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import { readLibrary } from '../../src/main/lib/shared-library/read'
import { makeExportEnv, sel, type ExportEnv } from '../helpers/shared-library-export'

vi.mock('../../src/main/lib/shared-library/write', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/lib/shared-library/write')>()
  return {
    ...real,
    writeManifest: vi.fn(async () => {
      throw Object.assign(new Error('ENOENT: no such file or directory, open manifest.json.tmp'), {
        code: 'ENOENT'
      })
    })
  }
})

let env: ExportEnv
afterEach(() => env?.cleanup())

describe('the run’s outer catch (#574 review)', () => {
  it('a writeManifest ENOENT with the manifest still readable fails the job instead of waiting for the drive', async () => {
    const timers: (() => void)[] = []
    env = makeExportEnv({
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimer: () => {}
    })
    const a1 = env.addEpisode({ animeId: 7, title: 'Show', episodeInt: '1', translationId: 11 })
    const a2 = env.addEpisode({ animeId: 7, title: 'Show', episodeInt: '2', translationId: 12 })
    const r = await env.svc.start({
      selection: sel(a1.key, a2.key),
      target: env.drive,
      name: 'Lib'
    })
    if (!r.ok) throw new Error(r.reason)
    await env.svc.settled(r.job.jobId)

    // The library is still there and readable: this is not a lost drive.
    expect((await readLibrary(path.join(env.drive, 'Lib'))).status).toBe('ok')
    const job = env.svc.list()[0]
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/ENOENT/)
    expect(timers).toHaveLength(0)
  })
})
