// @vitest-environment happy-dom
//
// The non-switching peer's playhead across an episode change (#360).
//
// **Every assertion in this file is a characterisation pin of behaviour that is
// believed to be wrong.** Nothing here is a desired invariant, nothing here is
// a regression guard, and a change that makes one of these cases go red has not
// necessarily broken anything — it may well have fixed #360. The analysis lives
// in #360; read it before touching a number below, and when a fix lands, invert
// the case and say in the diff which of #360's mechanisms closed. Do **not**
// "repair" a red here by re-pinning it to whatever the tree then says.
//
// What is pinned, and why it needed pinning. One peer presses next episode; the
// other peer presses nothing and never changes file. At the bind gap the
// shipped app actually runs — `bindGapMs: 500`, which is what
// `syncplay-two-peer-adoption.test.ts` seats — the innocent peer is left alone,
// and that is the only regime the suite had ever seen. Above it the peer is
// dragged backwards — but **the gap axis is not monotone and there is not one
// threshold**, so "above the shipped gap" is not a safe summary of it.
//
// One named constant indexes the whole axis: `k = ceil(gap / HEARTBEAT_MS)`,
// against `src/main/syncplay.ts:19` ("const HEARTBEAT_MS = 1000"). Swept at
// **1 ms** resolution with everything except the gap held at the values
// `seatPair` seats, reading the non-switching peer at a 20 s window: `k = 1` is
// clean, `k = 2` through `k = 5` drag, and from `k = 6` up the axis is an
// **alternating comb** — it drags iff `k` is odd. Every edge measured is **one
// millisecond wide**, not a sample boundary: 1000 clean against 1001 dragging,
// 5000 dragging against 5001 clean, and the same at 6000/6001, 7000/7001,
// 8000/8001 and 11000/11001.
//
// **`k` is not the axis's index, and the sentence above is withdrawn as a
// general claim rather than softened.** It is the index *of this file's
// seating*, because `seatPair` switches on a whole second and the harness starts
// the room broadcast, the renderer's snapshot push and main's heartbeat on
// absolute 1 s boundaries — so the switch lands on all three at once. Place it
// `φ` ms later and **every comb edge moves with `φ`**, period 2 × `HEARTBEAT_MS`,
// measured on five seatings of `φ` at 50 ms sweep resolution over gaps 5050-9550
// (91 cells each, 455 in all) and confirmed at 1 ms on two edges. **Five
// seatings, four distinct phases** — the fifth is φ = 1000, which is one whole
// `HEARTBEAT_MS` on from φ = 0 and therefore the same phase; it is a
// reproducibility replicate rather than a sample, and it is reported as one
// below because agreeing with φ = 0 on all 91 cells is what establishes the
// 1 s periodicity the rest of this paragraph assumes:
//
//   φ = 0 ms     drag on (6000, 7000], (8000, 9000]   edges 6000/6001, 7000/7001
//   φ = 250 ms   drag on ~(5700, 6700], ~(7700, 8700]
//   φ = 500 ms   drag on (5450, 6450], (7450, 8450]   edges 5450/5451, 6450/6451
//   φ = 750 ms   drag on ~(5200, 6200], ~(7200, 8200]
//   φ = 1000 ms  identical to φ = 0, edge for edge (91/91 cells, separate run)
//
// So at φ = 500 the cell at gap 5600 — `k = 6`, **even** — drags, and the cell at
// 6600 — `k = 7`, **odd** — is clean. Both halves of that sentence are φ = 500
// readings and neither is a counter-example at φ = 0, where 6600 drags like every
// other odd cell: **all 40 odd-`k` cells in the sweep drag at φ = 0 and all 51
// even ones are clean**, so there is no odd-and-clean cell at this file's own
// seating to point at.
//
// The parity of `k` predicts the outcome at φ = 0 and nowhere else — and *that*
// sentence is the one-directional rule "odd ⇒ drags", which is the only form it
// is true in. Stated as a correlation it is less clean and more interesting:
// φ = 750 is still **78%** predictive with the **sign inverted** (8 of 40 odd
// cells drag against 39 of 51 even ones), and φ = 500 is the only phase where
// parity carries no signal at all (49%). A reader checking parity at an
// unspecified phase can therefore get it exactly backwards rather than merely
// get noise.
//
// φ = 0 is the one phase the app cannot arrange: a keypress is uncorrelated with
// a 1 Hz interval, so φ is uniform on [0, `HEARTBEAT_MS`) in the field and zero
// on a set of measure zero. **That is an argument about the index and not about
// the defect, and it must not be read as the drag being rare in the field** —
// the measurement says the opposite, and says it loudly. Off φ = 0 the comb does
// not weaken, it only slides: every phase shows the same geometry, period
// 2 × `HEARTBEAT_MS` with a 1000 ms dragging half and a 1000 ms clean half, and
// the dragging fraction pooled over the three distinct non-zero phases is
// **129 of 273 cells, 47.3%** — against 40 of 91, 44%, at φ = 0 itself. What
// φ's uniformity destroys is `k`'s claim to be the axis. What survives it is the
// drag, at roughly one gap in two, at every phase a keypress can land on. The
// slide is not linear in `φ` either (-300, -250, -250 ms per quarter heartbeat,
// returning to alignment at φ = 1000), so no closed form for the edge as a
// function of `φ` is claimed here.
//
// Nothing below is re-pinned at another phase: the first eight cases all seat
// φ = 0 and the ninth seats φ = 50 ms, and both name their φ in their titles.
// The eight φ = 0 cases stay there for comparability rather than realism: the
// sibling suite's switch, `test/services/syncplay-two-peer-adoption.test.ts:419` ("await host.goToEpisode('8')"),
// takes the default offset, so re-seating them would stop them reading the same switch.
//
// So "two disjoint drag bands separated by a ~1 s clean corridor" is withdrawn,
// and so is anything of the shape "clean above 7000". The comb does not stop,
// every cell here read at 20 s: `[]` at 7001-8000 and at 10000, then `[312.00]`
// at 8001-9000, `[314.00]` at 10001-11000, `[316.00]` at 13000 and `[318.00]` at
// 15000. What survives of the old map is only the cells it sampled — 7001 to
// 8000 really are clean — never the conclusion that the axis ended there.
//
// **"No upper end measured" is withdrawn too, and it is answered rather than
// just re-stated: there is no upper end out to a 30.5 s bind gap.** Swept on the
// mid-run cell of every run from `k = 6` to `k = 31` (gaps 5500, 6500, … 30500),
// twenty-six cells, at a 70 s read and at the **φ = 0** seating — the phase
// qualifier is as load-bearing here as it is above, because the alternation this
// paragraph reports is only parity-indexed at that phase: the comb is unbroken,
// every odd `k` drags and every even `k` is clean, with no cell out of step.
// Three closed forms hold at every cell in
// that range, which is more than the old "+2.00 s per dragging run" said:
//
//   dragged value   =  304 + k         (311.00 at `k = 7` … 335.00 at `k = 31`)
//   seek lands at   =  gap + 3550 ms   (post-switch, every dragging cell `k >= 7`)
//   mirror width    =  k - 2 frames    (4 at `k = 6` … 29 at `k = 31`)
//
// All three at 26 of 26 cells, and **the last two are read at the 45 s and 70 s
// windows, not at 20 s** — which is this file's window-relativity biting on its
// own evidence rather than a footnote. Above gap 20500 only twenty seconds of
// mirroring has elapsed by the 20 s read, so the width saturates at 18 there and
// the closed form holds at just 15 of 26 cells; and the deficit at 20 s takes
// five distinct values over the sweep ({0.95, 1, 1.95, 2, 3}) because above gap
// ~14000 the drag has not landed yet. A 3.00 s deficit at gap 16500 read at 20 s
// is that transient and **not** an exception to the 1.00 s figure: its seek lands
// at 20050 ms, fifty milliseconds after that sample. At the 70 s read the value
// sets are exactly {2.00} over all thirteen clean cells and {1.00} over all
// thirteen dragging ones. Never quote a deficit here as a maximum over windows.
//
// Those two figures, holding all the way up, are the re-measurement against the
// join-time `State` of the 60 s figure an earlier revision of the flush
// paragraph below recorded as never re-run. **"The twenty-four cells
// between the far pair and `k = 9` are described here only" is withdrawn as a
// count**, because it counted neither the cells nor the pins: of the twenty-six
// swept, **five** are pinned below — `k = 7`, `k = 8`, `k = 9` and the far pair
// at `k = 30`/`k = 31` — and the other **twenty-one**, which are `k = 6` and
// `k = 10` through `k = 29`, are described here and asserted nowhere.
//
// The dragged value is not one number either, every figure in this sentence a
// 20 s read: 304.00 at the onset, 304.05 from 2000 through 5000, 311.00 across
// `k = 7`, and **+2.00 s per dragging run** above that.
// `PLAYBACK_STALE_MS` (`src/main/syncplay.ts:66` ("const
// PLAYBACK_STALE_MS = 5000")) is the lower run's top edge exactly — 5000 drags,
// 5001 is clean, and the operator that puts 5000 *inside* the horizon rather
// than at the bottom of the next run is the `<=` at
// `src/main/syncplay.ts:2348` ("return this.lastSnapshotAt > 0 && Date.now() -
// this.lastSnapshotAt <= PLAYBACK_STALE_MS") — and it is the only edge on the
// **drag** axis that lands on a named constant. That qualifier is load-bearing,
// not pedantry: this header measures two axes, and the other one has an edge on
// the same millisecond — the mirror width's 3 → 4 step is exactly (5000, 5001]
// as well, per the width walk below — so the unqualified "the only edge on this
// axis" was false the moment the second axis was measured, and it is withdrawn
// on that ground rather than softened. The 1001 onset and every comb edge above
// `k = 6` land on nothing this header has identified. **Do not read a threshold
// out of the three dragging cells pinned below** — they are one cell from each of
// three runs, and every cell between and beyond them is described in this header
// only, never asserted. What the pins do establish, each at the window its case
// names: at a 3 s gap the element is written to 304.05 and ends a 20 s window
// ~4.95 s behind where the same window leaves it in the control; at a 6.5 s gap
// it is written to 311.00 by the 14 s read; and at an 8.5 s gap to 313.00 by the
// 14 s read, while a 7.5 s gap one heartbeat below it leaves the element
// untouched through the same 20 s. The drag is shipped, unflagged and unarmed,
// and it costs playback on a peer that made no input at all.
//
// **Nine cases now, and the knob count went from one to two.** The first four
// are one sweep over `bindGapMs` — five rows of it, because the alternation case
// seats two gaps rather than one: the assertion it carries *is* the difference between
// them, and splitting it would let either half be deleted with the other still
// green. The five added since pin what decides that sweep rather than more of it: the
// selector quantity at a dragging gap and a clean gap (two more rows of the same knob),
// `src/main/syncplay.ts:903`'s own firing across its 1 ms edge (two more), the
// bind-release latch drop at a dragging and a clean cell (two more), the comb's far
// end at a 30.5 s gap (two more), and — the second knob — the **switch's phase**, one
// row at 50 ms where everything else sits at 0. `bindGapMs` (the harness's bind gap:
// `test/helpers/syncplay-two-peer.ts:393` arms `metadataDueAt` from it inside
// `reload()`) is the gap between the media load algorithm's synchronous
// reset and the `loadedmetadata` task, i.e. how long the switcher's new element
// sits at `HAVE_NOTHING` reading ~0 while the room walks on. Everything else is
// held at `syncplay-two-peer-adoption.test.ts`'s own values — room at 300, both
// peers seated there, `advance(4)` of agreement first — so the control case
// below reproduces that file's numbers exactly and every other row differs from
// it in the gap and in nothing else.
//
// Two mechanisms, not one, which is why 3 s and 6.5 s are separate cases rather
// than two rows of a table. At 3 s the seat de-adopts on the file change
// (`src/main/syncplay.ts:789`) and then **re-latches before the next push, on
// the previous episode's snapshot**: `src/main/syncplay.ts:2641` subtracts the
// projected room from `this.snapshot.position`, and while a reloading element
// announces nothing both terms are still the old episode's number, so the drift
// is 0 and `src/main/syncplay.ts:2642` adopts a seat whose element reads ~0. The
// latched seat then asserts the inbound write's 303 — #360 itself — and wins
// `min()`. At 6.5 s a second path runs: the gap outlives `PLAYBACK_STALE_MS`
// (`src/main/syncplay.ts:66`), so by the first post-bind push
// `src/main/syncplay.ts:902` finds no live playback and
// `src/main/syncplay.ts:903` de-adopts a second time, and there it is the
// inbound write that closes the drift and re-latches us one episode's timestamp
// later.
//
// `src/main/syncplay.ts:903` is the boundary between those two paths and it is
// now **instrumented rather than inferred**, which is what the 5000/5001 case
// below pins. It writes the latch iff the elapsed time from the last pre-switch
// snapshot push to the first post-bind one exceeds `PLAYBACK_STALE_MS`; at
// φ = 0 that elapsed time *is* the gap, so the edge is exactly (5000, 5001] —
// `Peer.adopted()` still true one slice after a 5000 ms release and already
// false one slice after a 5001 ms one. The old reading of it as "inferred from
// two gap samples" is discharged, and so is any remaining suspicion that it
// selects the comb: over a 312-cell sweep it fired on **111 clean cells and 100
// dragging ones**, so it partitions the lower run from the comb and says nothing
// about which comb cells drag — **pinned by the 6500/7500 case below**.
//
// **What selects a dragging comb cell from a clean one is identified, and the
// header's "not identified" is withdrawn.** The old text said the selector sits
// "upstream of `src/renderer/src/composables/use-syncplay-client.ts:1411`" and
// named nothing; it is the room's own position at the instant the re-latched
// seat first asserts, and it is one quantity across the *whole* axis rather than
// a story about the comb alone.
//
// *First, what the room does while the element is dark.* During the bind gap the
// switcher publishes a spectator mirror — `buildPlaystate()` past
// `canAssertSnapshot()` — whose value is the last room state it received,
// projected forward; the server stores that one forward delay late and
// `min()`-elects it, so the room is re-derived from its own stale echo every
// other second. The elected position is therefore a **staircase that holds for
// two heartbeats and then jumps 2.00 s**, not a line: 303.95, 304.95, 304.95,
// 306.95, 306.95, 308.95, 308.95 … measured on heartbeat boundaries and
// **byte-identical at 6.5 s and 7.5 s**, which is the half that makes the
// selector a phase rather than a magnitude. **Step 2.00 s**, period
// 2 × `HEARTBEAT_MS`, both exact on the successive differences — `1, 0, 2, 0, 2,
// 0, 2 …`, with the 2.0000 and the 0 carrying no rounding slop. "Step" rather
// than "amplitude" on purpose: the *step* is 2.00 s, while the staircase's
// peak-to-peak departure from the straight 1 s/s ramp underneath it is 1.00 s,
// and "amplitude 2.00 s" is ambiguous between the two by a factor of two.
//
// Its phase is **reasoned, not measured**: the account is that it is set by the
// first mirror frame — the first heartbeat at which `canAssertSnapshot()` goes
// false, i.e. `PLAYBACK_ASSERT_STALE_MS` after the last pre-switch push — and
// that is what the φ response above would be the response *of*. The probe that
// would identify it was never run. What exists is the staircase sampled at two
// cells, both at φ = 0, and they are the wrong pair to settle it: their stair
// phase is identical while their mirror counts differ (5 frames at 6.5 s against
// 6 at 7.5 s), so the data is consistent with the account and does not single it
// out from any other quantity that is also constant across those two cells. The
// φ sweep establishes *that* the staircase has a phase and that it tracks the
// switch; which frame sets it is the open half.
//
// *Then, the one number.* At the release the parked frame writes the previous
// episode's 303 and the resumed push stamps `lastSnapshotAt`; the next room
// frame writes the element to that tick's elected room position; one heartbeat
// later `src/main/syncplay.ts:2642` re-latches and the seat asserts it. Taking
// `room - position` on that first assertion after the mirror run, it has
// **exactly two values across the comb and five across the axis** — censused
// over 312 cells spanning gaps 50-15500 and over 455 cells spanning five
// seatings of the switch phase (four distinct, as above):
//
//   under = -0.05   111 clean,   0 dragging   (comb, room still holding)
//   under =  0.95    19 clean,   0 dragging   (lower run, gap <= 1000)
//   under =  1.95     1 clean, 140 dragging   (comb's other phase, and 1001-2000)
//   under =  3.95     0 clean,  40 dragging   (lower run, 2000-5000)
//   under =  5.95     0 clean,   1 dragging   (gap 5000)
//
// and the innocent peer's peak `diff` tracks it at `under + 1.00`: 2.00 at
// -0.05, 2.10-2.95 at 0.95, 2.95-3.95 at 1.95, 4.95-5.95 at 3.95. **`peakDiff >
// 3.0` and the drag agree on 312 of 312 cells.** The single clean cell at
// under = 1.95 is gap 1000 itself, whose peak is 2.95 — the 0.05 s knife edge
// this header already describes, now placed on the same axis as everything else
// rather than beside it.
//
// So the comb is not a parity at all: it is the staircase's **hold half versus
// its jump half**, sampled at whichever heartbeat the element's first live frame
// arrives on. An odd `k` at φ = 0 is the one that lands the assertion one
// heartbeat *after* a 2.00 s jump, and that is the whole of it. What survives
// unchanged from the old paragraph is its negative half, and it survives on
// stronger evidence: a monotone staleness horizon cannot produce an alternation,
// and `src/main/syncplay.ts:903` now has the firing census to prove it is not
// the selector rather than only the arithmetic.
//
// The mirror's *width* is neither of those two paths. `buildPlaystate()` is
// `canAssertSnapshot() && isAdopted()` with the snapshot timer first, so during
// the bind gap — when no push arrives at all — `PLAYBACK_ASSERT_STALE_MS` (2 s,
// `src/main/syncplay.ts:2376`) is what silences us, and the adoption latch does
// not even run inside that window. That is the whole of "withholds our playstate
// entirely" on this path: one frame at 3 s, five at 6.5 s, none at 500 ms. Width
// is monotone non-decreasing in the gap — 28 cells swept, non-decreasing at
// every one of them and at every window read — while the drag is not, which
// means it cannot select the regime: the mirror is **zero frames wide at 500 and
// 1000 ms, both clean, and still zero at 1500 and 2500, which drag**, and it rises
// straight through every edge above that (counted at 20 s: four frames at 5500
// and 6000, both clean; five at 6500 and 7000, both dragging; six at 7500 and
// 8000, both clean again; seven at 8500, dragging).
//
// The strongest case *for* the width hypothesis is worth stating before it is
// disposed of, because it is a measured coincidence and not a straw man: at
// 5000 → 5001 the width steps 3 → 4 and the drag flips dragging → clean, on the
// same millisecond, and a reader who sampled only that pair would have a
// width-selects-the-drag story that fits perfectly. **The pair that settles it
// is 6000 → 6250**: there the width steps 4 → 5 and the drag flips the *other*
// way, clean → dragging. Width only ever moves up, so the two flips cannot both
// be it reading its own threshold — a monotone quantity cannot reverse the sign
// of what it is supposed to select. The 5000/5001 coincidence is the drag axis
// landing on `PLAYBACK_STALE_MS` and the width axis landing on it too, which is
// the paragraph above, not one selecting the other. The count is window-relative
// in its own right — 7500 and 8500 both read four frames at 6 s and part company
// only after it — so no reader should take a mirror count as a proxy for whether
// the peer is dragged.
//
// **3000 and 6500 ms — and why the reason this used to give for skipping 5000
// does not hold.** The old text said the observable crossing "sits somewhere in
// (4000, 5000]" and that 3000 and 7000 "sit clear of it on both sides". Both are
// withdrawn. There is no single crossing to sit clear of, because the axis is a
// comb; and 7000 — which this file pinned until the comb was measured — is the top
// edge of the `k = 7` run, clear on the low side only, since 7001 is already clean.
// 6500 replaces it: same run, same written value, mid-run rather than on an edge.
//
// **Every "clean" in this header means "clean at the window named".** The read
// window is a second axis and it manufactures clean cells of its own. Read at a
// 6 s window instead of 20 s, the drag is absent from 4000, 4500 and 5000 — and
// equally absent from 6500 and 7000 — and at 1 ms resolution that crossing is
// **(3950, 3951]**, one millisecond wide: `[303.05]` at 3950 and `[]` at 3951,
// over two byte-identical runs. It cuts across the comb rather than following it,
// it lands on no constant this header has identified, and no mechanism is claimed
// for it. The same axis bites at the other end: from `k = 11` up the dragging
// cells arrive **between the 14 s and the 20 s read**, so 10001, 11000, 13000 and
// 15000 all read `[]` at 14 s and drag at 20 s. A 20 s window is already marginal
// there, and a shorter one would have reported those cells as clean.
//
// So "the same run answers the question both ways depending on where the window
// ends" is just as true of the 6500 cell this file does pin, where the 6 s window
// reads `[]` and the 14 s and 20 s windows read `[311.00]` — asserted below in
// both windows, on purpose — and of the 8500 cell, `[]` at 6 s against `[313.00]`
// at 14 s and 20 s, asserted the same way. It therefore cannot have been the
// reason 5000 was left out.
//
// What the cells are, measured, each at a 20 s read unless another window is
// named. 3000 is mid-run and window-stable: the drag is already there at a 6 s
// window. 5000 is the lower run's **top edge** (5001 is clean) and
// window-dependent. 6500 is mid-run in the `k = 7` run, and is the cell this file
// pins; 7000 was pinned first, is that run's **top edge**, and was withdrawn for
// exactly that reason — a change moving the edge by one millisecond flipped the
// case, which is a fact about where the pin sat rather than about the tree. The
// value did not move with the pin, because the run's *value* is stable where its
// *position* is not: every cell from 6001 to 7000 writes the same 311.00. The
// `k = 8`/`k = 9` pair is chosen the same way. 7500 and 8500 are both mid-run;
// 8000 and 8001 are the two sides of a 1 ms edge and would have pinned the edge's
// position where what is wanted is the alternation.
//
// The control is not decoration. `seekWrites` staying `[]` at gap 500 is the
// only thing that makes the drag rows mean anything — without it they would
// be consistent with a harness that drags the peer on every switch — and it is
// a *near miss* rather than a clean pass: the switcher holds the room 2.45 s
// under the innocent peer's element for the whole 20 s window, and the renderer's
// seek gate needs 3.0. 0.55 s of headroom nobody chose, which is pinned here as a
// number rather than left as a passing boolean.
//
// **The deficit is a fixed point, not a window artefact — and the 0.55 s is not
// a margin, because the regime it holds in is 5% of the switch's phase.** Both
// halves are measured and the second one withdraws how this paragraph used to
// read. 2.45 s exactly on every read out to **300 s** (a probe outside the
// suite; the case below pays for 60 s), so it neither closes nor ramps. But move
// the switch **one 50 ms slice** off the room broadcast, at the same shipped 500
// ms gap, and there is no 2.45 s deficit to have headroom on: the innocent peer
// is written **19 times in 20 s**, ten of them to 0, and the room alternates
// between 0 and its walking position for the rest of the session. The last case
// pins it. The boundary is exactly one link delay — censused over a
// (switch offset, `delayMs`) grid, clean for every offset strictly below
// `delayMs` and flapping from `delayMs` on, at 50, 200 and 400 ms of delay — so
// the control's regime is the `delayMs / HEARTBEAT_MS` corner of that plane and
// is 1 slice wide at the 50 ms this file seats.
//
// **The 5% is a measured 5 of 100 and not an arithmetic 50/1000**, which is
// worth separating because the two agree here and need not have. Re-swept at
// **10 ms** resolution over the whole phase period at gap 500 — 100 cells,
// offsets 0 through 990 — the clean cells are exactly offsets 0, 10, 20, 30 and
// 40, and the other **95 of 95 drag and are written to 0**. So the clean band is
// 4.1-5.0% of the period (the true edge lies between 40 and 50 ms) and it ends
// exactly where the 50 ms link delay does, which is the "one link delay" rule
// above confirmed at five times the resolution it was found at rather than
// merely restated. Two things the finer sweep adds: the period is exactly
// `HEARTBEAT_MS` (offsets 1000-1040 are clean again and 1050 drags, and the same
// at 2000), and the deficit inside the band **erodes** from 2.45 to 2.49 as the
// offset walks to 40 ms — so the 0.55 s is itself the best value in the band and
// 0.51 s is the worst. **There is no graceful degradation at the edge**: one
// slice past it the peak difference is 314.5 s, over a hundred times the gate,
// not a 3.05 s near miss.
//
// Why the corner protects: inside it the frame the room broadcast is still in
// flight when `reload()` runs, so it parks and writes the *previous episode's*
// position onto the rebound element, and that — #360's own titular defect — is
// what keeps the latched seat's next assertion off 0. Outside it nothing writes
// the element before the first push, the push carries the new element's
// `{0, paused: true}`, and `canAssertSnapshot()`'s paused exemption at
// `src/main/syncplay.ts:2375` ("if (this.snapshot.paused) return true") lets it
// out as an assertion.
//
// Eight other parameters were swept at gap 500, 27 cells, and **not one moves
// the deficit over 3.0 by arithmetic**: `delayMs` 0-1500 both-sided and
// asymmetric (2.00-2.49), `forwardDelay` 0-1 (0.55-2.55), `echoHoldCorrection`
// off (1.98), `electionAgeMs` 500/2000 against a 1 s tick (2.45 both),
// `seekLandMs` 50-200 (2.50-2.65), room position 0 and 1200 (2.00/2.45), and the
// room broadcast interval at 250, 500, 1000 and 2000 ms (2.20-2.45). **Two
// settings break the regime rather than nudging the figure**, and the second is
// recorded here rather than left out of the list because it reaches the same
// failure by a second route: the switch's phase, as above, and the room
// broadcast interval, where **2500 and 3000 ms both write the peer to 0** and
// 1000, 1500, 2000 and **4000** are all a clean 2.45. So the answer to "can any
// parameter push the deficit over 3.0" is **no** — and the question turns out to
// be the wrong one, because what the parameters reach is not a 3.05 s deficit
// but a 300 s one.
//
// **Three things about that interval route, because it is the easiest claim in
// this header to overstate.** First, it is **not monotone in the interval** and
// must not be written up as "a slower room is worse": 4000 ms is clean and 2500
// is not, so it is a sampling alias against the 2 s staircase rather than a
// trend. Second, **3000 ms is not a number this product has anywhere.** It is
// `MinElectionServer`'s `stateIntervalMs`
// (`test/helpers/syncplay-min-election-server.ts:537` ("this.stateIntervalMs =
// opts.stateIntervalMs ?? 1000")) set to three times the reference cadence,
// which is one second — `SERVER_STATE_INTERVAL = 1` upstream, and the harness
// default the rest of this file runs at. So this route is a **misconfigured or
// hypothetical server cadence**, not a second constant in the tree, and nothing
// here says a shipped server does it. Third, "second route" is a claim about
// **reachability and not about mechanism**: both routes end on the same two
// lines, `use-syncplay-client.ts:1664` ("const target = Math.max(0,
// state.position)") and `use-syncplay-client.ts:1680` ("v.currentTime =
// target"), reached through the same gate. What differs is only how the room's
// `min()` comes to hold 0.
//
// **That gate has two arms, and every account below is scoped to one of them.**
// `src/renderer/src/composables/use-syncplay-client.ts:1411` ("const wouldSeek
// = state.doSeek || diff > 3.0") fires on an inbound `doSeek` flag *or* on the
// difference computed at
// `src/renderer/src/composables/use-syncplay-client.ts:1403` ("const diff =
// Math.abs(v.currentTime - state.position)"), and a `doSeek: true` state seeks
// whatever `diff` reads. Censused across 63 cells — gap 1000, 1001 through 1060,
// and the 8000/8001 pair, chosen to straddle two crossings rather than to sample
// the axis — `doSeek` is false on every frame the innocent peer applies and never
// true on the wire in either direction. The innocent peer writes in 61 of the 63
// and is clean in 2, 1000 and 8000; all 61 writes are attributed to the `diff`
// arm, and 60 of them are the single 0.05 s step from 1001 to 1060, so the count
// is a property of where the cells were placed and not of the axis. So in this
// scenario the `doSeek` arm is **inert**, and every drag described here is a pure
// `diff > 3.0` crossing — which is a measured property of these rows, not a
// property of the gate, and the second arm is named so no reader takes the
// account for a one-armed one. The instrument was calibrated positive against the
// suite's own scrub fixture, where it does see a `doSeek: true`, so the zero is a
// real zero rather than a blind probe.
//
// Both anchors above carry their path, and that spelling is a hand-held
// convention rather than a gate-enforced one. Line 1411 is live in
// `src/main/syncplay.ts` too, so an anchor written without its path reads as the
// wrong file — and `scripts/check-line-citations.mjs`, which does scan comments,
// puts a pathless anchor in its *uncheckable* class: counted against a pin, never
// resolved to a file. Nothing here would go red for naming the wrong one.
//
// How little headroom that is, measured rather than argued. At a 1000 ms gap —
// still clean, `seekWrites` still `[]`, and with **no arming frame at all in the
// 20 frames it runs** — the same deficit is **2.95 s against the same 3.0, which
// is 0.05 s of headroom**, unchanged from the 6 s read out to a 60 s one, and
// 1001 drags. That is not a coincidence, and the onset is worth stating as cause:
// 1001 reaches a `diff` of exactly 3.000 in decimal on the fourth frame after the
// switch and seeks on that same frame, clearing a strict `>` on **float residue
// alone**.
//
// **That account is the whole of every crossing on this axis and selects none of
// them.** Arm-frame census over `k = 6` through `k = 15` — gaps 6000, 6500, 7500,
// 8500, 9500, 10500, 11500, 12500, 13500 and 14500, thirty frames each, reading
// the composable's own expression at frame-delivery time. Every dragging cell
// arms on a `diff` of 3.0000000953674544, with the frame before it at
// 2.950000095367443 and `doSeek` false on both: bit-for-bit the pair 1001 crosses
// on, so the residue reading is not special to the onset. Every clean cell's
// `diff` **never exceeds 2.0000000953674544** in those thirty frames, and the
// standing deficit at a 60 s read is **2.00 s at every clean `k` from 6 to 15 and
// 1.00 s at every dragging one**. So the gate is the **trigger** on every cell
// that drags and says **nothing** about which cells reach it: 8000 does not miss
// 3.0 by 9.5e-8, it misses it by a full second at steady state, and whatever
// selects odd `k` from even sits upstream of
// `src/renderer/src/composables/use-syncplay-client.ts:1411` rather than in it.
// The knife edge at the 1001 onset is the edge of the `k = 1` clean cell, whose
// headroom really is 0.05 s; above `k = 6` the clean side has a second of room,
// and no edge of the comb is a near miss at the gate.
//
// **"Upstream of the gate" has since been given a name** — the staircase phase,
// above — so this census no longer ends in a gap; its negative finding is what
// pointed at the staircase, and the two agree where they overlap. The census's
// 1.00/2.00 steady-state split *is* the `under + 1.00` relation measured on 312
// cells: a clean cell's 2.00 is `under = -0.05` and a dragging cell's 1.00 is the
// post-seek remainder of `under = 1.95`. Only the span is new — the census stops
// at `k = 15` and the 70 s sweep carries the same two figures to `k = 31`.
//
// **Name the quantity before quoting the residue, because the figure moves with
// it.** Sampling `el.currentTime - roomState().position` on 1 s boundaries reads
// 3.000000047683727, about 4.8e-8 over; computing the composable's own expression
// at frame-delivery time reads 3.0000000953674544, about 9.5e-8 over. Both are
// residue on a difference that is exactly 3.000 in decimal, and the three things
// that matter agree across both probes: the crossing gap (1001), the step
// boundary (1051) and the written value. A bare figure here belongs to whichever
// probe produced it and to nothing else.
//
// The onset is therefore a knife edge, and a wide one: 1001 through 1050 are
// **identical** cells, and 1051 steps to the next 0.05 s of `diff` and writes
// 303.95 where they write 304.00. `diff` moves in a 0.05 s quantum because that
// is the harness's own timer slice (`test/helpers/syncplay-two-peer.ts:799` ("const DEFAULT_STEP_MS = 50")),
// so this axis is a **step function rather than
// a line** — a linear fit such as `1.95 + gap/1000` puts the crossing in the
// wrong place. Rounding the other way would not nudge the onset; it would move it
// to 1051, the first cell on the next step. None of that is pinned and no case
// below sits near it; what the figure rules out is reading the 500 ms control as
// a comfortable margin.
//
// **The whole sweep above predates #384's flush, and only the cells
// re-measured below have been re-run against it.** Every figure in it — the
// 1001 onset, the 1051 step, the clean/dragging deficits at the 60 s read, the
// arm-frame census from `k = 6` to `k = 15` — was measured against a
// `goToEpisode()` that rebound the element without flushing the index bump
// first. #384 moved three of the five rows this file pinned *at that time* —
// 500, 3000, 6500, 7500 and 8500, which is the whole of it rather than five of
// the ten seatings there are now — and what
// moved in them is `switcher.el.currentTime` only: 0.05 → 0 at 6500, 7500 and
// 8500. Not one `innocent.el.currentTime` and not one
// `server.roomState().position` changed at any of the five gaps across that
// change — written room/innocent in that order, and spelled out rather than
// carried down from the clause above, they read 306.5 / 308.95 at 500,
// 304 / 304 at 3000, and 307.95 / 308.95 at each of the other three on both
// sides of it. (The 3000 row is the one that reads the same either way, which
// is what lets a reversed pair survive a spot check.) So the half the flush
// moved is the *switching* peer's own parked element. The join-time `State`
// this branch adds moved the other half instead: +1.00 s on all ten figures.
//
// **Re-measured against the join-time `State`** by a gap-axis sweep on this
// branch's tip, run outside the suite (not a test, not in CI): every boundary,
// every clean cell, the 1001 onset, the 1051 step, `PLAYBACK_STALE_MS`'s edge
// (5000 drags, 5001 clean) and the crossing's 1 ms width at (3950, 3951] all
// hold; only the written values move, each by exactly +1.00 s. At the 20 s
// read 1001 and 1050 → 305.00, 1051 → 304.95, 6001/7000 → 311.00, 8001 →
// 313.00, 10001/11000 → 315.00, 13000 → 317.00, 15000 → 319.00; at the 6 s
// read 3950 writes `[304.05]`. **"The 60 s-read deficits are not re-run and
// nothing asserts them" is withdrawn, on both halves.** They were re-run — the
// 70 s sweep above carries the same 2.00 s clean / 1.00 s dragging pair from
// `k = 6` to `k = 31` against this `State` — and the pair *is* asserted, at the
// 20 s read, by the two `toBeCloseTo` lines that close the φ = 0 alternation
// case below. Flattening it would go red there, so the "rots silently" clause
// was wrong about the one figure it named.
//
// **What really is not re-run is the `k = 6`–`k = 15` arm-frame census**, and
// that one does rot silently: nothing below reads the composable's expression at
// frame-delivery time, so its residues (3.0000000953674544 and the 2.95 frame
// before it) are described here and asserted nowhere.
//
// This file asserts against the model server, which is legitimate for eight of
// the nine cases and would not be for an assertion-side fixture: those rows are
// *playing* rooms, and the divergence #360 records between
// `test/helpers/syncplay-min-election-server.ts` and a real 1.7.6 server is on a
// **paused** minimum, which none of them produces (each asserts the room stays
// unpaused, so a case that drifted into that regime goes red rather than quietly
// measuring the model).
//
// **The off-phase case is the exception and it is flagged rather than quietly
// seated.** What it pins is the switcher asserting `{0, paused: true}`, so it
// drives the room *through* a paused minimum — exactly the regime #384 records
// the model latching on where the reference flaps. Its room reads unpaused at
// every window it asserts, because the flap passes back through playing each
// second rather than latching; but the **magnitudes** in it (19 writes in 20 s,
// 10 of them to 0, room 313.60) are model numbers and a real 1.7.6 server may
// put different ones there. What is not at risk is the sign and the shape: the
// assertion of a paused 0 is read off this client's own wire, and the forced
// update it triggers is `test/helpers/syncplay-min-election-server.ts`'s
// literal copy of the reference's. Treat the counts as the model's and the
// mechanism as the tree's, and settle the counts against the real server
// through #384's conformance harness before any of them is quoted elsewhere.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { Peer, TwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { WireFrame } from '../helpers/syncplay-min-election-server'

const DELAY_MS = 50

/** A mirror omits the `paused` key entirely, so `undefined` is the
 *  discriminator — the same test the sibling adoption file uses, spelled again
 *  here rather than exported, because it is two lines and the two files are read
 *  separately. */
const mirroring = (frames: WireFrame[]): WireFrame[] => frames.filter((f) => f.paused === undefined)

/** The complement: a frame that made a pause claim, i.e. the seat asserting its
 *  own snapshot rather than handing the room its own number back. */
const asserting = (frames: WireFrame[]): WireFrame[] => frames.filter((f) => f.paused !== undefined)

/**
 * The switcher's first assertion *after* its mirror run, and how far under the
 * room it landed.
 *
 * Sliced off the end of the mirror run rather than by timestamp, because the
 * two frames the seat asserts *before* the mirror starts are also assertions —
 * `PLAYBACK_ASSERT_STALE_MS` (2 s) has not expired yet at the first two
 * heartbeats after the switch, so both carry the previous episode's frozen
 * 303.95. Taking `asserting(post)[0]` would read one of those and measure
 * nothing: it is the same number in a dragging cell and a clean one.
 *
 * `room - position` rather than the other way round so the sign reads as
 * "under", which is the direction that wins `Room.getPosition()`'s `min()`.
 */
const firstAssertAfterMirror = (post: WireFrame[]): { under: number; frame: WireFrame } => {
  let lastMirror = -1
  post.forEach((f, i) => {
    if (f.paused === undefined) lastMirror = i
  })
  const frame = post[lastMirror + 1]
  return { under: frame.room - frame.position, frame }
}

describe('SyncplayClient — the non-switching peer across an episode change (#360)', () => {
  let room: TwoPeerRoom | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    room = undefined
    vi.useRealTimers()
  })

  /**
   * Seat the switcher and the innocent peer at the same position with the room,
   * let them agree for four seconds, and hand back both plus the length of the
   * switcher's wire at that instant so a caller can slice the post-switch frames
   * out of it.
   *
   * `bindGapMs` lands on the switcher only. The innocent peer never reloads, so
   * a gap on it would be dead configuration that reads like a variable.
   *
   * `switchOffsetMs` moves the switch off the four-second boundary, and it is a
   * knob rather than a constant because **everything else in this file is
   * measured at zero and zero is a measure-zero case.** At `0` the switch lands
   * on the same millisecond as a room broadcast, a renderer snapshot push and a
   * main heartbeat — the harness seats all three on absolute 1 s boundaries —
   * and the frame that broadcast puts in the air is still in flight when
   * `reload()` runs, which is what makes the shipped 500 ms gap a 2.45 s near
   * miss rather than a 1 Hz flap. See the last case.
   */
  const seatPair = async (
    bindGapMs: number,
    switchOffsetMs = 0
  ): Promise<{ switcher: Peer; innocent: Peer; wireBefore: number }> => {
    room = await createTwoPeerRoom({ position: 300, paused: false })
    const switcher = await room.seat({
      username: 'hostuser',
      position: 300,
      paused: false,
      delayMs: DELAY_MS,
      bindGapMs
    })
    const innocent = await room.seat({
      username: 'joinuser',
      position: 300,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4 + switchOffsetMs / 1000)

    // Neither element is written to before the switch. "Measured at all three
    // gaps" is withdrawn as the ground for that — it dated from the three-case
    // file and would now be a claim about three of the nine bind gaps seated
    // here (500, 3000, 5000, 5001, 6500, 7500, 8500, 29500, 30500). It is
    // asserted instead, on the two lines below, so it holds at every seating by
    // construction rather than at the gaps someone happened to check. So nothing
    // below clears `seekWrites`, and every list this file asserts is the switch's
    // whole footprint rather than a window of it — which is the difference
    // between "one write, to 303" and "one write since we stopped looking".
    expect(switcher.el.seekWrites).toEqual([])
    expect(innocent.el.seekWrites).toEqual([])

    return { switcher, innocent, wireBefore: room.server.wireOf('hostuser').length }
  }

  it('leaves the non-switching peer where it is at the shipped 500 ms bind gap — the control', async () => {
    // PINS CURRENT BEHAVIOUR. The `[]` here is the outcome #360 wants at every
    // gap, so this case alone reads as a desired invariant — but the *margin* it
    // holds by does not, and the eight cases below are the same code failing.
    // The last of them is the sharpest: it holds this gap at 500 and moves only
    // the switch's phase, and the `[]` does not survive it. See #360.
    const { switcher, innocent, wireBefore } = await seatPair(500)
    const server = room!.server

    await switcher.goToEpisode('8')
    await room!.advance(6)

    // The switcher's own element takes #360's write: one seek, to the previous
    // episode's timestamp, on a file that has no such position. That is the
    // defect this issue is titled after, and it is present in every case in this
    // file — "all three cases" is withdrawn as a count, not as a claim: the 303
    // write is asserted again at the 7.5/8.5 s pair, at the 29.5/30.5 s pair and,
    // as the first assertion on the wire, in the off-phase case.
    expect(switcher.el.seekWrites).toHaveLength(1)
    expect(switcher.el.seekWrites[0]).toBeCloseTo(303, 2)

    // And it reaches the wire with no spectator mirror in front of it at all.
    // Not "a short mirror" — zero frames: the seat is de-adopted at
    // `src/main/syncplay.ts:789` and re-latched before the next push, so the
    // switcher asserts continuously straight through the switch.
    expect(mirroring(server.wireOf('hostuser').slice(wireBefore))).toEqual([])

    // The innocent peer is not moved, and the room is the sibling adoption
    // file's 307.5 — which is the switcher's dragged value, 2.45 s under the
    // innocent peer's own element, not the 309.95 six more seconds of playback
    // would have left.
    expect(innocent.el.seekWrites).toEqual([])
    expect(innocent.el.paused).toBe(false)
    expect(server.roomState().position).toBeCloseTo(307.5, 1)
    expect(server.roomState().paused).toBe(false)
    expect(innocent.el.currentTime).toBeCloseTo(309.95, 2)

    await room!.advance(8)
    expect(innocent.el.seekWrites).toEqual([])
    expect(server.roomState().position).toBeCloseTo(315.5, 1)
    expect(innocent.el.currentTime).toBeCloseTo(317.95, 2)

    await room!.advance(6)
    expect(innocent.el.seekWrites).toEqual([])
    expect(server.roomState().position).toBeCloseTo(321.5, 1)
    expect(innocent.el.currentTime).toBeCloseTo(323.95, 2)

    // The near miss, as a number. The gate at
    // `src/renderer/src/composables/use-syncplay-client.ts:1411` needs the
    // element-against-state difference to exceed 3.0, and this is what it is:
    // 2.45, constant from the switch out to 20 s. The deficit does not close and
    // it does not grow — it is a standing 2.45 s error that survives because it
    // is 0.55 s short of being acted on.
    expect(Math.abs(innocent.el.currentTime - server.roomState().position)).toBeCloseTo(2.45, 2)

    // Out to 60 s, which is where the old 20 s read was the whole of the
    // evidence. Still the same 2.45, still no seek: the deficit is a fixed point
    // rather than a slow ramp, so "it did not cross in the window we looked at"
    // is not what is being asserted here. Swept to **300 s** outside the suite
    // (a probe, not a test, not in CI) at 2.45 on every read; 60 s is what the
    // committed case pays for.
    await room!.advance(40)
    expect(innocent.el.seekWrites).toEqual([])
    expect(server.roomState().position).toBeCloseTo(361.5, 1)
    expect(innocent.el.currentTime).toBeCloseTo(363.95, 2)
    expect(Math.abs(innocent.el.currentTime - server.roomState().position)).toBeCloseTo(2.45, 2)
  })

  it('drags the non-switching peer backwards at a 3 s bind gap', async () => {
    // PINS CURRENT BEHAVIOUR, BELIEVED WRONG. A peer that pressed nothing has
    // its playhead written backwards and loses ~5 s of playback. The analysis —
    // the de-adopt at `src/main/syncplay.ts:789`, the stale re-latch at
    // `src/main/syncplay.ts:2642`, and why #360's own inbound write is upstream
    // of both the room drag and this one — is in #360. This is not a guard: when
    // #360 is fixed, this case inverts.
    const { switcher, innocent, wireBefore } = await seatPair(3000)
    const server = room!.server

    await switcher.goToEpisode('8')
    await room!.advance(6)

    expect(switcher.el.seekWrites).toHaveLength(1)
    expect(switcher.el.seekWrites[0]).toBeCloseTo(303, 2)

    // The innocent peer is seeked, once, to 304.05 — backwards from the 309.95
    // the control leaves it at over the same six seconds.
    expect(innocent.el.seekWrites).toHaveLength(1)
    expect(innocent.el.seekWrites[0]).toBeCloseTo(304.05, 2)
    expect(innocent.el.currentTime).toBeCloseTo(305, 2)
    expect(server.roomState().paused).toBe(false)

    // The room went with it: 305.00 against the control's 307.5.
    expect(server.roomState().position).toBeCloseTo(305, 1)

    // The mirror exists here and lasts exactly one frame. This is the whole of
    // `docs/syncplay.md`'s "withholds our playstate entirely" on this path — one
    // push — and the frame after it is the seat asserting 303.00 into a room
    // that read 306.95, which is the election that drags the room.
    const post = server.wireOf('hostuser').slice(wireBefore)
    expect(mirroring(post)).toHaveLength(1)
    const mirrorAt = post.findIndex((f) => f.paused === undefined)
    expect(mirrorAt).toBe(2)
    expect(post[mirrorAt].position).toBeCloseTo(305.95, 2)
    expect(post[mirrorAt + 1].paused).toBe(false)
    expect(post[mirrorAt + 1].position).toBeCloseTo(303, 2)
    expect(post[mirrorAt + 1].room).toBeCloseTo(306.95, 2)
    // …and the next frame reads the room back at the asserted value: 306.95 →
    // 304.00, a backwards step of ~2.95 s in the room itself.
    expect(post[mirrorAt + 2].room).toBeCloseTo(304, 2)

    // The drag is not deferred and not repaired. Both later windows are past the
    // bind gap's release *and* past `PLAYBACK_STALE_MS`, and the peer stays one
    // write down and ~4.95 s behind the control for the rest of the session.
    await room!.advance(8)
    expect(innocent.el.seekWrites).toHaveLength(1)
    expect(server.roomState().position).toBeCloseTo(312, 1)
    expect(innocent.el.currentTime).toBeCloseTo(313, 2)

    await room!.advance(6)
    expect(innocent.el.seekWrites).toHaveLength(1)
    expect(server.roomState().position).toBeCloseTo(318, 1)
    expect(innocent.el.currentTime).toBeCloseTo(319, 2)
    expect(server.roomState().paused).toBe(false)
  })

  it('drags the non-switching peer later at a 6.5 s bind gap, writing it to 311.00 by the 14 s read', async () => {
    // PINS CURRENT BEHAVIOUR, BELIEVED WRONG. Same outcome as the 3 s case by a
    // different route: the gap outlives `PLAYBACK_STALE_MS`
    // (`src/main/syncplay.ts:66`), so `src/main/syncplay.ts:903` de-adopts on a
    // real drift rather than the file change, the mirror survives five frames,
    // and the write that closes it is the inbound one. #360 has the chain. That
    // is the route this cell enters by and not an account of the axis it sits on
    // — the header says why a monotone horizon cannot produce the comb — so this
    // name states what the case pins rather than the path it takes. When #360 is
    // fixed, this case inverts.
    //
    // The gap is 6500 rather than the 7000 this case was first written at, and
    // that is the only thing that moved: 7000 is the **top edge** of the
    // 6001-7000 run, so a change shifting that edge by one millisecond flipped
    // the case for a reason that was about the pin's placement and not about the
    // tree. 6500 is mid-run. Every assertion below is byte-identical at both
    // gaps, because the run's written value is stable where its edges are not —
    // every cell from 6001 to 7000 writes the same 311.00.
    const { switcher, innocent, wireBefore } = await seatPair(6500)
    const server = room!.server

    await switcher.goToEpisode('8')
    await room!.advance(6)

    // Six seconds in, the switcher's element is still at `HAVE_NOTHING` reading
    // 0 with nothing written to it yet, and *nobody* has been dragged. This is
    // the window a fixture that stopped at the bind gap's release would call a
    // pass.
    //
    // **Exactly 0, where this read was 0.05 before #384 made `goToEpisode()`
    // flush the index bump before the rebind.** The 0.05 was one 50 ms slice of
    // the element walking, and the flush is what removes it. `reload()` pauses
    // the element, and what un-pauses it is the ready gate's play arm
    // (`src/renderer/src/composables/use-syncplay-client.ts:1287`) reached from
    // `watch(syncplayRoomUsers, …)`
    // (`src/renderer/src/composables/use-syncplay-client.ts:2295`) — woken, at
    // this instant, by the roster change the switch's own file push produces.
    // Unflushed, the push and the reload landed in the same instant with the
    // reload *first*, so the gate found a paused element and re-anchored it
    // playing at the switch instant; by the first tick 50 ms later it had walked
    // 0.05 s and, being re-paused there, kept that reading for the rest of the
    // window. Flushed, the push is delivered while the element is still bound to
    // the *old* episode and still playing, so the play arm's `v.paused` guard
    // skips it; `reload()` then pauses the element and the un-pause waits for the
    // next roster delivery — the far peer's echo, one `DELAY_MS` later — which
    // anchors it at the slice boundary instead of 50 ms before it. Asserted
    // exactly rather than close-to because the element is parked: anchored at 0
    // and paused in the same slice, it reads 0 for the whole window.
    expect(switcher.el.seekWrites).toEqual([])
    expect(switcher.el.currentTime).toBe(0)
    expect(innocent.el.seekWrites).toEqual([])
    expect(server.roomState().position).toBeCloseTo(308.95, 1)
    expect(innocent.el.currentTime).toBeCloseTo(309.95, 2)

    await room!.advance(8)

    // Past the gap, the switcher is placed at the previous episode's 303 and then
    // at 309, and the innocent peer is written to 311.00 — backwards from the
    // 317.95 the control has it at over the same fourteen seconds.
    expect(switcher.el.seekWrites).toHaveLength(2)
    expect(switcher.el.seekWrites[0]).toBeCloseTo(303, 2)
    expect(switcher.el.seekWrites[1]).toBeCloseTo(309, 2)
    expect(innocent.el.seekWrites).toHaveLength(1)
    expect(innocent.el.seekWrites[0]).toBeCloseTo(311, 2)
    expect(server.roomState().position).toBeCloseTo(313.95, 1)
    expect(innocent.el.currentTime).toBeCloseTo(314.95, 2)
    expect(server.roomState().paused).toBe(false)

    // Five mirror frames, against one at 3 s: the two de-adoption paths are
    // distinguishable from the wire alone, which is the only reason this case is
    // not a second row of the 3 s one.
    expect(mirroring(server.wireOf('hostuser').slice(wireBefore))).toHaveLength(5)

    await room!.advance(6)
    expect(innocent.el.seekWrites).toHaveLength(1)
    expect(server.roomState().position).toBeCloseTo(319.95, 1)
    expect(innocent.el.currentTime).toBeCloseTo(320.95, 2)
    expect(innocent.el.paused).toBe(false)
    expect(server.roomState().paused).toBe(false)
  })

  it('alternates above k = 5 at switch phase φ = 0 — clean at a 7.5 s bind gap, dragged to 313.00 at 8.5 s', async () => {
    // PINS CURRENT BEHAVIOUR, BELIEVED WRONG, in the dragging half — and the
    // clean half is not the desired invariant either, it is the *other* half of
    // an alternation nobody chose. When #360 is fixed the 8.5 s half inverts; the
    // 7.5 s half is expected to stay `[]` and to stop being a coincidence.
    //
    // **"Alternates by the parity of `k`" is withdrawn from this case's name and
    // `φ = 0` put in its place.** Parity of `k` is not the axis — the header
    // measures every comb edge moving with the switch's phase, so at φ = 500 the
    // even `k = 6` cell at gap 5600 drags and the odd `k = 7` cell at 6600 is
    // clean. What parity indexes is this seating, because `seatPair`'s
    // `switchOffsetMs` defaults to 0 and the harness seats the room broadcast,
    // the renderer push and main's heartbeat on absolute 1 s boundaries. The
    // alternation below is real and is pinned as measured; only its *name* was
    // claiming an axis the sweep took away. What it is underneath — the hold half
    // of a 2.00 s staircase against its step half — is pinned by the case after
    // this one, which is where that claim is asserted rather than described.
    //
    // This is the only case in the suite that pins the comb's **shape** rather
    // than one of its cells. The three cases above all sit at `k <= 7`, so a
    // change collapsing the axis back to a single threshold above 5000 — every
    // gap past `PLAYBACK_STALE_MS` drags — would leave all three green with only
    // the header wrong. The 7.5 s row is what goes red on it: `k = 8` outlives
    // that horizon by 2.5 s and is clean anyway.
    //
    // Both windows are named because "clean" is window-relative throughout this
    // file. Read at 6 s the two gaps are **indistinguishable** — same room, same
    // untouched elements, same four mirror frames — and they part company at the
    // 14 s read, which is also where the switcher's own footprint turns out to be
    // identical across the pair (`[303, 311]` at both). So the difference the
    // alternation makes is not visible in what the switcher does, and is not
    // visible at all until the second window.
    //
    // Two gaps in one case on purpose. The assertion here *is* the difference
    // between them, and as two cases either half could be deleted with the other
    // still green — which is exactly the mutation this case exists to catch. The
    // second room's numbers were measured both inside this case and in isolation
    // and are byte-identical, so the shared fake clock carries nothing across.
    //
    // 7500 and 8500 rather than the 8000/8001 pair the header's census
    // straddles: those two are the two sides of a 1 ms edge, and pinning them
    // would pin that edge's position. These two are mid-run in their respective
    // runs, so what they pin is the alternation.

    // ── `k = 8`, clean ──────────────────────────────────────────────────────
    const even = await seatPair(7500)
    const evenServer = room!.server

    await even.switcher.goToEpisode('8')
    await room!.advance(6)

    expect(even.switcher.el.seekWrites).toEqual([])
    // 0 rather than the pre-#384 0.05, for the reason spelled out in full on the
    // same read in the 6.5 s case above: the flushed index bump lets the ready
    // gate's play arm see an element that is still playing the old episode, so
    // the un-pause waits a slice and the element's anchor lands on the read
    // boundary rather than 50 ms before it.
    expect(even.switcher.el.currentTime).toBe(0)
    expect(even.innocent.el.seekWrites).toEqual([])
    expect(evenServer.roomState().position).toBeCloseTo(308.95, 1)
    expect(even.innocent.el.currentTime).toBeCloseTo(309.95, 2)
    expect(mirroring(evenServer.wireOf('hostuser').slice(even.wireBefore))).toHaveLength(4)

    await room!.advance(8)

    // The switcher takes both of #360's writes here exactly as it does at 8.5 s,
    // and the innocent peer is left where fourteen seconds of playback put it —
    // the control's own 317.95.
    expect(even.switcher.el.seekWrites).toHaveLength(2)
    expect(even.switcher.el.seekWrites[0]).toBeCloseTo(303, 2)
    expect(even.switcher.el.seekWrites[1]).toBeCloseTo(311, 2)
    expect(even.innocent.el.seekWrites).toEqual([])
    expect(evenServer.roomState().position).toBeCloseTo(315.95, 1)
    expect(even.innocent.el.currentTime).toBeCloseTo(317.95, 2)
    expect(mirroring(evenServer.wireOf('hostuser').slice(even.wireBefore))).toHaveLength(6)

    await room!.advance(6)
    expect(even.innocent.el.seekWrites).toEqual([])
    expect(evenServer.roomState().position).toBeCloseTo(321.95, 1)
    expect(even.innocent.el.currentTime).toBeCloseTo(323.95, 2)
    expect(even.innocent.el.paused).toBe(false)
    expect(evenServer.roomState().paused).toBe(false)

    // The standing deficit that makes this a clean cell rather than a near miss:
    // 2.00 s against the gate's 3.0, a full second of room where the 500 ms
    // control has 0.55 and a 1000 ms gap has 0.05. No edge of the comb is a near
    // miss at the gate — see the arm-frame census in the header.
    expect(Math.abs(even.innocent.el.currentTime - evenServer.roomState().position)).toBeCloseTo(
      2,
      2
    )

    // ── `k = 9`, dragged ────────────────────────────────────────────────────
    room!.dispose()
    room = undefined

    const odd = await seatPair(8500)
    const oddServer = room!.server

    await odd.switcher.goToEpisode('8')
    await room!.advance(6)

    // Indistinguishable from the `k = 8` row at this window, down to the mirror
    // count. A fixture that read only here would report the comb as flat.
    expect(odd.switcher.el.seekWrites).toEqual([])
    // Same 0, same cause as the `k = 8` row above — which is part of what makes
    // the two rows indistinguishable at this window.
    expect(odd.switcher.el.currentTime).toBe(0)
    expect(odd.innocent.el.seekWrites).toEqual([])
    expect(oddServer.roomState().position).toBeCloseTo(308.95, 1)
    expect(odd.innocent.el.currentTime).toBeCloseTo(309.95, 2)
    expect(mirroring(oddServer.wireOf('hostuser').slice(odd.wireBefore))).toHaveLength(4)

    await room!.advance(8)

    // One heartbeat of bind gap later, and the peer that pressed nothing is
    // written to 313.00 — two seconds up from the 6.5 s run's 311.00, which is
    // the `+2.00 s per dragging run` the header describes, and 4.95 s behind the
    // 317.95 the `k = 8` row above leaves it at over the same fourteen seconds.
    // The switcher's writes are the same two.
    expect(odd.switcher.el.seekWrites).toHaveLength(2)
    expect(odd.switcher.el.seekWrites[0]).toBeCloseTo(303, 2)
    expect(odd.switcher.el.seekWrites[1]).toBeCloseTo(311, 2)
    expect(odd.innocent.el.seekWrites).toHaveLength(1)
    expect(odd.innocent.el.seekWrites[0]).toBeCloseTo(313, 2)
    expect(oddServer.roomState().position).toBeCloseTo(314, 1)
    expect(odd.innocent.el.currentTime).toBeCloseTo(314.95, 2)
    expect(oddServer.roomState().paused).toBe(false)
    expect(mirroring(oddServer.wireOf('hostuser').slice(odd.wireBefore))).toHaveLength(7)

    await room!.advance(6)
    expect(odd.innocent.el.seekWrites).toHaveLength(1)
    expect(oddServer.roomState().position).toBeCloseTo(319.95, 1)
    expect(odd.innocent.el.currentTime).toBeCloseTo(320.95, 2)
    expect(odd.innocent.el.paused).toBe(false)
    expect(oddServer.roomState().paused).toBe(false)

    // And the deficit the drag leaves behind is 1.00 s, against the clean row's
    // 2.00 — the two steady states the header's 60 s census reports, here at the
    // 20 s read the rest of this file uses.
    expect(Math.abs(odd.innocent.el.currentTime - oddServer.roomState().position)).toBeCloseTo(1, 2)
  })

  it('selects the dragging cell by where the first post-bind assertion lands against the room — 1.95 s under at 6.5 s, 0.05 s over at 7.5 s', async () => {
    // PINS CURRENT BEHAVIOUR, BELIEVED WRONG, and it is the pin the header's
    // account of the comb rests on. The three cases above pin cells and one
    // alternation; this one pins the **quantity that decides them**, so a change
    // that moved the comb's phase without moving 6.5/7.5 across it would still go
    // red here. When #360 is fixed the 6.5 s half inverts.
    //
    // Two gaps in one case for the same reason as the alternation case: the
    // assertion *is* the difference between the two numbers.
    //
    // What the room does during the bind gap, identical in both cells, sampled
    // on heartbeat boundaries: it is a **staircase that holds for two heartbeats
    // and then jumps 2.00 s**, not a line. That is the switcher's own spectator
    // mirror feeding `Room.getPosition()`'s `min()` and being re-elected one
    // link delay behind itself — the room's elected position is its own mirror's
    // stale value every other second. Step 2.00 s — the successive differences
    // are `1, 0, 2, 0, 2, 0` across the seven samples below — period
    // 2 × `HEARTBEAT_MS`. See the header on why this says "step" and not
    // "amplitude".
    const stairOf = async (gapMs: number): Promise<{ stair: number[]; under: number }> => {
      const { switcher, innocent, wireBefore } = await seatPair(gapMs)
      const server = room!.server
      await switcher.goToEpisode('8')
      const stair: number[] = []
      for (let i = 0; i < 7; i += 1) {
        await room!.advance(1)
        stair.push(server.roomState().position)
      }
      await room!.advance(13)
      const { under, frame } = firstAssertAfterMirror(server.wireOf('hostuser').slice(wireBefore))
      // The asserted number is the room's own elected position from two
      // heartbeats earlier, carried on the element the inbound frame wrote and
      // re-latched by `src/main/syncplay.ts:2642`. It is the *same* arithmetic in
      // both cells; only which step of the staircase the room has reached by the
      // time it goes out differs.
      expect(frame.paused).toBe(false)
      expect(innocent.el.seekWrites.length).toBe(under > 1 ? 1 : 0)
      return { stair, under }
    }

    // ── `k = 7`, the room has just jumped: the assertion is 1.95 s under ──────
    const odd = await stairOf(6500)
    expect(odd.stair.map((p) => Number(p.toFixed(2)))).toEqual([
      303.95, 304.95, 304.95, 306.95, 306.95, 308.95, 308.95
    ])
    expect(odd.under).toBeCloseTo(1.95, 2)

    room!.dispose()
    room = undefined

    // ── `k = 8`, the room is still on the hold: the assertion is 0.05 s over ──
    const even = await stairOf(7500)
    // Byte-identical to the dragging cell's staircase. Asserted rather than
    // described, because "the room does the same thing in both cells" is the
    // half that makes the selector a *phase* and not a magnitude: nothing about
    // the room's own motion distinguishes 6.5 s from 7.5 s.
    expect(even.stair.map((p) => Number(p.toFixed(2)))).toEqual([
      303.95, 304.95, 304.95, 306.95, 306.95, 308.95, 308.95
    ])
    expect(even.under).toBeCloseTo(-0.05, 2)

    // The two values are 2.00 s apart, which is the staircase's step and
    // not a coincidence — stated as the subtraction so a change that moved both
    // by the same amount keeps this line green and reds the two above it.
    expect(odd.under - even.under).toBeCloseTo(2, 2)
  })

  it('de-adopts the switcher at the bind release from a 5001 ms gap and not from 5000 — the lower run’s top edge is `src/main/syncplay.ts:903` itself', async () => {
    // PINS CURRENT BEHAVIOUR. Not "believed wrong" on its own: this is the
    // mechanism behind an edge the header already measured from the outside, and
    // it is pinned because the outside measurement could not tell it from any
    // other staleness story. #360 records the firing of
    // `src/main/syncplay.ts:903` as *inferred from two gap samples*; this case is
    // the instrument, and `Peer.adopted()` is the private read it needs.
    //
    // The edge is one millisecond wide and it is exactly `PLAYBACK_STALE_MS`
    // (`src/main/syncplay.ts:66` ("const PLAYBACK_STALE_MS = 5000")), via the
    // `<=` at `src/main/syncplay.ts:2348` ("return this.lastSnapshotAt > 0 &&
    // Date.now() - this.lastSnapshotAt <= PLAYBACK_STALE_MS"): the first push
    // after the bind release is `gap` ms after the last push before the switch,
    // so 5000 is inside the horizon and 5001 is not.
    //
    // **This is also what rules `src/main/syncplay.ts:903` out as the comb's
    // selector, by instrumentation rather than by the monotonicity argument the
    // header gives.** It fires at *every* gap above 5000 — the clean cells at
    // `k = 8`, `k = 10`, `k = 12` included — so it marks the boundary between
    // the lower run and the comb and says nothing about which comb cells drag.
    // **That sentence is a census, and the case below is where it is asserted**;
    // this one establishes only the edge, because a read positioned on the 5000
    // boundary cannot see a drop that happens 1.5 s later.
    //
    // The helper reports the two latch reads and the innocent peer's writes and
    // asserts neither. **The outcome is asserted at the call sites on purpose.**
    // It used to be folded in here as `toBe(afterRelease ? 1 : 0)`, which reads
    // as the rule "de-adopted ⇒ clean" — true at the two gaps seated below and
    // **false one run up the comb**, where the latch drops at the release and
    // the peer is dragged anyway. The case under this one pins that, so the
    // implication is not restated here even as a convenience.
    const adoptedAt = async (
      gapMs: number
    ): Promise<{ atRelease: boolean; afterRelease: boolean; seekWrites: number[] }> => {
      const { switcher, innocent } = await seatPair(gapMs)
      await switcher.goToEpisode('8')
      await room!.advance(5)
      // Still adopted in both cells: `src/main/syncplay.ts:789` de-adopted on the
      // file change and `src/main/syncplay.ts:2642` re-latched one heartbeat
      // later on the previous episode's snapshot, which is the self-cancelling
      // de-adoption #360's chain opens with.
      const atRelease = switcher.adopted()
      await room!.advance(0.05)
      const afterRelease = switcher.adopted()
      await room!.advance(14.95)
      return { atRelease, afterRelease, seekWrites: innocent.el.seekWrites }
    }

    // The outcome the two paths reach, which is the other half of why the edge
    // matters: still adopted ⇒ the seat asserts the previous episode's 303 and
    // the innocent peer is dragged; de-adopted ⇒ it waits for the new element's
    // first live room frame and the comb decides — and at 5001 the comb's answer
    // happens to be "nothing". Read each pair of lines below as *this gap drags*
    // and *this gap does not*, never as a rule keyed on the latch.
    const inside = await adoptedAt(5000)
    expect(inside.atRelease).toBe(true)
    expect(inside.afterRelease).toBe(true)
    expect(inside.seekWrites.length).toBe(1)

    room!.dispose()
    room = undefined

    const outside = await adoptedAt(5001)
    expect(outside.atRelease).toBe(true)
    // One millisecond of bind gap, and the latch is gone at the release.
    expect(outside.afterRelease).toBe(false)
    expect(outside.seekWrites.length).toBe(0)
  })

  it('drops the latch at the bind release at 6500 (drags) and at 7500 (clean) alike at φ = 0 — the staleness de-adoption fires on the clean comb cell too', async () => {
    // PINS CURRENT BEHAVIOUR, and it is the pin this file's headline claim was
    // missing. The paragraph above says that
    // `src/main/syncplay.ts:903` ("this.playbackAdopted = false") is **not**
    // the comb's selector, and until this case that was described in prose and
    // asserted nowhere — which is the failure mode this file's own header
    // records, an unasserted census rotting silently. Raised on review of #480
    // and measured there independently, by stepping `adopted()` at 50 ms
    // resolution across the release.
    //
    // It cannot reuse `adoptedAt` above, and the reason is the point: that
    // helper reads the latch at a fixed 5.00 s and 5.05 s, positioned on the
    // `PLAYBACK_STALE_MS` edge, and both reads land *before* the bind release at
    // either gap here. Read there, both cells still say adopted — so the
    // 5000/5001 instrument cannot see this drop at all, and the read has to
    // follow the gap instead. This helper therefore takes three samples: the
    // 5.05 s point the pair above uses, the release slice itself, and one slice
    // past it. The window stays 20 s wide at both gaps so the write list is
    // comparable with the rest of the file.
    const latchAcrossRelease = async (
      gapMs: number
    ): Promise<{
      atStaleEdge: boolean
      atRelease: boolean
      afterRelease: boolean
      seekWrites: number[]
    }> => {
      const { switcher, innocent } = await seatPair(gapMs)
      await switcher.goToEpisode('8')
      await room!.advance(5.05)
      const atStaleEdge = switcher.adopted()
      await room!.advance(gapMs / 1000 - 5.05)
      const atRelease = switcher.adopted()
      await room!.advance(0.05)
      const afterRelease = switcher.adopted()
      await room!.advance(20 - gapMs / 1000 - 0.05)
      return { atStaleEdge, atRelease, afterRelease, seekWrites: innocent.el.seekWrites }
    }

    // `k = 7`, a dragging cell. The latch is still up at the 5.05 s read, gone
    // by the release — and the peer is dragged to 311.00 regardless, by the
    // first post-bind push rather than by the assertion the latch would have
    // authorised.
    const dragging = await latchAcrossRelease(6500)
    expect(dragging.atStaleEdge).toBe(true)
    expect(dragging.atRelease).toBe(false)
    expect(dragging.afterRelease).toBe(false)
    expect(dragging.seekWrites.length).toBe(1)
    expect(dragging.seekWrites[0]).toBeCloseTo(311, 2)

    room!.dispose()
    room = undefined

    // `k = 8`, a clean cell, reached through a byte-identical latch history.
    const clean = await latchAcrossRelease(7500)
    expect(clean.atStaleEdge).toBe(true)
    expect(clean.atRelease).toBe(false)
    expect(clean.afterRelease).toBe(false)
    expect(clean.seekWrites).toEqual([])

    // The whole claim, stated as the comparison: the latch history is the same
    // in both cells and the outcomes differ, so whatever selects the comb is not
    // this latch. The per-cell lines above already imply both assertions below;
    // they are kept so that re-pinning one cell's latch reads or write count
    // cannot go through without confronting the other cell.
    expect([dragging.atStaleEdge, dragging.atRelease, dragging.afterRelease]).toEqual([
      clean.atStaleEdge,
      clean.atRelease,
      clean.afterRelease
    ])
    expect(dragging.seekWrites.length).not.toBe(clean.seekWrites.length)
  })

  it('keeps combing out to a 30.5 s bind gap — clean at `k = 30`, dragged to 335.00 at `k = 31`', async () => {
    // PINS CURRENT BEHAVIOUR, BELIEVED WRONG, in the dragging half. #360 records
    // the comb as having **no upper end measured**, with `k = 13` and `k = 15`
    // the highest cells anyone had run. It has now been swept on mid-run cells
    // from `k = 6` to `k = 31` — a 30.5 s gap — and it does not terminate: every
    // odd `k` drags, every even `k` is clean, the dragged value is **304 + k**
    // at every dragging cell in that range, and the mirror run is **k - 2**
    // frames wide at every cell. This case pins the far end rather than the
    // whole sweep, because a terminus would have to show up as the far pair
    // collapsing to one outcome.
    //
    // Both windows named, as everywhere in this file. At 20 s the two gaps are
    // **indistinguishable** — same room, same untouched elements, same mirror
    // count, and the switcher has not been written to at all — because a 30 s
    // bind gap has not released yet. They part company at the 36 s read.
    const far = async (
      gapMs: number
    ): Promise<{ early: number[]; late: number[]; room: number; mirror: number; sw: number[] }> => {
      const { switcher, innocent, wireBefore } = await seatPair(gapMs)
      const server = room!.server
      await switcher.goToEpisode('8')
      await room!.advance(20)
      const early = [...innocent.el.seekWrites]
      expect(innocent.el.currentTime).toBeCloseTo(323.95, 2)
      expect(server.roomState().position).toBeCloseTo(322.95, 1)
      expect(switcher.el.seekWrites).toEqual([])
      expect(mirroring(server.wireOf('hostuser').slice(wireBefore))).toHaveLength(18)
      await room!.advance(16)
      return {
        early,
        late: [...innocent.el.seekWrites],
        room: server.roomState().position,
        mirror: mirroring(server.wireOf('hostuser').slice(wireBefore)).length,
        sw: [...switcher.el.seekWrites]
      }
    }

    const evenCell = await far(29500)
    expect(evenCell.early).toEqual([])
    expect(evenCell.late).toEqual([])
    expect(evenCell.room).toBeCloseTo(337.95, 1)
    expect(evenCell.mirror).toBe(28)

    room!.dispose()
    room = undefined

    const oddCell = await far(30500)
    expect(oddCell.early).toEqual([])
    expect(oddCell.late).toHaveLength(1)
    expect(oddCell.late[0]).toBeCloseTo(335, 2)
    expect(oddCell.room).toBeCloseTo(336, 1)
    expect(oddCell.mirror).toBe(29)

    // The switcher's own footprint is identical across the pair, as it is across
    // the `k = 8`/`k = 9` pair twenty-two heartbeats below: 303 and then 333.
    // So nothing the switcher's element does distinguishes the two cells here
    // either, which is what keeps this a pin of the comb rather than of a cell.
    expect(evenCell.sw.map((v) => Number(v.toFixed(2)))).toEqual([303, 333])
    expect(oddCell.sw.map((v) => Number(v.toFixed(2)))).toEqual([303, 333])
  })

  it('replaces the 500 ms near miss with a 1 Hz room flap when the switch lands 50 ms off the room broadcast', async () => {
    // PINS CURRENT BEHAVIOUR, BELIEVED WRONG, and it is the case that narrows
    // the control above rather than adding to it. The control's 2.45 s is real
    // and holds out to 300 s — but **only while the switch lands inside the
    // flight time of a room frame**, which is what the harness's whole-second
    // `advance(4)` arranges and what nothing in the app does. Move the switch
    // one 50 ms slice later, at the same shipped 500 ms bind gap, and the
    // innocent peer takes **19 seeks in 20 s**, half of them to 0.
    //
    // The chain, measured: with no frame in the air across `reload()` there is no
    // parked apply, so nothing writes the previous episode's position onto the
    // rebound element. The first push after the release therefore carries the new
    // element's own `{0, paused: true}`; `src/main/syncplay.ts:903` cannot help
    // at a 500 ms gap (see the case above), the seat is still latched from
    // `src/main/syncplay.ts:2642`, and `canAssertSnapshot()` exempts a *paused*
    // snapshot from `PLAYBACK_ASSERT_STALE_MS` at
    // `src/main/syncplay.ts:2375` ("if (this.snapshot.paused) return true"). So
    // `{0, paused: true}` goes out as an assertion, the server's forced update
    // re-seats every watcher onto 0, and the room then alternates between 0 and
    // its walking position for the rest of the session.
    //
    // The boundary is exactly one link delay, measured outside the suite across
    // a (offset, delay) grid: clean for every offset strictly under `delayMs`
    // and flapping from `delayMs` on, at 50, 200 and 400 ms of delay. So the
    // control's regime is a `delayMs / HEARTBEAT_MS` slice of the switch's
    // phase — 5% of it at the 50 ms this file seats.
    //
    // **This is not the drag this file is otherwise about, and it is not
    // `use-syncplay-client.ts:1411`'s 3.0 being crossed by a little.** It is a
    // different and worse failure reached from the shipped bind gap, and the
    // `{0, paused: true}` assertion at its root is the seam #360 carves out to
    // #383. Pinned here because it is what the control case means, not because
    // #360 owns the fix.
    const { switcher, innocent, wireBefore } = await seatPair(500, 50)
    const server = room!.server

    await switcher.goToEpisode('8')
    await room!.advance(6)

    // Six seconds in, the peer that pressed nothing has already been written to
    // 0 three times.
    expect(innocent.el.seekWrites).toHaveLength(5)
    expect(innocent.el.seekWrites[0]).toBeCloseTo(0, 2)
    expect(innocent.el.seekWrites.filter((v) => v === 0)).toHaveLength(3)
    expect(innocent.el.currentTime).toBeCloseTo(0, 2)

    // No spectator mirror anywhere in this run, against the control's zero for
    // the opposite reason: there the seat asserted continuously because it never
    // lost the latch, and here it asserts continuously *and* the thing it
    // asserts is the new element.
    expect(mirroring(server.wireOf('hostuser').slice(wireBefore))).toEqual([])
    const asserts = asserting(server.wireOf('hostuser').slice(wireBefore))
    // The first frame is the ordinary stale re-latch the control sends too. The
    // second is the new one: a paused 0, into a room that read 304.95.
    expect(asserts[0].position).toBeCloseTo(303.95, 2)
    expect(asserts[0].paused).toBe(false)
    expect(asserts[1].position).toBeCloseTo(0, 2)
    expect(asserts[1].paused).toBe(true)
    expect(asserts[1].room).toBeCloseTo(304.95, 2)
    // …and by the frame after next the room itself is at 0.
    expect(asserts[3].room).toBeCloseTo(0, 2)

    await room!.advance(14)

    // Nothing converges. One write per second, for as long as the session runs.
    expect(innocent.el.seekWrites).toHaveLength(19)
    expect(innocent.el.seekWrites.filter((v) => v === 0)).toHaveLength(10)
    expect(innocent.el.currentTime).toBeCloseTo(0, 2)
    expect(server.roomState().position).toBeCloseTo(313.6, 1)
    expect(server.roomState().paused).toBe(false)
  })
})
