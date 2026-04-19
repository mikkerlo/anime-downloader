# Mobile Player & WebGPU Up scaling

## 1. Video Playback
- **MKV**: Hide "Play" for local MKVs on iPad. Show a "Needs desktop for MKV" warning.
- **MP4/WebM**: Play directly via `src="capacitor://localhost/_app_file_/path/to/video.mp4"`.

## 2. WebGPU (Anime4K)
- **Status**: iPadOS 17+ supports WebGPU.
- **Performance**: iPads with M-series chips (M1/M2/M4) can easily run high-quality Anime4K presets.
- **Implementation**: No changes to the `anime4k-webgpu` logic. Just ensure the `initWebGPU()` call handles a `null` adapter gracefully (standard on older iPads).

## 3. Subtitles (JASSUB)
- **Pathing**: The biggest issue on iOS is the `Worker` path.
- **Fix**: Use a Blob URL for the worker.
```typescript
const workerCode = await (await fetch('subtitles-octopus-worker.js')).text();
const blob = new Blob([workerCode], { type: 'application/javascript' });
const workerUrl = URL.createObjectURL(blob);
```
This bypasses `file://` and `capacitor://` protocol restrictions that often block worker scripts.

## 4. UI Adjustments
- **Touch**: Replace "Hover" tooltips with "Long Press" or specific icons.
- **Seek Bar**: Increase the height of the seek bar "hit area" (the invisible box you tap) to 40px to accommodate fingers.
- **Volume**: iPad users usually use physical buttons, but keep the on-screen slider as a 60px wide touch target.
