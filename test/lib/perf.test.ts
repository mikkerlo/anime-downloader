import { describe, it, expect, vi, afterEach } from 'vitest'
import { markSlow, timeSlowSync } from '../../src/main/lib/perf'

describe('perf probes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('markSlow logs once the threshold is crossed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    markSlow('op', performance.now() - 200, 100)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/\[perf\] op took \d+(\.\d+)?ms/)
  })

  it('markSlow stays silent below the threshold', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    markSlow('op', performance.now(), 100)
    expect(warn).not.toHaveBeenCalled()
  })

  it('timeSlowSync returns the wrapped result and logs through on slow calls', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const nowSpy = vi.spyOn(performance, 'now')
    nowSpy.mockReturnValueOnce(0) // t0
    nowSpy.mockReturnValueOnce(150) // markSlow
    expect(timeSlowSync('op', 100, () => 'value')).toBe('value')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
