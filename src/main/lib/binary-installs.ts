// The first-launch ffmpeg/fpcalc installs, single-flight (#567). Both the boot
// task and the online kick-off start them, and an archive still streaming
// through an offline spell would otherwise race a second install extracting
// into the same directory.

export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return () =>
    (inFlight ??= fn().finally(() => {
      inFlight = null
    }))
}

export interface BinaryInstalls {
  ffmpeg(): Promise<string>
  fpcalc(): Promise<string>
  /** The online kick-off's retry: ffmpeg, then fpcalc, joining any in flight. */
  retry(): Promise<void>
}

export function createBinaryInstalls(deps: {
  ensureFfmpeg: () => Promise<string>
  ensureFpcalc: () => Promise<string>
}): BinaryInstalls {
  const ffmpeg = singleFlight(deps.ensureFfmpeg)
  const fpcalc = singleFlight(deps.ensureFpcalc)
  return {
    ffmpeg,
    fpcalc,
    async retry() {
      await ffmpeg()
      await fpcalc()
    }
  }
}
