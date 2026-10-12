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

**The 590-byte table, described but NOT decoded.** Two replies taken seconds apart differ only in the echoed
address byte, THREE data bytes (`+34`–`+36`) and the checksum — so the bulk is stable. Its interior is dominated by
the 8-byte pattern `40 20 10 08 04 02 01 00` repeated ~20–24 times, interleaved with all-zero regions and a handful
of varying 8-byte groups (e.g. `43 36 19 2c 16 71 00 40`, `72 74 34 1b 24 04 33 05`). One byte of the SHORT
`0x2e` reply varied between runs (`00` → `01` at `+12`), so that reply is not fully static either.

**Nothing above is a MEANING.** "590 bytes, table-shaped, stable, address-selectable" describes the frames. No byte
of any of the three replies has been decoded, and the varying bytes are exactly why a decode must be built on a
comparison against a KNOWN state rather than on one capture.

**Next steps this fixture enables, with no new capture:**

1. Sweep byte 8 of the address over eids whose state is known from the preset — the amp at `0x3a`, the twelve
   placed blocks the `fn=0x13` status dump lists (`2a 2b 2e 3a 3e 42 46 4e 52 5a 5e 76`), and an eid for a block
   that is NOT placed — and see which reply bytes track that state. `0x03` is the editor's most-used poll, so a
   per-eid state read is the natural reading; it is falsifiable by bypassing a block through the route this stack
   already has, re-reading, and restoring. **Predictions first, as always.**
2. Decode the 590-byte table against a truth source already in the tree: the block/eid structure and the editor's
   own layout (`ForgeFX/server/src/devices.ts`). Start from the ~20 repeating 8-byte groups versus the twelve
   placed eids.
