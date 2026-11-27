// THROWAWAY (#734 cold-start bisect): cold launches in three variants, each
// logging whether the first main-process evaluate failed.
//   online: the first-launch binary download starts at boot, evaluate at once
//   offline: workOffline, so no download starts, evaluate at once
//   window: online, evaluate after the first window's DOMContentLoaded
//   seeded: binaries seeded (no download), evaluate at once
import { test } from '@playwright/test'
import { launchApp, makeProfile } from './helpers/profile'

const VARIANTS = ['online', 'offline', 'window', 'seeded'] as const

for (let i = 0; i < 24; i++) {
  const v = VARIANTS[i % VARIANTS.length]
  test(`cold start #${i} ${v}`, async () => {
    const profile = makeProfile({
      prefix: 'anime-dl-coldstart-',
      ...(v === 'seeded' ? {} : { ffmpeg: 'none' as const, fpcalc: 'none' as const }),
      ...(v === 'offline' ? { config: { workOffline: true } } : {})
    })
    const { app } = await launchApp(profile)
    try {
      if (v === 'window') {
        const w = await app.firstWindow()
        await w.waitForLoadState('domcontentloaded')
      }
      const t1 = Date.now()
      try {
        await app.evaluate(({ app }) => app.getPath('userData'))
        console.log(`[bisect] #${i} ${v} ok (eval ${Date.now() - t1}ms)`)
      } catch (e) {
        console.log(`[bisect] #${i} ${v} FAIL after ${Date.now() - t1}ms: ${String(e)}`)
      }
    } finally {
      await app.close()
      profile.cleanup()
    }
  })
}
