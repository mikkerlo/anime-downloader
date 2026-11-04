// The offline scenario matrix (#659): one world per test, built from a row of
// `scenarios.ts`, then the row's actions, Prepare for offline's step 4, and
// one oracle over what it reported. See `docs/testing.md`, "Scenario matrix
// (offline)".
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHANNELS } from '../../../src/shared/ipc/channels'
import {
  ACTION_ROUTERS,
  buildHooks,
  buildWorld,
  named,
  type StepRun,
  type World
} from '../../helpers/offline-world'
import { check, ORACLE_ROUTERS, type Run } from '../../helpers/offline-oracles'
import { SCENARIOS, type Scenario } from './scenarios'

let world: World | null = null

afterEach(() => {
  world?.dispose()
  world = null
})

/** The row's world, ready, after its actions. */
async function setUp(s: Scenario): Promise<World> {
  const routers = [
    ...(s.actions ?? []).flatMap((a) => ACTION_ROUTERS[a.do]),
    ...s.oracles.flatMap((o) => ORACLE_ROUTERS[o])
  ]
  const w = (world = buildWorld(s.world, routers))
  await w.ready()
  for (const a of s.actions ?? []) await w.act(a)
  return w
}

async function observe(s: Scenario): Promise<Run> {
  const w = await setUp(s)
  const before = w.snapshot()
  const out = await w.runStep('local-integrity')
  const attached = s.world.library ? await w.runStep('attached-integrity') : null
  const after = w.snapshot()
  return {
    scenario: s.id,
    world: w,
    before,
    after,
    out,
    outcomes: await w.entryOutcomes(),
    attached,
    items: await w.itemOutcomes()
  }
}

const shown = (out: StepRun, w: World): unknown =>
  'failed' in out ? out : { status: out.status, details: out.details.map((d) => w.norm(d.text)) }

// A read-only folder stands in for a file Windows holds open; root ignores it.
const noLock = process.platform === 'win32' || process.getuid?.() === 0

describe('one world at a time', () => {
  it('buildWorld throws while another world is live', () => {
    world = buildWorld({ titles: [] })
    expect(() => buildWorld({ titles: [] })).toThrow(/another world is still live/)
  })

  it('a build that throws partway leaves no live world; the next build removes its temp root', () => {
    // A private temp dir, so another worker's worlds never show up in the scan
    // (`os.tmpdir()` reads these on every call).
    const keys = ['TMPDIR', 'TEMP', 'TMP'] as const
    const saved = keys.map((k) => process.env[k])
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offline-world-test-')))
    for (const k of keys) process.env[k] = tmp
    try {
      // A NUL in a folder name makes `mkdirSync` throw while the files are written.
      const bad = { titles: [{ id: 1, entries: [{ ep: '1', trId: 11, under: 'Bad\0Name' }] }] }
      expect(() => buildWorld(bad)).toThrow(/null bytes/)
      const left = fs.readdirSync(tmp)
      expect(left).toHaveLength(1)
      world = buildWorld({ titles: [] })
      expect(world.files.size).toBe(0)
      expect(fs.readdirSync(tmp)).not.toContain(left[0])
    } finally {
      world?.dispose()
      world = null
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k]
        else process.env[k] = saved[i]
      })
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("a build that throws after registering its routers leaves no handler for the next world's invoke", async () => {
    buildHooks.afterRegister = () => {
      throw new Error('thrown after register')
    }
    try {
      const first = { titles: [{ id: 7, cache: named('First World'), entries: [] }] }
      expect(() => buildWorld(first, ['anime'])).toThrow(/thrown after register/)
    } finally {
      buildHooks.afterRegister = null
    }
    world = buildWorld({ titles: [] })
    await expect(world.invoke(CHANNELS.GET_ANIME, 7)).rejects.toThrow(/No handler registered/)
  })
})

describe('a world with a library', () => {
  it('keeps the drive under its own root, and runs nothing until ready() has attached it', async () => {
    world = buildWorld({ titles: [], library: {} })
    expect(world.drive!.startsWith(world.root + path.sep)).toBe(true)
    await expect(world.runStep('attached-integrity')).rejects.toThrow(/await ready\(\) first/)
    await expect(world.runPrepare()).rejects.toThrow(/await ready\(\) first/)
    await world.ready()
    expect(await world.runStep('attached-integrity')).toEqual({
      status: 'ok',
      details: [{ text: 'Fixture library: 2 items ok', status: 'ok' }]
    })
    // So O1 and O2 have items to check: each is counted ok on its own.
    const items = await world.itemOutcomes()
    expect(items.map((i) => [i.key, world!.norm(i.file), i.outcome])).toEqual([
      [
        '101:1:9001',
        '<root>/drive/Fixture library/Frieren~3f2a1c/Frieren~3f2a1c - 01 [Crunchyroll].mp4',
        { kind: 'ok' }
      ],
      [
        '202:1:9101',
        '<root>/drive/Fixture library/Dungeon Meshi/Dungeon Meshi - 01 [AniLibria].mkv',
        { kind: 'ok' }
      ]
    ])
  })
})

for (const s of SCENARIOS) {
  describe.skipIf(s.locked && noLock)(`${s.id}: ${s.title}`, () => {
    if (s.expect) {
      it('step 4 reports exactly this', async () => {
        const { out, world: w } = await observe(s)
        expect(shown(out, w)).toEqual(s.expect)
      })
    }
    if (s.expectAttached) {
      it('step 5 reports exactly this', async () => {
        const { attached, world: w } = await observe(s)
        expect(attached && shown(attached, w)).toEqual(s.expectAttached)
      })
    }
    if (s.expectRun) {
      it('Prepare for offline runs exactly this', async () => {
        const w = await setUp(s)
        expect(await w.runPrepare()).toEqual(s.expectRun)
      })
    }
    for (const oracle of s.oracles) {
      const known = s.known?.find((k) => k.oracle === oracle)
      const agreed = s.agreed?.find((a) => a.oracle === oracle)
      const name = known
        ? `${oracle} (known: #${known.issue})`
        : agreed
          ? `${oracle} (agreed, still fires)`
          : oracle
      it(name, async () => {
        const violations = await check(oracle, await observe(s))
        if (known) expect(violations).toEqual(known.violations)
        else if (agreed) expect(violations.length).toBeGreaterThan(0)
        else expect(violations).toEqual([])
      })
    }
  })
}

// Every pair with violations needs a filed issue or a cited acceptance.
const COMMENT_URL =
  /^https:\/\/github\.com\/mikkerlo\/anime-downloader\/issues\/\d+#issuecomment-\d+$/
const RISKS_LINE = /^#\d+ Risks: ".+"$/

describe('known pins and agreed exemptions', () => {
  for (const s of SCENARIOS) {
    it(`${s.id}: each names a filed issue or a source, on an oracle the row runs`, () => {
      const exempted = [...(s.known ?? []), ...(s.agreed ?? [])].map((x) => x.oracle)
      expect(new Set(exempted).size).toBe(exempted.length)
      for (const k of s.known ?? []) {
        expect(Number.isInteger(k.issue) && k.issue > 0).toBe(true)
        expect(s.oracles).toContain(k.oracle)
        expect(k.violations.length).toBeGreaterThan(0)
        for (const v of k.violations) expect(v).toMatchObject({ scenario: s.id, oracle: k.oracle })
      }
      for (const a of s.agreed ?? []) {
        expect(COMMENT_URL.test(a.source) || RISKS_LINE.test(a.source)).toBe(true)
        expect(s.oracles).toContain(a.oracle)
      }
    })
  }

  it('row ids are unique', () => {
    const ids = SCENARIOS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
