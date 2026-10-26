// CI's system setup (#591), asserted from the PR gate.
//
// `quality` and the three `syncplay-e2e` shards used to `apt-get install
// ffmpeg` plus the Electron runtime libs, and a crawling Azure mirror held them
// for up to 44 minutes; one shard's suite was cancelled by the job limit. Now:
//
//  - ffmpeg is the app's own pinned static 6.1 build, fetched by
//    `scripts/ci-install-ffmpeg.sh` from the URLs `archiveUrl()` builds, behind
//    two sha256 pins, with no cache;
//  - `scripts/ci-electron-libs.sh` only checks the nine preinstalled packages
//    and falls back to apt, under timed mirror rotation, when one is missing;
//  - every setup step has its own budget and `quality` has a job limit.
//
// The workflows are read as text, like test/syncplay-e2e-workflow.test.ts. The
// lib script also runs here against stub `sudo`/`dpkg-query`/`apt-get`/
// `timeout` binaries, so its fallback is exercised without touching apt.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { archiveUrl } from '../src/main/ffmpeg-binaries'
import { FFMPEG, FFPROBE, hasRealFfmpeg } from '../e2e/helpers/tick-fixture'

const ROOT = join(import.meta.dirname, '..')
// '' for a missing file, so an assertion reds rather than the import.
const read = (...p: string[]): string => {
  try {
    return fs.readFileSync(join(ROOT, ...p), 'utf8')
  } catch {
    return ''
  }
}

// Comments explain why apt is gone and name what not to do, so the negative
// assertions read only the lines that run.
const code = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

// One top-level job of the workflow: from its `  <name>:` line to the next
// two-space-indented key, or the end of the file.
const jobBlock = (yml: string, name: string): string => {
  const start = yml.indexOf(`\n  ${name}:\n`)
  if (start < 0) return ''
  const rest = yml.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z]/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

// The steps of a job, one string each, split on the `      - ` list marker.
const stepsOf = (job: string): string[] => job.split('\n      - ').slice(1)

const FFMPEG_SCRIPT = 'scripts/ci-install-ffmpeg.sh'
const LIBS_SCRIPT = 'scripts/ci-electron-libs.sh'

const LIBS = [
  'xvfb',
  'libnss3',
  'libatk1.0-0t64',
  'libatk-bridge2.0-0t64',
  'libgtk-3-0t64',
  'libgbm1',
  'libasound2t64',
  'libxshmfence1',
  'libdrm2'
]

const jobs = [
  { workflow: 'check.yml', job: 'quality', ffmpegBefore: 'npm run test:coverage' },
  { workflow: 'syncplay-e2e.yml', job: 'syncplay-e2e', ffmpegBefore: 'gen:syncplay-fixtures' }
]

describe('CI setup in each job that runs real ffmpeg and Electron (#591)', () => {
  for (const { workflow, job, ffmpegBefore } of jobs) {
    const yml = read('.github', 'workflows', workflow)
    const block = jobBlock(yml, job)
    const steps = stepsOf(block)
    const index = (marker: string): number => steps.findIndex((s) => s.includes(marker))

    it(`${workflow}: installs no ffmpeg from apt, and runs no apt outside the lib script`, () => {
      expect(block).not.toBe('')
      expect(code(yml)).not.toMatch(/apt(-get)?\s+install[^\n]*\bffmpeg\b/)
      expect(code(block)).not.toMatch(/\bapt(-get)?\b/)
    })

    it(`${workflow}: installs the pinned static ffmpeg before its first use, on a 5-minute budget`, () => {
      const i = index(`run: bash ${FFMPEG_SCRIPT}\n`)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(steps[i]).toMatch(/\n {8}timeout-minutes: 5\n/)
      const use = index(ffmpegBefore)
      expect(use).toBeGreaterThan(i)
    })

    it(`${workflow}: checks the Electron libs before the first xvfb run, on a 12-minute budget`, () => {
      const i = index(`run: bash ${LIBS_SCRIPT}\n`)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(steps[i]).toMatch(/\n {8}timeout-minutes: 12\n/)
      const firstXvfb = steps.findIndex((s) => /xvfb-run|test:e2e/.test(s))
      expect(firstXvfb).toBeGreaterThan(i)
    })

    it(`${workflow}: caches no ffmpeg`, () => {
      expect(block).not.toContain('actions/cache')
    })
  }

  it('gives quality a job limit, not the 360-minute default', () => {
    expect(jobBlock(read('.github', 'workflows', 'check.yml'), 'quality')).toMatch(
      /\n {4}timeout-minutes: 25\n/
    )
  })

  it('runs the syncplay suite on PRs that change either setup script', () => {
    const yml = read('.github', 'workflows', 'syncplay-e2e.yml')
    expect(yml).toContain(`- '${FFMPEG_SCRIPT}'`)
    expect(yml).toContain(`- '${LIBS_SCRIPT}'`)
  })
})

describe('scripts/ci-install-ffmpeg.sh', () => {
  const script = read(FFMPEG_SCRIPT)

  it("downloads exactly the app's own linux-64 archives, so the two cannot drift", () => {
    const urls = script.match(/https:\/\/\S+\.zip/g)
    expect(urls).toEqual([archiveUrl('ffmpeg', 'linux-64'), archiveUrl('ffprobe', 'linux-64')])
  })

  it('pins both archives by sha256', () => {
    const pins = script.match(/^[0-9a-f]{64} {2}\S+$/gm) ?? []
    expect(pins.map((p) => p.slice(66))).toEqual(['ffmpeg.zip', 'ffprobe.zip'])
    expect(script).toMatch(/\nsha256sum -c - <<'EOF'\n/)
  })

  it('retries and aborts a crawl instead of waiting it out', () => {
    expect(script).toContain('curl -fsSL --retry 5 --speed-limit 100000 --speed-time 30 ')
  })

  describe.skipIf(process.platform === 'win32')('run against a stub curl', () => {
    let dir: string
    beforeEach(() => {
      dir = fs.mkdtempSync(join(os.tmpdir(), 'ci-ffmpeg-'))
      fs.mkdirSync(join(dir, 'bin'))
      fs.mkdirSync(join(dir, 'dest'))
      // Writes junk where the archive should be.
      fs.writeFileSync(
        join(dir, 'bin', 'curl'),
        '#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\necho not-a-zip > "$2"\n',
        { mode: 0o755 }
      )
    })
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    it('installs nothing when an archive does not match its pin', () => {
      const r = spawnSync('bash', [join(ROOT, FFMPEG_SCRIPT)], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          FFMPEG_INSTALL_DIR: join(dir, 'dest')
        }
      })
      expect(r.status).not.toBe(0)
      expect(r.stdout).toContain('ffmpeg.zip: FAILED')
      expect(fs.readdirSync(join(dir, 'dest'))).toEqual([])
    })
  })
})

describe('scripts/ci-electron-libs.sh', () => {
  const script = read(LIBS_SCRIPT)

  it('checks exactly the nine packages, by their installed t64 names', () => {
    const list = /\npkgs=\(([^)]*)\)\n/.exec(script)?.[1].split(' ')
    expect(list).toEqual(LIBS)
  })

  it('reads the arch-qualified status, not the exit code of dpkg -s', () => {
    expect(script).toContain(`dpkg-query -W -f='\${db:Status-Abbrev}' "$p:$arch"`)
    expect(script).toContain("!= 'ii '")
    expect(code(script)).not.toMatch(/dpkg -s\b/)
  })

  it('times update and the download, overrides no apt setting, and fails when every mirror does', () => {
    expect(script).toContain('sudo timeout -k 10 60 apt-get update ')
    expect(script).toMatch(/sudo timeout -k 10 150 apt-get install [^\n]*--download-only/)
    expect(code(script)).not.toContain('Acquire::')
    expect(script).toMatch(/echo '::error::apt failed on every mirror[^\n]*'\n {2}exit 1\n/)
  })

  describe.skipIf(process.platform === 'win32')('run against stub apt binaries', () => {
    let dir: string
    const stub = (name: string, body: string): void =>
      fs.writeFileSync(join(dir, 'bin', name), `#!/bin/sh\n${body}`, { mode: 0o755 })
    const mirror = 'head -n1 "$STUB/mirrors.txt" 2>/dev/null | cut -f1'

    beforeEach(() => {
      dir = fs.mkdtempSync(join(os.tmpdir(), 'ci-libs-'))
      fs.mkdirSync(join(dir, 'bin'))
      // The deb822 sources as today's runner image writes them (APT_ETC).
      fs.mkdirSync(join(dir, 'etc', 'sources.list.d'), { recursive: true })
      fs.writeFileSync(
        join(dir, 'etc', 'sources.list.d', 'ubuntu.sources'),
        'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates\n'
      )
      // `sudo tee <list>` lands in the scratch dir; anything else just runs.
      stub('sudo', 'if [ "$1" = tee ]; then exec tee "$STUB/mirrors.txt"; fi\nexec "$@"\n')
      stub('dpkg', 'echo amd64\n')
      // $3 is `<pkg>:<arch>`. MISSING stays absent until the real install ran.
      stub(
        'dpkg-query',
        'p=${3%%:*}\n' +
          'if [ "$p" = "$MISSING" ] && [ ! -e "$STUB/installed" ]; then exit 1; fi\n' +
          "printf 'ii '\n"
      )
      // A mirror listed in STALL "hangs": timeout reports 124 as if it fired.
      stub(
        'timeout',
        'shift 3\n' +
          `m=$(${mirror})\n` +
          'case " $STALL " in *" $m "*) exit 124 ;; esac\n' +
          'exec "$@"\n'
      )
      stub(
        'apt-get',
        `echo "$(${mirror}) $*" >> "$STUB/calls"\n` +
          'case "$*" in *install*) case "$*" in *--download-only*) ;; *) touch "$STUB/installed" ;; esac ;; esac\n'
      )
    })
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    const run = (env: Record<string, string>): ReturnType<typeof spawnSync> =>
      spawnSync('bash', [join(ROOT, LIBS_SCRIPT)], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          STUB: dir,
          APT_ETC: join(dir, 'etc'),
          MISSING: '',
          STALL: '',
          ...env
        }
      })
    const calls = (): string[] => {
      try {
        return fs.readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
      } catch {
        return []
      }
    }

    it('makes no apt call when every package is installed', () => {
      const r = run({})
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('All 9 Electron runtime packages are installed')
      expect(calls()).toEqual([])
      expect(fs.existsSync(join(dir, 'mirrors.txt'))).toBe(false)
    })

    it('rotates past a stalled mirror, then installs from the downloaded set', () => {
      const r = run({ MISSING: 'libgbm1', STALL: 'https://archive.ubuntu.com/ubuntu/' })
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('::warning::Not installed: libgbm1')
      expect(r.stdout).not.toContain('mirror rotation has no effect')
      expect(r.stdout).toContain(
        '::warning::apt stalled or failed on https://archive.ubuntu.com/ubuntu/; rotating mirror'
      )
      // The stalled attempt never reached apt; the second mirror did all three calls.
      const azure = 'http://azure.archive.ubuntu.com/ubuntu/'
      const pkgs = LIBS.join(' ')
      expect(calls()).toEqual([
        `${azure} update -q`,
        `${azure} install -yq --no-install-recommends --download-only ${pkgs}`,
        `${azure} install -yq --no-install-recommends ${pkgs}`
      ])
      expect(fs.readFileSync(join(dir, 'mirrors.txt'), 'utf8')).toBe(
        `${azure}\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n` +
          'https://security.ubuntu.com/ubuntu/\tpriority:3\n'
      )
    })

    it('fails, without an untimed install, when every mirror stalls', () => {
      const r = run({
        MISSING: 'xvfb',
        STALL:
          'https://archive.ubuntu.com/ubuntu/ http://azure.archive.ubuntu.com/ubuntu/ ' +
          'http://mirrors.edge.kernel.org/ubuntu/'
      })
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('::error::apt failed on every mirror; giving up')
      expect(calls()).toEqual([])
      expect(fs.existsSync(join(dir, 'installed'))).toBe(false)
    })

    it('warns that rotation has no effect when the sources do not read the mirror list', () => {
      fs.writeFileSync(
        join(dir, 'etc', 'sources.list.d', 'ubuntu.sources'),
        'Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates\n'
      )
      const r = run({ MISSING: 'libgbm1' })
      expect(r.stdout).toContain(
        '::warning::apt sources do not read /etc/apt/apt-mirrors.txt; mirror rotation has no effect on this image'
      )
      // It degrades to the image's own sources: the attempts still run.
      expect(r.status).toBe(0)
      expect(calls()).toHaveLength(3)
    })

    it('fails when a package is still missing after apt succeeded', () => {
      stub('apt-get', 'exit 0\n') // succeeds, installs nothing
      const r = run({ MISSING: 'libdrm2' })
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('::error::Still not installed after apt: libdrm2')
    })
  })
})

// CI's ffmpeg is in /usr/local/bin now, so the @mkv-sync fixture must find it
// the way every other consumer does. It used to gate on
// `fs.existsSync('/usr/bin/ffmpeg')`, which a PATH-only install fails.
describe.skipIf(process.platform === 'win32')(
  'e2e/helpers/tick-fixture.ts resolves ffmpeg from PATH',
  () => {
    let dir: string
    let savedPath: string | undefined
    beforeEach(() => {
      dir = fs.mkdtempSync(join(os.tmpdir(), 'ci-tick-path-'))
      savedPath = process.env.PATH
    })
    afterEach(() => {
      process.env.PATH = savedPath
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('uses the bare names', () => {
      expect([FFMPEG, FFPROBE]).toEqual(['ffmpeg', 'ffprobe'])
    })

    it('finds an ffmpeg with libx264 that is only on PATH', () => {
      fs.writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\necho " V....D libx264"\n', { mode: 0o755 })
      fs.writeFileSync(join(dir, 'ffprobe'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      process.env.PATH = dir
      expect(hasRealFfmpeg()).toBe(true)
    })

    it('reports none when PATH has none, wherever else one is installed', () => {
      process.env.PATH = dir
      expect(hasRealFfmpeg()).toBe(false)
    })
  }
)
