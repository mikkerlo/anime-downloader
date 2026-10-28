// A fake fluent-ffmpeg for the ffmpeg-mutex and export-merge tests (#576),
// handed in through `DownloadManager.setFfmpegDriver`. Each command records
// every builder call, runs only when the test says so (`finish` / `fail`),
// and, like fluent-ffmpeg, reports a kill as an 'error'.

import { EventEmitter } from 'events'
import * as fs from 'fs'
import type { FfmpegDriver } from '../../src/main/download-manager'

export class FakeCommand extends EventEmitter {
  readonly inputs: string[]
  readonly calls: { method: string; args: unknown[] }[] = []
  readonly signals: string[] = []
  output_: string | null = null
  ran = false
  settled = false

  constructor(input: string) {
    super()
    this.inputs = [input]
  }

  private record(method: string, args: unknown[]): this {
    this.calls.push({ method, args })
    return this
  }
  input(p: string): this {
    this.inputs.push(p)
    return this.record('input', [p])
  }
  outputOptions(...args: unknown[]): this {
    return this.record('outputOptions', args)
  }
  videoCodec(c: string): this {
    return this.record('videoCodec', [c])
  }
  audioCodec(c: string): this {
    return this.record('audioCodec', [c])
  }
  output(p: string): this {
    this.output_ = p
    return this.record('output', [p])
  }
  run(): void {
    this.ran = true
  }
  kill(signal: string): this {
    this.signals.push(signal)
    // fluent-ffmpeg reports the killed process as an error, after the kill.
    setTimeout(() => this.fail(`ffmpeg was killed with signal ${signal}`), 0)
    return this
  }

  /** The codec `runFfmpeg` asked for. */
  get codec(): string | undefined {
    return this.calls.find((c) => c.method === 'videoCodec')?.args[0] as string | undefined
  }

  /** Every string argument handed to the builder, flattened. */
  get args(): string[] {
    return this.calls.flatMap((c) => c.args.flat().map(String))
  }

  progress(percent: number): void {
    this.emit('progress', { percent })
  }

  /** ffmpeg exits 0: writes `bytes` to the output first. */
  finish(bytes: Buffer | string = 'merged'): void {
    if (this.settled) return
    this.settled = true
    if (this.output_) fs.writeFileSync(this.output_, bytes)
    this.emit('end')
  }

  /** ffmpeg fails with `message`, leaving `partial` bytes at the output when given. */
  fail(message: string, partial?: Buffer | string): void {
    if (this.settled) return
    this.settled = true
    if (partial !== undefined && this.output_) fs.writeFileSync(this.output_, partial)
    this.emit('error', new Error(message))
  }
}

export interface FakeFfmpeg {
  driver: FfmpegDriver
  commands: FakeCommand[]
  /** The video paths `probeDuration` was called with. */
  probes: string[]
  unlinks: string[]
  /** Replaces the probe (default: 60 s). */
  setProbe: (fn: (video: string) => Promise<number>) => void
  /** Called as each command is created. */
  onCreate: ((cmd: FakeCommand) => void) | null
}

export function fakeFfmpeg(): FakeFfmpeg {
  let probe: (video: string) => Promise<number> = async () => 60
  const f: FakeFfmpeg = {
    commands: [],
    probes: [],
    unlinks: [],
    setProbe: (fn) => {
      probe = fn
    },
    onCreate: null,
    driver: {
      createCommand: (input) => {
        const cmd = new FakeCommand(input)
        f.commands.push(cmd)
        f.onCreate?.(cmd)
        return cmd as never
      },
      probeDuration: (_ffmpeg, _ffprobe, video) => {
        f.probes.push(video)
        return probe(video)
      },
      setPriority: () => {},
      unlinkSync: (file) => {
        f.unlinks.push(file)
        fs.unlinkSync(file)
      }
    }
  }
  return f
}

/** Lets timers and I/O run until `cond` holds; throws after `ms`. */
export async function until(cond: () => boolean, what = 'the condition', ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 1))
  }
}

export const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0))
