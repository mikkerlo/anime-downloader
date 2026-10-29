// `ffprobe -show_format` with a timeout (#592's integrity step), against a fake
// ffprobe script.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { probeDuration } from '../../src/main/lib/probe-duration'

describe.skipIf(process.platform === 'win32')('probeDuration', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  function fake(body: string): string {
    const p = path.join(dir, 'ffprobe')
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return p
  }

  it('reads format.duration', async () => {
    const bin = fake('echo \'{"format":{"duration":"12.5"}}\'')
    await expect(probeDuration(bin, '/x.mp4')).resolves.toEqual({ duration: 12.5 })
  })

  it('a rejected file reports ffprobe’s first stderr line', async () => {
    const bin = fake('echo "moov atom not found" >&2; echo more >&2; exit 1')
    await expect(probeDuration(bin, '/x.mp4')).resolves.toEqual({ error: 'moov atom not found' })
  })

  it('no duration, or output that is not JSON, is an error', async () => {
    await expect(probeDuration(fake('echo \'{"format":{}}\''), '/x')).resolves.toEqual({
      error: 'no duration'
    })
    await expect(probeDuration(fake('echo nope'), '/x')).resolves.toEqual({
      error: 'unreadable ffprobe output'
    })
  })

  it('a hung ffprobe is an error at the timeout', async () => {
    const r = await probeDuration(fake('sleep 5'), '/x', undefined, 200)
    expect('error' in r).toBe(true)
  })

  it('an abort stops it', async () => {
    const ac = new AbortController()
    const running = probeDuration(fake('sleep 5'), '/x', ac.signal)
    ac.abort()
    const r = await running
    expect('error' in r).toBe(true)
  })
})
