// THROWAWAY (#734 harness fix probe): 24 launches through the fixed
// launchApp (it returns after the first window's DOMContentLoaded), 12 cold
// (first-launch download on) and 12 seeded, each followed at once by the
// first main-process evaluate. Counts failures.
import { test } from '@playwright/test'
import { launchApp, makeProfile } from './helpers/profile'

for (let i = 0; i < 24; i++) {
  const v = i % 2 === 0 ? 'cold' : 'seeded'
  test(`probe #${i} ${v}`, async () => {
    const profile = makeProfile({
      prefix: 'anime-dl-coldstart-',
      ...(v === 'cold' ? { ffmpeg: 'none' as const, fpcalc: 'none' as const } : {})
    })
    const { app } = await launchApp(profile)
    try {
      try {
        await app.evaluate(({ app }) => app.getPath('userData'))
        console.log(`[probe] #${i} ${v} ok`)
      } catch (e) {
        console.log(`[probe] #${i} ${v} FAIL: ${String(e)}`)
      }
    } finally {
      await app.close()
      profile.cleanup()
    }
  })
}
