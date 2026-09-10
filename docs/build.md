# Build

```bash
npm run dev          # Development with hot reload
npm run build        # Compile to out/
npm run pack:win     # Build + package Windows portable exe
npm run pack:linux   # Build + package Linux AppImage
npm run pack:mac     # Build + package macOS zip
```

Dependencies: electron-vite bundles everything except electron-store (excluded from externalization to handle ESM). FFmpeg + ffprobe downloaded at runtime by `src/main/ffmpeg-binaries.ts` (native `fetch` against the `ffbinaries-prebuilt` GitHub releases).

## Artifact naming

`build.artifactName` is `Anime-DL-${version}-${arch}.${ext}` for every target except Windows **portable**, which overrides to `…-portable.exe` (`build.portable.artifactName`) — portable and NSIS both produce `.exe`, and without the suffix the second build overwrote the first in `dist/` (#189).

## macOS signing + notarization (#189)

The mac build is signed with a Developer ID Application certificate and notarized so Gatekeeper accepts it and `electron-updater` (Squirrel.Mac) can auto-update. Config lives in `package.json` `build.mac`: `hardenedRuntime` + the Electron JIT entitlements in `build/entitlements.mac.plist` (required or the signed app crashes at launch), `notarize: true`.

Credentials come from repo Actions secrets, mapped to the env vars electron-builder/@electron/notarize expect by the **"Set up macOS signing & notarization"** step in `release.yml`:

| Secret | → env | Content |
|---|---|---|
| `ANIME_DL_CSC_LINK` | `CSC_LINK` | base64 `.p12` (Developer ID cert + key + Apple G2 intermediate) |
| `ANIME_DL_CSC_KEY_PASSWORD` | `CSC_KEY_PASSWORD` | `.p12` password |
| `ANIME_DL_APPLE_API_KEY` | `APPLE_API_KEY` (as a **file path** — the step writes the `.p8` to `$RUNNER_TEMP`) | App Store Connect API key |
| `ANIME_DL_APPLE_API_KEY_ID` | `APPLE_API_KEY_ID` | key ID |
| `ANIME_DL_APPLE_API_ISSUER` | `APPLE_API_ISSUER` | issuer UUID |

Scope: **only `release.yml`** (version-bump pushes to main) signs and notarizes. PR builds (`check.yml`) never see the secrets and stay unsigned — deliberate, so fork-triggered runs can't touch signing material. If the secrets are absent the release build degrades gracefully: unsigned without the cert, signed-but-not-notarized without the API key.

Verification on a signed release: `codesign -dv --verbose=2`, `spctl -a -vv` ("Notarized Developer ID"), `xcrun stapler validate` against the unpacked `.app`.

## Release failures (#320)

**The macOS keychain failure is fixed upstream.** It was an electron-builder bug, not a secrets problem: `importCerts` passed the `.p12` import password to `security set-key-partition-list -k`, which expects the *keychain's* own randomly generated password. macOS ≤ 26.5 never validated `-k`, so the mismatch was invisible until the runner image roll (`20260707.563` → `20260828.587`) brought 26.6.2, which validates and rejects it — the whole story is on [#327](https://github.com/mikkerlo/anime-downloader/issues/327) and [#332](https://github.com/mikkerlo/anime-downloader/issues/332). The v26 backport shipped in **app-builder-lib 26.16.1**, so `package.json` pins `electron-builder` to exactly `26.16.1`. Widening that pin is safe only for a range that admits nothing below `26.16.1` (`^26.16.1` qualifies; `^26.8.1`, the range this replaced, does not): npm resolves a range to the `latest` dist-tag whenever `latest` satisfies it, in preference to any higher in-range version, so a range reaching below the fix can resolve backwards onto a build without it. As of 2026-09 `latest` is `26.15.3` and the fix ships only on the `v26` tag, and `26.15.4` through `26.16.0` are published and unfixed as well. The mac-only retry leg, the `$TMPDIR` keychain sweep and the `if: matrix.platform` split in `release.yml` all existed only for this bug and are gone; all three platforms now run the same plain `Package` step. `strategy.fail-fast: false` stays, so one platform failing does not cancel the other two — a partial matrix still shows which targets are broken, and the release job needs all three artifacts regardless.

When a release build fails, the `report-failure` job opens an issue naming the version and linking the run (built-in `GITHUB_TOKEN`). The title is version-scoped and the job looks for an open issue with that exact title first, so re-running the failed jobs — which re-runs `report-failure` under the same run id — appends a comment with the new run URL instead of filing a duplicate. Before this job existed the failure was silent — `release` was simply skipped — which is how v4.6.56 was permanently lost.

**A re-run cannot fix a cause that lives in the repo.** A re-run replays the workflow file *and* the repo state from the original commit — `GITHUB_SHA` is pinned — so no fix landed on `main` afterwards reaches it. That makes the first question "where does the cause live?", not "is a newer release out?". A transient cause (upload blip, registry timeout) is recoverable by re-running; a bad dependency, build break or workflow error is not, and has to be fixed on `main` and shipped. If the fix touches `package.json` it cuts a release on merge, so leaving the version field alone while changing anything else in that file recovers the untagged version without spending a new number — the `paths:` filter matches `package.json`, not the version key. That is the route taken for the untagged `v4.6.71` (#332).

**A late rerun is not always safe.** For the transient class, `softprops/action-gh-release` defaults `make_latest: true`, so re-running an old failed release build *after* a newer version has shipped publishes the older version last and marks **it** Latest — offering live users a downgrade through `electron-updater`. Check `gh release list` first: rerun only if nothing newer has been released. If something newer exists, leave the version gap — the commit's code ships in the later release anyway.
