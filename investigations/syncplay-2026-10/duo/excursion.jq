# per transition & instance: on the NEW src, when did ct first exceed 9 (stale), and when did it next drop below 5 (corrected)
select(.kind == null) |
. as $t |
["A","B"] | map(. as $k | $t[$k] as $r |
  ($r.ev | map(select(.t=="loadedmetadata")) | last) as $lm |
  if $lm == null then empty else
  ($r.smp | map(select(.src == $lm.src and .at >= $lm.at))) as $s |
  ($s | map(select(.ct > 9)) | first) as $hi |
  if $hi == null then empty else
  ($s | map(select(.at > $hi.at and .ct < 5)) | first) as $lo |
  { series: $t.series[0:8], idx: $t.idx, sc: $t.sc, k: $k, lmAt: $lm.at, staleFrom: $hi.at, staleCt: $hi.ct,
    correctedAt: ($lo.at // null), excursionMs: (if $lo then $lo.at - $hi.at else null end),
    seekToasts: [ $r.main | .[] | select(.line | test("remote-state")) | select(.t >= ($lm.at - 1500) and .t <= ($hi.at + 12000)) | .line | capture("position: (?<p>[0-9.]+), setBy: (?<by>[^,]+)") | "\(.p|tonumber|floor)/\(.by)" ] }
  end end) | .[]
