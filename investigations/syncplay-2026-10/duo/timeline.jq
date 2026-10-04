# usage: jq -r --arg s Frieren --argjson i 3 --argjson lo -1500 --argjson hi 4000 -f timeline.jq run3-traces.jsonl
select(.kind == null and (.series | startswith($s)) and .idx == $i) | . as $t |
[ ["A","B"][] as $k | $t[$k] as $r |
  ( $r.ev[] | select(.t | test("emptied|loadedmetadata|seeking")) | {t: .at, k: $k, x: "MEDIA \(.t) ct=\(.ct*100|round/100)"} ),
  ( $r.wire[] | select(.ps or (.file != null) or .user) |
      {t: .at, k: $k, x: (if .ps then "\(.dir|ascii_upcase) State pos=\((.ps.position//0)*100|round/100) \(if .dir=="out" then (if (.ps|has("paused")) then "ASSERT" else "MIRROR" end) else "setBy=\(.ps.setBy) doSeek=\(.ps.doSeek)" end)\(if .iotf then " iotf=\(.iotf|tojson)" else "" end)"
                          elif .file != null then "\(.dir|ascii_upcase) Set file=…\(.file[-5:])"
                          else "\(.dir|ascii_upcase) Set user=\(.user|tojson|.[0:60])" end)} ),
  ( $r.main[] | select(.line | test("remote-state|drop|adopt|local-state")) | {t: .t, k: $k, x: "MAIN \(.line[11:120])"} )
] | map(select(.t >= $lo and .t <= $hi)) | sort_by(.t) | .[] | "\(.t)\t\(.k)\t\(.x)"
