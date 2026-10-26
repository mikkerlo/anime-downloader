import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// #562: every app launch under `e2e*/` goes through `e2e/helpers/profile.ts`,
// which hands the app a seeded temp profile and asserts it reads it. A spec
// that calls `electron.launch` itself is back on a guessed or shared profile
// (`~/.config/Electron`) and downloads ffmpeg + fpcalc on every run.
const ROOT = path.resolve(__dirname, '..')
const HELPER = path.join('e2e', 'helpers', 'profile.ts')
const LAUNCH = /_electron\b|electron\.launch\s*\(/

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name.startsWith('.') || e.name === 'fixtures' ? [] : walk(p)
    return /\.[cm]?[jt]s$/.test(e.name) ? [p] : []
  })
}

describe('e2e launch guard', () => {
  const files = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('e2e'))
    .flatMap((d) => walk(path.join(ROOT, d.name)))
    .map((f) => path.relative(ROOT, f))

  it('scans both e2e suites, helper included', () => {
    expect(files).toContain(HELPER)
    expect(files).toContain(path.join('e2e-syncplay', 'helpers', 'duo.ts'))
    expect(fs.readFileSync(path.join(ROOT, HELPER), 'utf-8')).toMatch(LAUNCH)
  })

  it('only the profile helper launches Electron', () => {
    const offenders = files.filter(
      (f) => f !== HELPER && LAUNCH.test(fs.readFileSync(path.join(ROOT, f), 'utf-8'))
    )
    expect(offenders).toEqual([])
  })
})
