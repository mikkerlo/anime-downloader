import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAnimeDetailPrefs } from '../../../src/renderer/src/composables/use-anime-detail-prefs'

type Api = { getSetting: (key: string) => Promise<unknown> }

function setApi(api: Partial<Api>): void {
  ;(globalThis as { window?: { api: Partial<Api> } }).window = { api }
}

function makeMeta(episodeInt: string, translationType: string, author: string): EpisodeMeta {
  return {
    episodeInt,
    translationId: 1,
    translationType,
    author,
    height: 720
  } as unknown as EpisodeMeta
}

beforeEach(() => {
  setApi({})
})

describe('useAnimeDetailPrefs', () => {
  it('defaults translationType to subRu and selectedAuthor empty', () => {
    const { translationType, selectedAuthor } = useAnimeDetailPrefs()
    expect(translationType.value).toBe('subRu')
    expect(selectedAuthor.value).toBe('')
  })

  it('loadInitialTranslationType uses initialPrefs over storage', async () => {
    const getSetting = vi.fn().mockResolvedValue('subEn')
    setApi({ getSetting })
    const prefs = useAnimeDetailPrefs()
    await prefs.loadInitialTranslationType('voiceRu')
    expect(prefs.translationType.value).toBe('voiceRu')
    expect(getSetting).not.toHaveBeenCalled()
  })

  it('loadInitialTranslationType falls back to storage and subRu default', async () => {
    setApi({ getSetting: vi.fn().mockResolvedValue(null) })
    const prefs = useAnimeDetailPrefs()
    await prefs.loadInitialTranslationType()
    expect(prefs.translationType.value).toBe('subRu')
  })

  it('applyDownloadedTranslationDefault picks the highest-frequency combo', () => {
    const prefs = useAnimeDetailPrefs()
    prefs.applyDownloadedTranslationDefault({
      episodeMeta: {
        '1': [makeMeta('1', 'voiceRu', 'AniLibria')],
        '2': [makeMeta('2', 'voiceRu', 'AniLibria')],
        '3': [makeMeta('3', 'subRu', 'Anidub')]
      },
      availableAuthors: [
        ['AniLibria', 2],
        ['Anidub', 1]
      ]
    })
    expect(prefs.translationType.value).toBe('voiceRu')
    expect(prefs.selectedAuthor.value).toBe('AniLibria')
  })

  it('applyDownloadedTranslationDefault only sets author if present in availableAuthors', () => {
    const prefs = useAnimeDetailPrefs()
    prefs.applyDownloadedTranslationDefault({
      episodeMeta: { '1': [makeMeta('1', 'subRu', 'GhostStudio')] },
      // GhostStudio is the most-downloaded but the dropdown doesn't expose it.
      availableAuthors: [['Anidub', 1]]
    })
    expect(prefs.translationType.value).toBe('subRu')
    expect(prefs.selectedAuthor.value).toBe('')
  })

  it('applyDownloadedTranslationDefault is a no-op with empty episodeMeta', () => {
    const prefs = useAnimeDetailPrefs()
    prefs.applyDownloadedTranslationDefault({ episodeMeta: {}, availableAuthors: [] })
    expect(prefs.translationType.value).toBe('subRu')
    expect(prefs.selectedAuthor.value).toBe('')
  })
})
