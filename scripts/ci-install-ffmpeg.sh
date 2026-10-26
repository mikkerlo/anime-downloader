#!/usr/bin/env bash
# Installs the app's own pinned static ffmpeg + ffprobe 6.1 for CI (#591):
# the build `src/main/ffmpeg-binaries.ts` downloads on Linux x64, not apt's.
# apt's `ffmpeg` pulled ~100 packages through a mirror that crawled for up to
# 44 minutes; this is two zips from GitHub's release CDN, about 1.5 s each.
#
# The URLs must equal `archiveUrl(…, 'linux-64')` and the hashes are the only
# integrity check (the release is not immutable); test/ci-setup-workflow.test.ts
# holds both. No cache: PR-scoped caches are not shared between PRs.
#
# FFMPEG_INSTALL_DIR overrides /usr/local/bin for a local run.
set -euo pipefail

dest=${FFMPEG_INSTALL_DIR:-/usr/local/bin}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"

# --speed-limit/--speed-time abort a crawl, which apt has no setting for, and
# --retry retries that abort like any other transient failure.
fetch() {
  curl -fsSL --retry 5 --speed-limit 100000 --speed-time 30 -o "$1" "$2"
}
fetch ffmpeg.zip https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffmpeg-6.1-linux-64.zip
fetch ffprobe.zip https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffprobe-6.1-linux-64.zip

sha256sum -c - <<'EOF'
8bb4a27f5fd02f3dd9a5e75c9eddf6ace1d50a08929ee0d20bbf17eb467fb711  ffmpeg.zip
cb690c360042b51d9e901db2b0185c585330c1067b5c5edf0b6a5e26e0375e2a  ffprobe.zip
EOF

unzip -q ffmpeg.zip ffmpeg
unzip -q ffprobe.zip ffprobe
if [ -w "$dest" ]; then
  install -m 0755 ffmpeg ffprobe "$dest/"
else
  sudo install -m 0755 ffmpeg ffprobe "$dest/"
fi

# Every consumer resolves the bare names from PATH, so check that they land on
# these copies and that the encoder the fixtures need is there. Captured rather
# than piped: under pipefail, `| head` or `| grep -q` can SIGPIPE ffmpeg.
for bin in ffmpeg ffprobe; do
  found=$(command -v "$bin" || true)
  if [ "$found" != "$dest/$bin" ]; then
    echo "::error::$bin resolves to '${found}', not $dest/$bin"
    exit 1
  fi
done
version=$(ffmpeg -hide_banner -version)
echo "${version%%$'\n'*}"
encoders=$(ffmpeg -hide_banner -encoders)
if ! grep -q libx264 <<<"$encoders"; then
  echo '::error::the installed ffmpeg has no libx264 encoder'
  exit 1
fi
ffprobe -hide_banner -version >/dev/null
