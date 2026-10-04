# every `seeking` → outcome: next seeked (completed, duration) or next seeking/emptied (aborted after N ms)
select(.pressAt) | . as $t | ["A","B"][] as $k | $t[$k].ev
| map(select(.t=="seeking" or .t=="seeked" or .t=="emptied")) as $e
| range(0; $e|length) as $i | select($e[$i].t=="seeking")
| ($e[$i+1] // null) as $n
| { run: $run, s: $t.series[0:8], idx: $t.idx, k: $k, to: ($e[$i].ct*100|round/100),
    outcome: (if $n == null then "open" elif $n.t=="seeked" then "done" else "aborted-by-\($n.t)" end),
    ms: (if $n then $n.at - $e[$i].at else null end) }
