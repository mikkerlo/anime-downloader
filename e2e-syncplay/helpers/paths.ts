// Every path the Tier 2 rig touches, derived from the repo root rather than
// written down as an absolute home path (#489 review nit: the investigation
// scripts carried `/home/...` paths and could not be rerun elsewhere).

import path from 'node:path'

export const REPO_ROOT = path.resolve(__dirname, '..', '..')
export const APP_MAIN = path.join(REPO_ROOT, 'out', 'main', 'index.js')
export const FIXTURE_DIR = path.resolve(
  process.env.SYNCPLAY_FIXTURE_DIR ?? path.join(REPO_ROOT, 'e2e-syncplay', '.fixtures')
)
export const GEN_FIXTURES_SCRIPT = path.join(REPO_ROOT, 'scripts', 'gen-syncplay-fixtures.mjs')
/** Per-run scratch (TLS dir, XDG profiles, traces). Gitignored. */
export const RUN_DIR = path.resolve(
  process.env.SYNCPLAY_E2E_RUN_DIR ?? path.join(REPO_ROOT, 'e2e-syncplay', '.run')
)
/** Where failing rows drop their JSONL trace (uploaded by the workflow). */
export const TRACE_DIR = path.join(REPO_ROOT, 'test-results', 'syncplay-traces')
