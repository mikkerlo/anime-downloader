select(.kind == null and (.series | startswith($s)) and .idx == $i) | . as $t |
[ ["A","B"][] as $k | $t[$k] as $r |
  ( $r.ev[] | select(.t | test("emptied|loadedmetadata")) | {t: .at, k: $k, x: "MEDIA \(.t) src=\(.src[-12:])"} ),
  ( $r.wire[] | select((.file != null) or .user) |
      {t: .at, k: $k, x: (if .file != null then "\(.dir|ascii_upcase) Set file=…\(.file[-5:])" else "\(.dir|ascii_upcase) Set user=\(.user|tojson|.[0:90])" end)} ),
  ( $r.main[] | select(.line | test("file|File|episode|Episode|playlist")) | {t: .t, k: $k, x: "MAIN \(.line[11:140])"} )
] | map(select(.t >= $lo and .t <= $hi)) | sort_by(.t) | .[] | "\(.t)\t\(.k)\t\(.x)"
