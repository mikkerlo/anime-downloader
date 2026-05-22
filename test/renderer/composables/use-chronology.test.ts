import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useChronology } from '../../../src/renderer/src/composables/use-chronology'

type Api = { shikimoriGetRelated: (malId: number) => Promise<ShikiRelatedEntry[]> }

function setApi(api: Partial<Api>): void {
  ;(globalThis as { window?: { api: Partial<Api> } }).window = { api }
}

beforeEach(() => {
  setApi({})
})

describe('useChronology', () => {
  it('starts empty, idle, and collapsed', () => {
    const { shikiRelated, relatedLoading, relatedCollapsed } = useChronology()
    expect(shikiRelated.value).toEqual([])
    expect(relatedLoading.value).toBe(false)
    expect(relatedCollapsed.value).toBe(true)
  })

  it('loadRelated fetches via IPC and toggles loading', async () => {
    const fake: ShikiRelatedEntry[] = [
      {
        relation: 'Sequel',
        anime: { id: 1, name: 'Foo', russian: 'Foo', kind: 'tv', episodes: 12 }
      } as unknown as ShikiRelatedEntry
    ]
    const spy = vi.fn().mockResolvedValue(fake)
    setApi({ shikimoriGetRelated: spy })

    const { shikiRelated, relatedLoading, loadRelated } = useChronology()
    const p = loadRelated(123)
    expect(relatedLoading.value).toBe(true)
    await p
    expect(relatedLoading.value).toBe(false)
    expect(spy).toHaveBeenCalledWith(123)
    expect(shikiRelated.value).toEqual(fake)
  })

  it('loadRelated(0) is a no-op', async () => {
    const spy = vi.fn()
    setApi({ shikimoriGetRelated: spy })
    const { loadRelated, relatedLoading } = useChronology()
    await loadRelated(0)
    expect(spy).not.toHaveBeenCalled()
    expect(relatedLoading.value).toBe(false)
  })

  it('still clears loading on IPC failure', async () => {
    const err = new Error('boom')
    setApi({ shikimoriGetRelated: vi.fn().mockRejectedValue(err) })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { loadRelated, relatedLoading, shikiRelated } = useChronology()
    await loadRelated(7)
    expect(relatedLoading.value).toBe(false)
    expect(shikiRelated.value).toEqual([])
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
