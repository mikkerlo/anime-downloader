// Boots the real Syncplay 1.7.6 server the conformance suite measures against.
//
// The binary is provisioned out of band — `conformance/README.md` has the pip
// line and the commit it pins — and located through `SYNCPLAY_SERVER_BIN`. If it
// is not there this **throws** rather than skipping. A conformance suite that
// quietly reports "0 passed" on a runner with no server is the quiet-degradation
// failure #367's Risks section names: it would still be cited as warrant for the
// model while attesting to nothing.

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

/**
 * The upstream commit the suite is written against. `v1.7.6` is a lightweight
 * tag pointing here, but a tag can be moved and a generated
 * `archive/refs/tags/*.tar.gz` is not byte-stable, so the commit is what the
 * provisioning line pins (#367). Quoted in `conformance/README.md`, `docs/syncplay.md` and both
 * Syncplay workflows; `test/{conformance,syncplay-e2e}-workflow.test.ts` hold them all equal.
 */
export const SYNCPLAY_PINNED_COMMIT = '993232ab095bb810593459bc705b3e6fc64ad161'

/** What the server reports for `syncplay-server --version`, and claims on the wire. */
export const SYNCPLAY_PINNED_VERSION = '1.7.6'

export function serverBin(): string {
  return process.env.SYNCPLAY_SERVER_BIN ?? 'syncplay-server'
}

/** One connect attempt. `true` means something completed a handshake on the port. */
export async function connects(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => {
      sock.destroy()
      resolve(false)
    })
  })
}

/**
 * Waits until the probe socket is not merely `close()`d but actually refusing.
 *
 * `close()`'s callback is not the end of the port's life: for a short window
 * after it fires the kernel still completes the handshake on that port, so a
 * connect succeeds against a server that no longer exists. Measured on this
 * tree's loopback: the window runs 7-11 ms and answers forty-odd consecutive
 * connects inside it.
 *
 * That window is exactly where `waitForListen()` takes its first sample — it is
 * called a few hundred microseconds after `spawn` — so without this the harness
 * reads the probe's own corpse as "the server is up". Two observed consequences,
 * both of which this closes: `bootRealServer()` *succeeded* in 9 ms with
 * `SYNCPLAY_SERVER_BIN=/nonexistent`, making the header's "this **throws**
 * rather than skipping" claim false; and on a run where the real server took a
 * moment longer than usual to bind, the first scenario file started against a
 * port nothing was listening on yet and failed all five of its tests with
 * `ECONNREFUSED` while the rest of the suite passed — a dead-reference run
 * wearing the shape of a partial divergence.
 */
async function waitForRefused(port: number, deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs
  while (await connects(port)) {
    if (Date.now() > until) {
      throw new Error(`port ${port} was still accepting connections after ${deadlineMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

export async function freePort(): Promise<number> {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address()
      if (typeof addr === 'string' || addr === null) {
        probe.close(() => reject(new Error('could not read an ephemeral port')))
        return
      }
      const p = addr.port
      probe.close(() => resolve(p))
    })
  })
  await waitForRefused(port, 2000)
  return port
}

async function waitForListen(port: number, deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs
  for (;;) {
    if (await connects(port)) return
    if (Date.now() > until) throw new Error(`syncplay-server did not listen on ${port} in time`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

export interface RealServer {
  port: number
  /** The server's pid, so a caller that owns other processes can tear down by
   *  explicit pid (`pkill -f syncplay-server` matches the shell that ran it). */
  pid: number | undefined
  stop: () => Promise<void>
}

export interface RealServerOptions {
  /**
   * Whether the server runs its readiness feature. **Off by default**, which is
   * what the conformance suite wants: it compares the playstate election, and
   * the readiness seam is `test/services/syncplay-two-peer-loop.test.ts`'s.
   * Leaving readiness on there would add `Set: {ready}` traffic the model never
   * sends, for no observable the suite reads.
   *
   * The two-instance e2e rig (`e2e-syncplay/`, #489) passes `true`: its P8 / P9
   * rows are *about* the ready gate, and a server started with
   * `--disable-ready` would make them vacuous.
   */
  readiness?: boolean
  /**
   * A directory holding `privkey.pem`, `cert.pem` and `chain.pem`, handed to
   * `--tls`. The app's client is TLS-only, so the e2e rig needs it; the
   * conformance wire peers speak plaintext and leave it unset. A directory
   * missing one of the three makes the server silently serve plaintext rather
   * than fail, so `e2e-syncplay/helpers/tls.ts` probes the upgrade afterwards.
   */
  tlsDir?: string
}

/** The argv `bootRealServer()` spawns the server with. Pure, so the flag set
 *  is testable on a runner with no server (`test/conformance-harness.test.ts`). */
export function serverArgs(port: number, opts: RealServerOptions = {}): string[] {
  const args = ['--port', String(port)]
  if (!opts.readiness) args.push('--disable-ready')
  if (opts.tlsDir) args.push('--tls', opts.tlsDir)
  return args
}

/**
 * One server process for the whole run, with every scenario in its own room.
 * Room state in the reference lives on `Room` (`server.py:535`) and rooms do not
 * observe each other, so a fresh room name is as isolating as a fresh process
 * and costs ~1.6 s less per scenario.
 *
 * The flags are `serverArgs()`'s; see `RealServerOptions` for why readiness is
 * off unless a caller asks for it.
 */
export async function bootRealServer(opts: RealServerOptions = {}): Promise<RealServer> {
  const port = await freePort()
  const bin = serverBin()
  let proc: ChildProcess
  try {
    proc = spawn(bin, serverArgs(port, opts), {
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    // Reachable only for a synchronous `spawn` throw — a malformed argument or
    // option object. A *missing* binary does not come through here: `spawn`
    // returns a `ChildProcess` and reports `ENOENT` asynchronously on `error`,
    // which is what `spawnFailed` below is for.
    throw new Error(`could not spawn ${bin}: ${String(err)} — see conformance/README.md`)
  }
  let stderr = ''
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString()
  })
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
  let stopping = false
  proc.on('exit', (code, signal) => {
    exited = { code, signal }
    // A server that dies mid-run reports itself as `ECONNREFUSED` on whatever
    // scenario connects next, which names the port and nothing else — and the
    // scenarios that already ran still passed, so the summary reads as a partial
    // divergence rather than as a dead reference. Observed once here, on a box
    // running the coverage suite and an Electron build alongside the harness.
    // The one thing that distinguishes the two is this line, so it goes to
    // stderr the moment it happens rather than into a failure message nobody
    // reaches.
    if (!stopping) {
      process.stderr.write(
        `[conformance] syncplay-server exited mid-run (${JSON.stringify({ code, signal })}) ` +
          `on port ${port}. Every scenario after this one fails with ECONNREFUSED and is ` +
          `reporting the dead server, not a divergence. stderr:\n${stderr}\n`
      )
    }
  })
  // The asynchronous half of a failed `spawn`, raced against `waitForListen()`
  // below. A wrong or unset `SYNCPLAY_SERVER_BIN` arrives here as `ENOENT`
  // within a millisecond or two; without the race the harness would ignore it
  // and spend the full 20 s timeout before reporting "failed to come up", which
  // says nothing about the one thing that was actually wrong. The `.catch()` is
  // required rather than tidy: when `waitForListen()` wins the race — the normal
  // path, every run — this promise stays pending forever, and a later `error`
  // (a signal delivery failure at teardown, say) would otherwise reject with no
  // handler attached and take the process down as an unhandled rejection.
  const spawnFailed = new Promise<never>((_, reject) => {
    proc.on('error', (err) => {
      stderr += `spawn error: ${err.message}\n`
      reject(
        new Error(
          `could not spawn ${bin}: ${err.message} — set SYNCPLAY_SERVER_BIN to a ` +
            `syncplay-server built from ${SYNCPLAY_PINNED_COMMIT}. See conformance/README.md.`
        )
      )
    })
  })
  spawnFailed.catch(() => {})

  try {
    await Promise.race([waitForListen(port, 20000), spawnFailed])
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('could not spawn ')) throw err
    const why = exited ? ` (process exited: ${JSON.stringify(exited)})` : ''
    throw new Error(
      `${bin} failed to come up${why}. stderr:\n${stderr}\n` +
        `Provision it with: pip install git+https://github.com/Syncplay/syncplay@${SYNCPLAY_PINNED_COMMIT}\n` +
        `then point SYNCPLAY_SERVER_BIN at the resulting syncplay-server. See conformance/README.md.`
    )
  }

  return {
    port,
    pid: proc.pid,
    stop: async () => {
      stopping = true
      if (proc.exitCode !== null) return
      await new Promise<void>((resolve) => {
        // The SIGKILL timer has to be cleared on the normal path. `resolve()`
        // settles the promise but does not disarm a pending `setTimeout`, so
        // without this the timer stays on the event loop after teardown, holds
        // the process open until it fires, and then signals a pid that is
        // already gone — the shape vitest reports as a leaked handle.
        const hard = setTimeout(() => {
          proc.kill('SIGKILL')
          resolve()
        }, 3000)
        proc.once('exit', () => {
          clearTimeout(hard)
          resolve()
        })
        proc.kill('SIGTERM')
      })
    }
  }
}
