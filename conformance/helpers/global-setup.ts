// One `syncplay-server` for the whole conformance run.
//
// Booting it per file costs ~1.6 s a file and buys nothing: rooms in the
// reference do not observe each other (`Room`, `server.py:535`), so a scenario's
// own room name is the isolation. `fileParallelism` is off in
// `vitest.conformance.config.ts`, so nothing here has to be re-entrant.

import type { TestProject } from 'vitest/node'
import { bootRealServer, type RealServer } from './real-server'

declare module 'vitest' {
  export interface ProvidedContext {
    syncplayPort: number
  }
}

let server: RealServer | null = null

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  server = await bootRealServer()
  project.provide('syncplayPort', server.port)
  return async () => {
    await server?.stop()
    server = null
  }
}
