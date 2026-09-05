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

The macOS packaging step flakes on `security: SecKeychainUnlock: The user name or passphrase you entered is not correct`, thrown from inside electron-builder's own temporary-keychain handling. It is transient, not a secrets problem — the same secrets succeed minutes later — so the **"Package (mac, up to 2 attempts)"** step in `release.yml` retries once. **Retrying alone does not work.** electron-builder tears its temporary keychain down only on the success path, and that keychain's filename is derived from the signing certificate rather than randomised, so a second attempt targets the exact file the first one orphaned and tries to unlock it with a freshly generated password — reproducing the very error being retried. The step therefore sweeps any orphaned keychain out of `$TMPDIR` and restores the user search list before *every* attempt, not only before the retry — sweeping ahead of attempt 1 as well, because a keychain left behind by something earlier is the only way a first attempt on a fresh runner can hit the same collision. That reset is load-bearing, not hygiene. Measured on a forced-failure probe: without the reset [`attempt1_rc=1 attempt2_rc=1`](https://github.com/mikkerlo/anime-downloader/actions/runs/33906796915), with it [`attempt1_rc=1 attempt2_rc=0`](https://github.com/mikkerlo/anime-downloader/actions/runs/33928659263). The cap is 2: a genuine cert or secret failure still fails both. The other platforms use a separate single-attempt step so a real build break fails on the first try, and `strategy.fail-fast: false` keeps a mac flake from cancelling the healthy linux/win legs.

When a release build fails, the `report-failure` job opens an issue naming the version and linking the run (built-in `GITHUB_TOKEN`). The title is version-scoped and the job looks for an open issue with that exact title first, so re-running the failed jobs — which re-runs `report-failure` under the same run id — appends a comment with the new run URL instead of filing a duplicate. Before this job existed the failure was silent — `release` was simply skipped — which is how v4.6.56 was permanently lost.

**A late rerun is not always safe.** `softprops/action-gh-release` defaults `make_latest: true`, so re-running an old failed release build *after* a newer version has shipped publishes the older version last and marks **it** Latest — offering live users a downgrade through `electron-updater`. Check `gh release list` first: rerun only if nothing newer has been released. If something newer exists, leave the version gap — the commit's code ships in the later release anyway.
