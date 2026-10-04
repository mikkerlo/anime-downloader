#!/bin/bash
# usage: tl.sh series idx lo hi  (searches all runs)
D=/tmp/claude-1000/-home-greatkorn-anime-downloader/cdc8165b-b1bc-4d51-a0b1-5f38b2ceedfe/scratchpad
for r in run1 run2 run3; do
  out=$(jq -r --arg s "$1" --argjson i "$2" --argjson lo "${3:--500}" --argjson hi "${4:-2500}" -f $D/bug1/tl.jq $D/duo/$r-traces.jsonl | /usr/bin/grep -v "IN Set user")
  [ -n "$out" ] && { echo "=== $r $1 $2"; echo "$out"; }
done
