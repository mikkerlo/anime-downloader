// The subtitle stream's metadata in a merged MKV: shared by the download
// queue's merge and the Shared Library export's (#576), so both look the same.

export function subtitleLanguage(translationType: string): string {
  if (
    translationType.endsWith('Ru') ||
    translationType === 'voiceRu' ||
    translationType === 'subRu'
  )
    return 'rus'
  if (
    translationType.endsWith('En') ||
    translationType === 'voiceEn' ||
    translationType === 'subEn'
  )
    return 'eng'
  return 'und'
}

export function subtitleMeta(
  translationType: string,
  author: string
): { language: string; title: string } {
  return { language: subtitleLanguage(translationType), title: author || 'Subtitles' }
}
