// The window icon (#686). `createWindow` loads it from `<app>/resources/` next
// to the bundled `out/main`. In a packaged build `<app>` is `app.asar`, which
// holds only what `build.files` lists, so a path the code builds but the config
// doesn't ship fails at runtime and only in the package.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { windowIconPath } from '../src/main/window-icon'

const ROOT = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  build: { files: string[] }
}

describe('windowIconPath', () => {
  it('picks the .ico on Windows and the .png elsewhere', () => {
    expect(windowIconPath('/app/out/main', 'win32')).toBe(join('/app/resources/icon.ico'))
    expect(windowIconPath('/app/out/main', 'linux')).toBe(join('/app/resources/icon.png'))
    expect(windowIconPath('/app/out/main', 'darwin')).toBe(join('/app/resources/icon.png'))
  })

  it.each(['win32', 'linux', 'darwin'] as const)(
    'the window icon path the main process builds is shipped by `build.files` (%s)',
    (platform) => {
      const asar = '/pkg/app.asar'
      const inArchive = relative(asar, windowIconPath(join(asar, 'out/main'), platform))
        .split(sep)
        .join('/')
      expect(inArchive).toMatch(/^resources\/icon\.(ico|png)$/)
      expect(pkg.build.files).toContain(inArchive)
      expect(existsSync(join(ROOT, inArchive))).toBe(true)
    }
  )
})
