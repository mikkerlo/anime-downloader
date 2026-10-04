def sb(r): r.srcChanged and ((r.ctLm // 0) > 5 or ((r.ct2 // 0) > 7));
def eb(r): sb(r) or ((r.maxCtFirst4s // 0) > 9);
[ .[] | select(.kind=="transition") ] as $T
| [ $T[] | . as $t
    | ($T | map(select(.run==$t.run and .series==$t.series and .idx==$t.idx+1)) | .[0]) as $nx
    | { run, series: .series[0:10], idx, sc: (.sc|split(":")[0]), pos: (.sc|split(":")[1] // "-"), how, relay: .relayMs, setupOk, ep: "\(.fromEp)->\(.toEpA)/\(.toEpB)", t0: .t0A,
        inst: ( ["A","B"] | map(. as $k | $t[$k] as $r
          | { k: $k, changed: $r.srcChanged, ctLm: $r.ctLm, ct2: $r.ct2, ct10: $r.ct10, max4: $r.maxCtFirst4s,
              strict: sb($r), ext: eb($r),
              fate: (if (eb($r)|not) then "ok"
                     elif ($t.sc=="chain") then (if $nx == null then "unknown" elif (($nx["t0"+$k] // 999) < (($r.ct2 // $r.max4) - 3)) then "self-corrected" else "stuck" end)
                     elif (($r.ct10 // 999) < 20) then "self-corrected" else "stuck" end) } ) ) } ]
