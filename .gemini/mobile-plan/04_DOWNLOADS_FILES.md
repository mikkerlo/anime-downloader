# Downloads & Files: The iOS Sandbox

## 1. Background Downloads
iOS will kill the app if it downloads a large file in the foreground for too long.
- **Plugin**: `@capacitor-community/background-downloader`.
- **Workflow**:
  1. Vue app calls `platform.enqueue()`.
  2. Capacitor Plugin hands the URL to `URLSession` (iOS Native).
  3. iOS downloads the file to the app's `Documents` folder.
  4. When the app is opened, we "sweep" the folder to see what finished.

## 2. File Organization
On iPad, we are restricted to the **App Sandbox**.
- `Documents/downloads/` - Where we store MP4s and ASS files.
- **Naming**: Keep the desktop naming scheme: `{AnimeName} - {Episode} [{Author}].mp4`. This makes the "Local File Finder" logic identical between desktop and iPad.

## 3. Storage Permissions
We don't need a "folder picker" like on desktop. We just use the app's private sandbox, so there are no "Allow access to Downloads folder" popups needed.
