#!/bin/sh
cd "$(dirname "$0")" || exit 1
for r in 1 2 3; do
  jq -c --arg r "$r" 'select(.kind=="transition") | .run=($r|tonumber)' "run$r-results.jsonl"
done | jq -s -f analyze.jq > all.json
jq length all.json
