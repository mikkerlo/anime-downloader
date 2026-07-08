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
