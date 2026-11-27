// THROWAWAY (#734 cold-start bisect): 12 cold launches with the first-launch
// download on, alternating the spec's current order (main evaluate right
// after launch) and the fix's (main evaluate after the first window's
// DOMContentLoaded).
import { test } from '@playwright/test'
import { launchApp, makeProfile } from './helpers/profile'

for (let i = 0; i < 24; i++) {
  const v = i % 2 === 0 ? 'before' : 'after'
  test(`cold start #${i} ${v}`, async () => {
    const profile = makeProfile({ prefix: 'anime-dl-coldstart-', ffmpeg: 'none', fpcalc: 'none' })
    const { app } = await launchApp(profile)
    try {
      if (v === 'after') {
        const w = await app.firstWindow()
        await w.waitForLoadState('domcontentloaded')
      }
      try {
        await app.evaluate(({ app }) => app.getPath('userData'))
        console.log(`[bisect] #${i} ${v} ok`)
      } catch (e) {
        console.log(`[bisect] #${i} ${v} FAIL: ${String(e)}`)
      }
    } finally {
      await app.close()
      profile.cleanup()
    }
  })
}
