# slurp: [results..., traces...]  -> one row per "both" transition
(map(select(.kind=="transition" and .sc=="both"))) as $R
| map(select(.kind==null and .sc=="both")) as $T
| $R[] as $r
| ($T | map(select(.series==$r.series and .idx==$r.idx)) | .[0]) as $t
| ($t.B.wire | map(select(.dir=="in" and .user != null and ((.user|keys[0])=="rigA") and .at >= 0)) | .[0].at) as $rx
| ($t.B.wire | map(select(.dir=="out" and .file != null and .at >= 0)) | map(.at)) as $bout
| ($t.B.ev | map(select(.t=="emptied" and .at >= 0)) | .[0].at) as $bEmpt
| ($t.A.ev | map(select(.t=="emptied" and .at >= 0)) | .[0].at) as $aEmpt
| { series: $r.series[0:8], idx: $r.idx, adv: ((($r.toEpA|tonumber) - ($r.fromEp|tonumber))),
    bPressMs: $r.bPress.ms, bNavAtPress: $r.bPress.bAlreadyNavigating,
    B_rxA_ms: $rx, B_followRelease_emptied_ms: $bEmpt, A_release_emptied_ms: $aEmpt, B_outSetFile_ms: $bout }
