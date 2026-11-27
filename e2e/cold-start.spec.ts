// THROWAWAY (#734 cold-start bisect): 12 cold launches, each logging whether
// the first main-process evaluate failed, the raw error, and a retry.
import { test } from '@playwright/test'
import { launchApp, makeProfile } from './helpers/profile'

for (let i = 0; i < 12; i++) {
  test(`cold start #${i}`, async () => {
    const profile = makeProfile({ prefix: 'anime-dl-coldstart-', ffmpeg: 'none', fpcalc: 'none' })
    const t0 = Date.now()
    const { app } = await launchApp(profile)
    const launched = Date.now() - t0
    try {
      const t1 = Date.now()
      try {
        await app.evaluate(({ app }) => app.getPath('userData'))
        console.log(`[bisect] #${i} ok (launch ${launched}ms, eval ${Date.now() - t1}ms)`)
      } catch (e) {
        console.log(
          `[bisect] #${i} FAIL (launch ${launched}ms, after ${Date.now() - t1}ms): ${String(e)}`
        )
        await new Promise((r) => setTimeout(r, 200))
        const again = await app
          .evaluate(({ app }) => `ready=${app.isReady()} uptime=${process.uptime()}`)
          .catch((err: unknown) => `retry failed: ${String(err)}`)
        console.log(`[bisect] #${i} retry: ${again}`)
      }
    } finally {
      await app.close()
      profile.cleanup()
    }
  })
}
