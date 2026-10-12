# `fm3-query-subs.tap` — the three "unmapped" `fn=0x01` sub-actions, answered by the FM3

**Provenance:** written by `scripts/probe-query-subs.ts` against the owner's FM3 (fw 13.0, model byte `0x11`) on
2026-10-12, preset 410 (`"USA Mk IV"`) in the edit buffer. **Read-only**: every frame is `fn=0x01` with no value
bytes, and the probe now READS THE PRESET NAME BEFORE AND AFTER and exits 4 if it moved — it did not
(`"USA Mk IV"` both times). The run is repeatable: two runs produced the same lengths and the same table bytes.

**Why it exists.** `Axis/docs/NEXT-STEPS.md` listed `0x03`, `0x1b`, `0x2e` as UNMAPPED sub-actions "surfaced by the
capture analyser" and treated them as capture-gated — the FM3-Edit captures that revealed them live on the owner's
deck and are **not in this repo**. They are not capture-gated. Upstream's own gen-3 codec carries a per-sub-action
response-length table mined from the 2026-06-03 FM9 capture (`forgefx-midi/src/devices/gen3/simResponders.ts`),
which names two of them and predicts lengths — so the question could be put to the device directly.

**What the tap shows** (read it with `scripts/inspect-tap.ts`; never by eye):

| sub | result | notes |
|---|---|---|
| `0x4b` | **60 bytes** for a valid `[index, page]` | POSITIVE CONTROL — matches the known answer, so the instrument works |
| `0x99` | **SILENT**, 3/3, and never a `0x64` | NEGATIVE CONTROL — on this device "not implemented" reads as silence, which is what makes the three answers below meaningful |
| `0x03` | **23 bytes**, address-dependent | with the address region `[01 3a …]` (byte 8 = `0x3a` = the AMP's eid) the reply carries `1d 76`; with `[00 3a …]` or all zeros it is all zeros. So it is a per-address READ — the opposite of what "no upstream length entry" suggested |
| `0x1b` | **23 bytes**, address-dependent | one address reads `06` in a data byte where the others read zero |
| `0x2e` | **590 bytes** — or **23 bytes** when byte 7 is `0x01` | byte 7 is a SELECTOR: non-zero switches this sub from the table to a single small record. Upstream calls `0x2e` a LAYOUT MAP and expects 755B on an FM9; 590 on an FM3 is the same shape at a different geometry |

**The 590-byte reply, described but NOT decoded** (read it with `scripts/inspect-layout-map.ts`):

- Data region 576 bytes (header `0..11` and the checksum+`F7` stripped).
- **Three volatile bytes only** — data-relative `+22`, `+23`, `+24` — which differ between EVERY pair of replies,
  including two replies of the same preset and same address. Everything else is byte-identical.
- Zero bytes 241/576. **220 bytes hold a single-bit value** (`0x40/0x20/0x10/0x08/0x04/0x02/0x01`), i.e. the
  region is bit-level data, not a list of ids and lengths.
- The run `40 20 10 08 04 02 01 00` starts at 20 offsets, with IRREGULAR deltas (8, 8, 16, 8, 8, 32, 8, 24 …) —
  so it is not a fixed-stride record table.
- The one byte of the SHORT `0x2e` reply also varied between runs (`00` → `01` at `+12`).

**Dependence tests — `before.tap` / `during.tap` / `after.tap`** (2026-10-12, same day):

| step | what was done | result |
|---|---|---|
| `before` | read the map | baseline |
| `during` | `PUT /preset/switches/5 {"holdActionCode":7}` — a change to the **edit buffer** | diff `before`→`during`: **only the three volatile bytes + the checksum** |
| `after` | `PUT … {"holdActionCode":0}` — restore, read again | diff `before`→`after`: **only the three volatile bytes + the checksum** |

So the reply is **not derived from the edit buffer** — and therefore not from the loaded preset either, since a
preset loads INTO that buffer. Combined with the address test (a zero address region and a `00 3a …` region return
the same table), it behaves as a **static, model-side table** read once at connect — which matches what the
upstream capture that named it was (a connect + enum sweep).

**A hypothesis the data KILLS, kept because a killed hypothesis is a result:** the map is **not** a per-block
geometry table. `FM3_BLOCK_GEOMETRY` gives the repo 28 blocks with `cols × rows`, and no block id in the reply is
followed by its own `cols`/`rows`. (`scripts/inspect-layout-map.ts` runs that check every time and prints
`NO HITS`.)

**Nothing above is a MEANING.** "576 bytes, bit-level, stable, address- and state-independent" describes the
frames. No byte of any of the three replies has been decoded.

**Next steps this fixture enables, with no new capture — in the order they should be tried:**

1. **The three volatile bytes (`+22`/`+23`/`+24`).** Read the map twice inside ONE connection and twice across
   connections, and see whether the trio is session-scoped (a nonce/counter) or per-read. This is cheap, it is
   the only part of the reply that moves, and until it is explained nobody can use the reply's bytes as a stable
   identity (the rule the cab-slot region already taught: never build on a volatile region).
2. **The bit-level shape.** 220 of 576 bytes are single-bit values, which is what a bit-packed structure looks
   like — NOT a table of ids. The next test is a decode attempt against a truth source already in the tree: the
   per-family parameter tables (`blockParams.ts`, per-family param counts) and the editor layouts
   (`ForgeFX/server/src/devices.ts`). A bitmap hypothesis predicts one bit per parameter, so a family's bit-run
   length should equal its param count — falsifiable offline.
3. **`0x03` / `0x1b` per-eid sweep against a known state.** These ARE address-dependent, so sweep byte 8 over eids
   whose state the preset already tells us — the amp at `0x3a`, the twelve placed blocks the `fn=0x13` status
   dump lists (`2a 2b 2e 3a 3e 42 46 4e 52 5a 5e 76`), and an eid for a block that is NOT placed — then bypass one
   block through the route this stack already has, re-read, and restore. Predictions first, as always.
