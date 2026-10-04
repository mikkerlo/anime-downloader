select(.pressAt and (.series|startswith($s)) and .idx==$i) | .[$k] |
( (.ev[]|{t:.at,x:"EV \(.t) ct=\(.ct*100|round/100) src=\(.src[-6:])"}),
  (.main[]|select(.line|test("remote-state|local-state|drop|adopt|seek"))|{t:.t,x:"MAIN \(.line[11:150])"}),
  (.wire[]|select(.ps)|{t:.at,x:"W \(.dir) \(.ps|tojson) \(.iotf//""|tojson)"}),
  (.smp[]|{t:.at,x:"smp ct=\(.ct) rs=\(.rs) p=\(.p) \(.src[-6:])"}) )
| select(.t>=$lo and .t<=$hi) | "\(.t)\t\(.x)"
