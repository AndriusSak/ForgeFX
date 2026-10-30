# Hardware round 2026-10-30 — five captures on a live FM3 (fw 13)

Owner-authorised session: FM3 on `/dev/ttyACM0` (`2466:8011`), server on `:5056`, preset 408 "80s test"
(body sha `02433d4460b207b5`, 13 562 B). IR writes restricted to **unoccupied slots above 15**.

## 1. IR sample encoding — instrument built, verdict pends an ear

`cabIrConvert` encodes each sample slot as little-endian IEEE-754 float32. That is **assumption A1**: an
impulse decodes identically as float32 and as int32 Q31, so the audition that proved the transport could
never discriminate the encoding.

`scripts/probe-ir-encoding.ts` (WRITE) encodes ONE wav two ways — float32 and Q31 — and uploads each to
its own slot. Both containers were accepted:

| slot | name | close | unit said | slot state |
|------|------|-------|-----------|------------|
| 17 | `LYKOS F32` | `0d 46 46 29 04` | `closeCode 0x00`, 8/8 data acks | **populated**, name read back |
| 18 | `LYKOS Q31` | `0f 72 41 6e 06` | `closeCode 0x00`, 8/8 data acks | **populated**, name read back |

Both are populated and named, so the unit's close check — which validates content, not meaning — passes
either way. **The only oracle that separates them is listening**: whichever slot sounds like a guitar
cabinet is the unit's encoding. Until that is heard, A1 stays an assumption.

## 2. Slot-to-slot copy — content-exact apart from one volatile 2-byte field

`POST /preset/store {number:500}` from the 408 buffer, then `POST /preset/select 500` and a body read:

- length identical (13 562 B), **2 bytes differ**, at offsets **8860–8861** (`ea ac` vs `3b ba`);
- re-storing the same buffer to the same slot changed that field to `ea ac` — so it tracks **device
  state, not slot content** (a heap pointer / last-loaded cookie);
- everything else is byte-identical, i.e. a slot-to-slot store is content-exact.

Cleanup was done the boring way (select empty 501 → store 500 → select 408); slot 500 is `<EMPTY>`
again and the 408 body is back to `02433d44…`.

## 3. Grid cell placement through the app's own endpoint

`PUT /preset/grid/cell {row,col,blockId}`:

- `{4,1,79}` placed **Chorus 2** and the grid went 10 → 11 blocks;
- `{4,1,0}` cleared it and the grid returned to 10;
- the **body was byte-identical after the round trip** (`02433d44…`), so a place/clear leaves no residue.

**Index base**: the grid response is **0-based on both axes** while the cell API is 1-based — `{4,1}`
landed at response `(3,0)`. Both directions are consistent, so a round trip is safe, but any code mixing
the two coordinate systems is off by one on row *and* column.

## 4. Tuner

`POST /tuner {on:true}` → the event stream carries `{"type":"tuner",freq,note,cents,octave}` at **89
events in ~6 s** (≈15/s), and `{on:false}` stops it. The page-open sequence is therefore correct on this
firmware; the readings themselves depended on what the input heard (`25.29 Hz G# −45 ¢` — noise, not a
string).

## 5. Two gaps found on the way

- `POST /preset/restore` answered **501** (route exists, handler reports unsupported) — a restore path
  that is documented but not wired on this build.
- `GET /cab/slots?page=16&from=0&to=127` sweeps a full 128-slot user bank in **2.1 s** (117 free, 11
  occupied in bank 0x10), so slot inventory needs no special tool.
