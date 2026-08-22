import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { CHANNELS, EVENT_CHANNELS } from '../src/shared/ipc/channels'

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8')
const PRELOAD = read('src/preload/index.ts')
// Phase 3 splits `registerIpcHandlers()` into per-domain `src/main/ipc/*.ipc.ts`
// routers. Include every router so channels referenced from them count as
// referenced for the drift-guard checks below.
const IPC_DIR = resolve(__dirname, '..', 'src/main/ipc')
const ROUTERS = readdirSync(IPC_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(resolve(IPC_DIR, f), 'utf8'))
  .join('\n')
// Top-level `src/main/*.ts` files (download-manager, auto-downloader,
// fpcalc-binaries, …) also emit events. Without scanning them, raw-string
// emit sites bypass both the literal-leftover check and the new
// emitter-presence check added for Phase 7.
const MAIN_DIR = resolve(__dirname, '..', 'src/main')
const MAIN = readdirSync(MAIN_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(resolve(MAIN_DIR, f), 'utf8'))
  .join('\n')
const SOURCES = MAIN + '\n' + PRELOAD + '\n' + ROUTERS

// #294 hoisted `MseOpenResult` into `src/shared/types/player.d.ts`. The guard
// below gets its own read on purpose: `SOURCES` reaches none of what it needs —
// `PRELOAD` is `src/preload/index.ts` alone (not `types.d.ts`), and `MAIN` is
// *top-level* `src/main/*.ts` only, so it never opens `src/main/streaming/`,
// where the deleted declaration used to live.
//
// The walk covers **all** of `src/` rather than just `src/main/`, minus the one
// file that owns the declaration. The drift this guards against (#275's
// `initialSeek` collision) was renderer-side, and the renderer's copy would be
// written where the reply is consumed — inside a `.vue` SFC — so `.vue` is
// walked alongside `.ts`.
const PRELOAD_TYPES = read('src/preload/types.d.ts')
const SRC_DIR = resolve(__dirname, '..', 'src')
const DECLARATION_OWNER = resolve(SRC_DIR, 'shared/types/player.d.ts')
const walkSources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = resolve(dir, e.name)
    if (e.isDirectory()) return walkSources(full)
    if (!e.isFile() || full === DECLARATION_OWNER) return []
    return full.endsWith('.ts') || full.endsWith('.vue') ? [readFileSync(full, 'utf8')] : []
  })
const SRC_MINUS_OWNER = walkSources(SRC_DIR).join('\n')

// First arg of every IPC-ish call. Post-1c every one must be a CHANNELS./
// EVENT_CHANNELS. reference — a bare string literal here means an un-migrated
// channel bypassing the single source of truth.
const IPC_CALL =
  /(?:ipcMain\.(?:handle|on)|ipcRenderer\.(?:invoke|send|on|removeListener|removeAllListeners)|[\w.]+\.webContents\.send|sender\.send|broadcastToAll)\(\s*(['"`])([a-z][\w:-]+)\1/g

describe('IPC channel contract', () => {
  const requestValues = Object.values(CHANNELS)
  const eventValues = Object.values(EVENT_CHANNELS)

  it('has no duplicate literals', () => {
    const all = [...requestValues, ...eventValues]
    expect(new Set(all).size).toBe(all.length)
  })

  it('keeps request and event channels disjoint', () => {
    const ev = new Set<string>(eventValues)
    expect(requestValues.filter((c) => ev.has(c))).toEqual([])
  })

  it('uses a SCREAMING_SNAKE key derived from each channel name', () => {
    for (const [key, value] of Object.entries(CHANNELS)) {
      expect(key).toBe(value.replace(/[:-]/g, '_').toUpperCase())
    }
    for (const [key, value] of Object.entries(EVENT_CHANNELS)) {
      expect(key).toBe(value.replace(/[:-]/g, '_').toUpperCase())
    }
  })

  it('leaves no raw IPC channel string literals in main or preload (1c migration complete)', () => {
    const leftovers = new Set<string>()
    let m: RegExpExecArray | null
    IPC_CALL.lastIndex = 0
    while ((m = IPC_CALL.exec(SOURCES))) leftovers.add(m[2])
    expect([...leftovers]).toEqual([])
  })

  it('has no dead contract constants — every channel is referenced by symbol', () => {
    const unreferenced = [...Object.keys(CHANNELS), ...Object.keys(EVENT_CHANNELS)].filter(
      (key) => {
        const sym = (key in CHANNELS ? 'CHANNELS.' : 'EVENT_CHANNELS.') + key
        return !SOURCES.includes(sym)
      }
    )
    expect(unreferenced).toEqual([])
  })

  // Round-trip checks (Phase 7 PR 1, #140). The symbol-reference check above
  // only proves the constant is *mentioned*; these prove it's actually wired
  // on both ends of the IPC bridge.
  it('every request CHANNEL has a registered ipcMain.handle in some router', () => {
    const unhandled = Object.keys(CHANNELS).filter((key) => {
      const sym = `CHANNELS.${key}`
      const handlePattern = new RegExp(`ipcMain\\.(?:handle|on)\\(\\s*${sym}\\b`)
      return !handlePattern.test(ROUTERS) && !handlePattern.test(MAIN)
    })
    expect(unhandled).toEqual([])
  })

  it('every request CHANNEL has a matching preload binding (ipcRenderer.invoke/send)', () => {
    const unbound = Object.keys(CHANNELS).filter((key) => {
      const sym = `CHANNELS.${key}`
      const invokePattern = new RegExp(`ipcRenderer\\.(?:invoke|send)\\(\\s*${sym}\\b`)
      return !invokePattern.test(PRELOAD)
    })
    expect(unbound).toEqual([])
  })

  it('every EVENT_CHANNEL is referenced in main (emitter or service config) and subscribed in preload', () => {
    // Direct emission (webContents.send / broadcast / sender.send) is one way
    // a channel reaches the renderer; the other is passing the symbol into a
    // service constructor as a config field (e.g. `rateUpdatedChannel:
    // EVENT_CHANNELS.X`) which then emits internally. Both forms count.
    const unwired = Object.keys(EVENT_CHANNELS).filter((key) => {
      const sym = `EVENT_CHANNELS.${key}`
      // Subscriber forms in preload: `subscribe(EVENT_CHANNELS.X)` with optional
      // (possibly nested) generic args, or a bespoke `ipcRenderer.on(EVENT_CHANNELS.X, …)`
      // for multi-arg payloads. `[^(]*` skips over generic blocks since type
      // params never contain `(` — robust to nesting like `Record<a, b>`.
      const subscribePattern = new RegExp(
        `(?:subscribe\\b[^(]*\\(|ipcRenderer\\.(?:on|once)\\()\\s*${sym}\\b`
      )
      const hasMainReference = MAIN.includes(sym) || ROUTERS.includes(sym)
      const hasSubscriber = subscribePattern.test(PRELOAD)
      return !hasMainReference || !hasSubscriber
    })
    expect(unwired).toEqual([])
  })
})

// #294: the MSE-open reply shape existed as five literal copies (main's
// `streaming/index.ts`, two inline in `src/preload/index.ts`, two in
// `src/preload/types.d.ts`). That is what let the `initialSeek` field mean one
// thing in main and another in the renderer until #275. One ambient
// declaration owns it now; these guard against copy #6 coming back.
describe('MseOpenResult is declared once', () => {
  it('is declared in the shared ambient types and nowhere else', () => {
    const DECLARATION = /\b(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+MseOpenResult\b/g
    const shared = read('src/shared/types/player.d.ts')
    expect(shared.match(DECLARATION)?.length ?? 0).toBe(1)
    // Acceptance criterion 2: not re-exported from main, and — the
    // compile-clean failure mode `npm run typecheck` cannot see — not
    // shadowed by a module-local `interface MseOpenResult` anywhere under
    // `src/`: a router, a preload file, the renderer, or the rest of
    // `src/shared`. `import type { MseOpenResult }` and
    // `export type { MseOpenResult }` do not match — only a fresh declaration
    // does, so legitimate re-exports stay green.
    expect(SRC_MINUS_OWNER.match(DECLARATION) ?? []).toEqual([])
  })

  it('is referenced by name from both preload files, with no inline copy left', () => {
    expect(PRELOAD).toContain('MseOpenResult')
    expect(PRELOAD_TYPES).toContain('MseOpenResult')
    // Scoped to the two preload strings deliberately: `player.ipc.ts` builds
    // the reply *literals* with this key and always will, so a SOURCES-wide
    // version of this assertion would fail permanently.
    expect(PRELOAD).not.toContain('hasSubtitlesPending')
    expect(PRELOAD_TYPES).not.toContain('hasSubtitlesPending')
  })
})
