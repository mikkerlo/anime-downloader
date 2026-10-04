# valid = at least one instance changed source and the old position was detectable (t0 >= 6)
def valid: ((.inst[0].changed // false) or (.inst[1].changed // false)) and (.t0 >= 6);
def tally(f): { n: length,
  anyStrict: map(select(.inst | any(.strict))) | length,
  anyExt: map(select(.inst | any(.ext))) | length,
  A_strict: map(select(.inst[0].strict)) | length, A_ext: map(select(.inst[0].ext)) | length,
  B_strict: map(select(.inst[1].strict)) | length, B_ext: map(select(.inst[1].ext)) | length,
  stuck: map(select(.inst | any(.fate=="stuck"))) | length,
  selfCorrectedOnly: map(select((.inst | any(.fate=="self-corrected")) and (.inst | all(.fate!="stuck")))) | length };
{ excluded: [ .[] | select(valid|not) | {run, series, idx, sc, t0, ep} ],
  total: ([ .[] | select(valid) ] | tally(.)),
  byScenario: ([ .[] | select(valid) ] | group_by(.sc) | map({ (.[0].sc): tally(.) }) | add),
  byRelay: ([ .[] | select(valid) ] | group_by(.relay > 0) | map({ (if .[0].relay > 0 then "relay50-150" else "direct" end): tally(.) }) | add),
  byPos: ([ .[] | select(valid and (.sc=="follow")) ] | map(.posBand = (if .t0 < 60 then "early" elif .t0 < 900 then "mid" else "late" end)) | group_by(.posBand) | map({ (.[0].posBand): tally(.) }) | add),
  byHow: ([ .[] | select(valid and (.sc=="follow")) ] | group_by(.how) | map({ (.[0].how): tally(.) }) | add),
  doubleSkip: [ .[] | select(.sc=="both") | {series, ep} | select(.ep | test("->(\\d+)") ) ] }
