# Syncplay investigation artifacts (2026-10)

Raw artifacts behind issues #486, #487 and #488 and the test-suite plan #489.
All `src/...:NNN` line numbers in these files are anchored to ff432c1 (v4.6.167).

These are verbatim research artifacts: references and a starting point for #489,
not maintained tooling. The scripts contain absolute scratchpad paths from the
investigation session (`/tmp/claude-1000/.../scratchpad`, `.claude/worktrees/agent-*`)
and need path adjustment to rerun. The directory is excluded from ESLint and
Prettier. Vitest, `tsc` and the `check:*` gates never reach it because they only
scan explicitly named roots.

No credential is stored here. The real-stream probes read an API token from a
file that the user supplies at run time (`TOKEN_FILE`), write it only into a
throwaway XDG profile that is deleted after each series, and redact
`access_token=` from anything they log. Stream URLs in the outputs are truncated
signed CDN routes that have already expired.
CDN query strings in the committed outputs (including the gzipped traces) were redacted to `?<redacted>`; scheme, host and path are kept.

## `solo/`: solo next-episode probes (no repro)

Single real Electron instance, no room. Measures where the next episode starts
after pressing "next".

- `probe.cjs`, `probe2.cjs`: open the built PlayerView on local media
  (`media/ep{1,2}.{mp4,mkv}`, not committed), seek to `T_SEEK`, press next, and
  record where ep2 lands and every watch-progress save. Env: `MODE=stream|mp4|mkv`,
  `TRIALS`, `T_SEEK`, `PRE_NEXT_MS`. Run with `xvfb-run -a node probe2.cjs`.
- `real-probe.cjs`: the same check against real smotret streams with every
  main-process handler real. Needs a build of main at ff432c1 at
  `src-copy/out/main/index.js`. Run with
  `TOKEN_FILE=$PWD/token xvfb-run -a node real-probe.cjs > real-probe.jsonl 2> real-probe.err`.
- `real-probe.jsonl`: output of the full run. `smoke.jsonl`: output of the smoke run.

## `duo/`: two-instance real-server Syncplay harness (#489)

Two real Electron instances (the ff432c1 build from `../solo/src-copy`), one local
Syncplay 1.7.6 server with TLS on port 18999, and real streams. This is the
main asset for #489. See the harness pitfalls listed there: TLS dir and IP SAN,
`NODE_EXTRA_CA_CERTS`, `SYNCPLAY_DEBUG`, copying ffmpeg into the profile, and
launching muted and unfocused.

- `duo-probe.cjs`: the harness. It seeds two throwaway profiles, joins both to a
  fresh room, runs the scenario plan for each series, and writes one result row
  per transition to stdout and the raw per-instance traces (media events, wire
  frames, main-log lines) to `traces.jsonl`. Run once per run number with
  `TOKEN_FILE=<path> xvfb-run -a -s "-screen 0 2700x1000x24" node duo-probe.cjs > runN-results.jsonl`,
  then rename `traces.jsonl` to `runN-traces.jsonl`. Env: `ONLY=<series,...>`,
  `LIMIT=<n scenarios>`, `RELAY_MS=<one-way delay>`.
- `relay.cjs`: byte-level TCP relay with an equal one-way delay
  (`node relay.cjs <listenPort> <targetPort> <delayMs>`). `duo-probe.cjs`
  spawns it when `relayMs > 0`.
- `tls-probe.cjs`: checks that the local server's startTLS handshake verifies
  against `tls/ca.pem` (`node tls-probe.cjs 18999`).
- `run{1,2,3}-results.jsonl`: per-transition results of the three runs.
- `run{1,2,3}-traces.jsonl.gz`: raw traces, gzipped (about 2.3 MB uncompressed,
  and `run3` exceeds jj's 1 MiB snapshot limit). Run `gunzip -k run*-traces.jsonl.gz`
  before using the jq scripts on them.
- `smoke.jsonl`: output of the smoke run.
- `merge.sh` + `analyze.jq`: merge the transition rows of all three runs into
  `all.json` (`sh merge.sh`).
- `tables.jq`: tallies over `all.json` (`jq -f tables.jq all.json`).
- `excursion.jq` produces `excursions.jsonl`, the per-transition and per-instance
  stale-position excursion on the new source
  (`jq -c -f excursion.jq runN-traces.jsonl`).
- `zeroseek.jsonl`: a per-transition `zeroSeek` flag (run, series, idx), derived from the traces.
- `timeline.jq`: one transition's merged A/B timeline, e.g.
  `jq -r --arg s Frieren --argjson i 3 --argjson lo -1500 --argjson hi 4000 -f timeline.jq run3-traces.jsonl`.

## `episode-change/`: in-process episode-change probes (#486)

Vitest probes on the two-peer harness (`test/helpers/syncplay-two-peer.ts`) for
the episode-change position carry-over.

- `probe-360.test.ts`: trace of one switch across heartbeat phases. Output: `probe.txt`.
- `probe-360b.test.ts`: scenario grid (S1/S3, lag, seat skew, bind gap). Output: `probeb.txt`.
- `probe-360c.test.ts`: per-scenario event timelines. Outputs: `probec.txt` and `probec2.txt`.
- `probe-360d.test.ts`: prototype of the reference client's fix. It sends a room
  seek to 0 alongside `Set{file}` and holds the outgoing element's snapshots
  until the new element binds, monkey-patched onto the real client.
  Modes are selected with `MODES`: `off` (unpatched), `seek0` (seek plus hold)
  and `seek0-noq` (seek without the hold). Outputs: `probed.txt` (`off,seek0`)
  and `probed-noq.txt` (`seek0-noq`).

Each probe writes to `PROBE_OUT` (default `/tmp/probe-360*.txt`).

## `double-next/`: both peers press next (#487)

- `syncplay-two-peer-double-next.probe.test.ts`: both peers press "next episode"
  d ms apart. It uses the real main client, the real composable, and the real
  `walkEpisodeSteps` under a model of PlayerView navigation. Its source-scan
  block pins the properties of the real code that the model relies on.
- `probe-run1.txt`: vitest output of that probe.
- `both.jq`: one row per "both pressed" transition from the duo runs
  (`jq -s -f both.jq runN-{results,traces}.jsonl`).
- `tl.jq` + `tl.sh`: timeline of one transition across all three runs
  (`tl.sh <series> <idx> [lo] [hi]`).

## `seek-revert/`: in-flight seek reverted by a room frame (#488)

- `zz-probe-seek-revert.test.ts`: a user seek still in flight when the next room
  frame lands, swept over landing time and heartbeat phase. Output: `sweep.out`.
- `seeks.jsonl`: every `seeking` outcome in the duo traces (`dur.jq`).
- `dur.jq`: seek completion or abort durations (`jq -c -f dur.jq runN-traces.jsonl`).
- `inflight.jq`: wire frames that land while a seek is in flight.
- `tl.jq`: per-instance timeline of one transition
  (`jq -r --arg s <series> --argjson i <idx> --arg k A -f tl.jq runN-traces.jsonl`).

## Running a probe test

The `*.test.ts` probes import from `../helpers/...` and `../../src/...` relative
to `test/services/`, so they cannot run from here. To run one, copy it back into
`test/services/` and run `npx vitest run test/services/<file>`. Do not commit the copy.
