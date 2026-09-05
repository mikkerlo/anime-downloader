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

The macOS packaging step fails on `security: SecKeychainUnlock: The user name or passphrase you entered is not correct`, thrown from inside electron-builder's own temporary-keychain handling. It is not a secrets problem. The cause is an electron-builder bug ([#10066](https://github.com/electron-userland/electron-builder/issues/10066), fix [#10101](https://github.com/electron-userland/electron-builder/pull/10101), v26 backport [#10172](https://github.com/electron-userland/electron-builder/pull/10172) — not yet published): `importCerts` passes the `.p12` import password to `security set-key-partition-list -k`, which expects the *keychain's* own randomly generated password. macOS ≤ 26.5 never validated `-k`, so the mismatch was invisible; 26.6.2 (runner image `macos-26-arm64` 20260831) validates it and rejects it. That is the whole failure — see [#327](https://github.com/mikkerlo/anime-downloader/issues/327).

This also means **the in-job retry cannot fix it**: both attempts run on the same runner, hence the same image, so a build that hits the bug hits it twice. What does sometimes recover is a *job-level* rerun, because that re-rolls which image the runner gets — an older one still has the unvalidated `-k`. The **"Package (mac, up to 2 attempts)"** step in `release.yml` keeps its retry and its `$TMPDIR` keychain sweep for now, but neither is known to help, and two earlier claims in this section were wrong and are withdrawn. The temporary keychain's filename is `sha256(<project dir> + "app-builder")` — derived from the *project directory*, not from the signing certificate; it is still stable across attempts and runners, just for a different reason. And electron-builder itself calls `removeKeychain()` on that path before creating it on every attempt, so our sweep is very likely redundant. The A/B probe previously cited here as evidence that the sweep is load-bearing was confounded — the two runs sat on different macOS images, so the outcome tracks the image, not the sweep — and proves nothing either way. Retry and sweep stay until the upstream fix ships, so both can be removed in one change. The other platforms use a separate single-attempt step so a real build break fails on the first try, and `strategy.fail-fast: false` keeps a mac failure from cancelling the healthy linux/win legs.

When a release build fails, the `report-failure` job opens an issue naming the version and linking the run (built-in `GITHUB_TOKEN`). The title is version-scoped and the job looks for an open issue with that exact title first, so re-running the failed jobs — which re-runs `report-failure` under the same run id — appends a comment with the new run URL instead of filing a duplicate. Before this job existed the failure was silent — `release` was simply skipped — which is how v4.6.56 was permanently lost.

**A late rerun is not always safe.** `softprops/action-gh-release` defaults `make_latest: true`, so re-running an old failed release build *after* a newer version has shipped publishes the older version last and marks **it** Latest — offering live users a downgrade through `electron-updater`. Check `gh release list` first: rerun only if nothing newer has been released. If something newer exists, leave the version gap — the commit's code ships in the later release anyway.
