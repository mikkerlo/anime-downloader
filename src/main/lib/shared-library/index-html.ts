// `index.html` at a Shared Library's root (#573): a static, script-free page
// listing titles and episodes with links to their relative paths, for someone
// opening the drive without the app. Written only when some name differs from
// the plain download-folder name (`naming.renamed` non-empty). Pure.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const href = (relPath: string): string => relPath.split('/').map(encodeURIComponent).join('/')

/** The page's HTML, or null when `naming.renamed` is empty and no page is written. */
export function renderIndexHtml(manifest: SharedLibraryManifest): string | null {
  if (!manifest.naming || manifest.naming.renamed.length === 0) return null
  const names = new Map(manifest.titles.map((t) => [t.animeId, t.name]))
  const rows = manifest.items.map((item) => {
    const title = names.get(item.animeId) ?? String(item.animeId)
    const links = [`<a href="${escapeHtml(href(item.path))}">${escapeHtml(item.path)}</a>`]
    if (item.subtitlePath !== undefined) {
      links.push(
        `<a href="${escapeHtml(href(item.subtitlePath))}">${escapeHtml(item.subtitlePath)}</a>`
      )
    }
    return `<tr><td>${escapeHtml(title)}</td><td>${escapeHtml(item.episodeInt)}</td><td>${escapeHtml(item.author)}</td><td>${links.join('<br>')}</td></tr>`
  })
  const heading = escapeHtml(manifest.name ?? 'Anime library')
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${heading}</title>`,
    '</head>',
    '<body>',
    `<h1>${heading}</h1>`,
    '<table>',
    '<thead><tr><th>Title</th><th>Episode</th><th>Translation</th><th>File</th></tr></thead>',
    '<tbody>',
    ...rows,
    '</tbody>',
    '</table>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}
