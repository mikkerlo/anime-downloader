// Shared translation-type metadata used by ControlsBar, EpisodeList,
// EpisodeRow. Phase 5 slice 5c (#118).

export interface TranslationTypeMeta {
  value: string
  label: string
  short: string
  color: string
}

export const TRANSLATION_TYPES: TranslationTypeMeta[] = [
  { value: 'subRu', label: 'Russian Subtitles', short: 'RU SUB', color: '#6ab04c' },
  { value: 'subEn', label: 'English Subtitles', short: 'EN SUB', color: '#3498db' },
  { value: 'voiceRu', label: 'Russian Voice', short: 'RU DUB', color: '#e94560' },
  { value: 'voiceEn', label: 'English Voice', short: 'EN DUB', color: '#9b59b6' },
  { value: 'raw', label: 'RAW', short: 'RAW', color: '#6a6a8a' }
]

export function typeChip(type: string): { short: string; color: string } {
  const t = TRANSLATION_TYPES.find((tt) => tt.value === type)
  return t ? { short: t.short, color: t.color } : { short: type, color: '#6a6a8a' }
}
