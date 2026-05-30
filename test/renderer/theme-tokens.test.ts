import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve } from 'path'

// Foundation guard tests (#161). These run in the default node env — no DOM
// needed; they read source files directly.

const RENDERER_DIR = resolve(__dirname, '../../src/renderer')
const THEME_CSS = resolve(RENDERER_DIR, 'src/assets/theme.css')

describe('Refined Dark theme tokens', () => {
  const css = readFileSync(THEME_CSS, 'utf8')

  it('locks the accent to #ef4d67', () => {
    // Fails if the palette is reverted to the old coral (#e94560) or any other.
    expect(css).toMatch(/--accent:\s*#ef4d67\b/i)
  })

  it('defines the core surface, text, and border tokens on :root', () => {
    expect(css).toMatch(/:root\s*\{/)
    for (const token of ['--bg', '--surface', '--surface-2', '--text', '--text-2', '--border']) {
      expect(css, `missing ${token}`).toMatch(new RegExp(`${token}:\\s*#`, 'i'))
    }
  })

  it('declares the bundled font families (Manrope + JetBrains Mono)', () => {
    expect(css).toMatch(/--font-ui:[^;]*Manrope/i)
    expect(css).toMatch(/--font-data:[^;]*JetBrains Mono/i)
  })
})

describe('offline-font guard', () => {
  // A stray CDN reference (Google Fonts, a remote url()) is invisible until
  // someone runs offline. Scan our own renderer CSS / .vue / .html source for
  // remote references and fail loudly. (Bundled @fontsource lives in
  // node_modules and uses relative url(./files/…), so it is not scanned.)
  function collectSource(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'out' || entry === 'dist') continue
      const full = resolve(dir, entry)
      if (statSync(full).isDirectory()) collectSource(full, acc)
      else if (/\.(css|vue|html)$/.test(entry)) acc.push(full)
    }
    return acc
  }

  const files = collectSource(RENDERER_DIR)

  it('finds renderer source files to scan', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('contains no remote url() or @import in renderer source', () => {
    const offenders: string[] = []
    const remoteUrl = /url\(\s*['"]?https?:\/\//i
    const remoteImport = /@import\s+(url\()?\s*['"]?https?:\/\//i
    const googleFonts = /fonts\.(googleapis|gstatic)\.com/i
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      if (remoteUrl.test(content) || remoteImport.test(content) || googleFonts.test(content)) {
        offenders.push(file)
      }
    }
    expect(offenders, `remote font/asset reference(s) found in: ${offenders.join(', ')}`).toEqual(
      []
    )
  })
})
