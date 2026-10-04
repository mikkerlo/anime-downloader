# wire frames (both directions) that land while a seek is in flight
select(.pressAt) | . as $t | ["A","B"][] as $k | $t[$k] as $r
| ($r.ev | map(select(.t=="seeking" or .t=="seeked" or .t=="emptied"))) as $e
| range(0; ($e|length)-1) as $i | select($e[$i].t=="seeking")
| $e[$i] as $s | $e[$i+1] as $n
| [ $r.wire[] | select(.ps and .at > $s.at and .at < $n.at) | "\(.dir) +\(.at - $s.at)ms pos=\(.ps.position*100|round/100) doSeek=\(.ps.doSeek) setBy=\(.ps.setBy // "-")" ] as $w
| select($w|length>0)
| { run: $run, s: $t.series[0:8], idx: $t.idx, k: $k, to: ($s.ct*100|round/100), end: $n.t, endMs: ($n.at-$s.at), endCt: ($n.ct*100|round/100), wire: $w }
