#!/usr/bin/env bash
# Regenerates long-gop-copy.mp4 (#653): real ffmpeg fMP4 output of the app's
# stream-copy spawn args, for the use-mse-player keyframe tests. Committed by
# ffmpeg 6.1.1; the tests assert keyframe times only, never bytes, so a newer
# ffmpeg may rewrite the file.
#
# Source: 160x90, 24 fps, 40 s, keyframes only at 0, 5, 10, 30 and 35 s; a flat
# colour at a low bitrate and silent AAC, so the file is almost all box
# structure. The capture is `-ss 20`, which lands on the keyframe at 10 s, so it
# holds the keyframes at 10, 30 and 35 s and a 20 s gap between the first two.
#
# The second command is `spawnFfmpegForSession`'s copy path
# (src/main/streaming/index.ts) with `pipe:1` redirected to the file. Update it
# here when those args change.
set -euo pipefail
cd "$(dirname "$0")"
src=$(mktemp --suffix=.mkv)
trap 'rm -f "$src"' EXIT

ffmpeg -v error -y \
  -f lavfi -i color=c=gray:s=160x90:r=24:d=40 \
  -f lavfi -i anullsrc=r=48000:cl=mono -t 40 \
  -c:v libx264 -b:v 20k -g 100000 -keyint_min 100000 -sc_threshold 0 \
  -force_key_frames 0,5,10,30,35 \
  -c:a aac -b:a 16k \
  "$src"

ffmpeg -v error -fflags +genpts -ss 20 -i "$src" \
  -map 0:v:0 -map '0:a:0?' -c copy -avoid_negative_ts make_zero -muxpreload 0 -muxdelay 0 \
  -movflags +frag_keyframe+empty_moov+default_base_moof+separate_moof -frag_duration 1000000 \
  -f mp4 pipe:1 > long-gop-copy.mp4
