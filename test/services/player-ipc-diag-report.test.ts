// `player:diag-report` (#653): the renderer's one way into player-diag.log,
// used by the MSE stall watchdog. Always on, unlike main's own diag lines,
// which the Settings → Debug toggle gates; one call writes exactly one line.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ipcMain } from 'electron'
import { DIAG_REPORT_MAX, register } from '../../src/main/ipc/player.ipc'
import { createStreamingService } from '../../src/main/streaming'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import type { AppDeps } from '../../src/main/ipc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

describe('player.ipc — player:diag-report', () => {
  let lines: string[]
  let report: (line: unknown) => unknown

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    lines = []
    const streamingService = createStreamingService({
      getFfmpegPath: () => '',
      getFfprobePath: () => '',
      isPlayerDiagEnabled: () => false,
      playerDiagSink: (line) => void lines.push(line),
      channels: { streamChunk: 'sc', streamEnd: 'se', streamError: 'sx', streamProgress: 'sp' }
    })
    const deps = {
      store: new InMemoryStorage({}),
      streamingService,
      smotretApi: {},
      coldStorageService: {},
      mp4StatsService: {},
      getFfmpegPath: () => '',
      getFfprobePath: () => ''
    } as unknown as AppDeps
    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
    register(deps)
    const handlers = new Map(
      (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
    )
    report = (line) => handlers.get(CHANNELS.PLAYER_DIAG_REPORT)!({}, line)
  })

  it('writes the line through playerDiagSink with diag logging off', () => {
    report('stall watchdog: t=436.600 readyState=1')

    // The toggle reads off, which drops main's own diag lines; this one is written.
    expect(lines).toEqual(['[player][diag] renderer stall watchdog: t=436.600 readyState=1'])
  })

  it('ignores a non-string payload', () => {
    for (const payload of [undefined, null, 42, { line: 'x' }, ['x']]) report(payload)

    expect(lines).toEqual([])
  })

  it('flattens CR and LF, so one call cannot forge a second log line', () => {
    report('a\r\nb\nc\rd\n\n2026-11-03T00:00:00.000Z [player][diag] forged')

    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toMatch(/[\r\n]/)
    expect(lines[0]).toBe(
      '[player][diag] renderer a b c d 2026-11-03T00:00:00.000Z [player][diag] forged'
    )
  })

  it('caps the line length', () => {
    report('x'.repeat(DIAG_REPORT_MAX * 3))

    expect(lines).toEqual([`[player][diag] renderer ${'x'.repeat(DIAG_REPORT_MAX)}`])
  })
})
