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

## 1b. The encoding experiment's RESULT: both candidates are silent

Auditioned in the Cab block against a control (user 1, "LT TV Mix 7", which plays normally):

| slot | content | audition |
|------|---------|----------|
| 17 | decaying burst, float32 | **silence** |
| 18 | same burst, int32 Q31 | **silence** |
| 19 | impulse (1.0 at sample 0), float32 | **silence** |
| 20 | same impulse, Q31 | **silence** |
| 21 | comb (full-scale taps 0/220/440…), float32 | **silence** |
| 22 | same comb, Q31 | **silence** |

Every container was accepted (`closeCode 0x00`, 8/8 data acks, slot POPULATED, name read back). So
acceptance proves arrival only — as documented — and the behavioural fact is stronger than "A1 is
unproven": **plain samples at word 8 are not what the unit plays**, under either float32 or Q31. A comb
IR at full scale cannot be inaudible if its words were read as samples; it is.

What this rules out: the sample region is a bare run of 2040 floats (or 2040 Q31 ints) starting
immediately after the 32-char name. What it does NOT tell us: what the region actually is — header,
tap length, format flags, or a different packing. Only a real container settles it.

## 1c. A real export settles the shape — and shows the payload is COMPRESSED

The owner exported a working user cab from FM3-Edit: `U1.001_LT_TV_Mix_7.syx`, 10 345 bytes — the same
size as every container this stack builds. Field by field:

- model `0x11`, 10 frames, 8 data frames of 1 290 bytes, payload 10 240 bytes = 2 048 five-septet chunks;
- **words 0..7 decode to exactly the 32-character name** `LT TV Mix 7` (the one difference from ours:
  the 32nd slot carries `0xA0` here, `0x20` when we write it — the flag bit documented as unverified);
- start payload `7F 7F 00 10` = the "no explicit destination" sentinel.

So the container geometry, the name packing and the frame structure we build are **right**. The sample
region is where we diverge — and it is **not raw samples**:

| decoding of the 2 040 words | result |
|---|---|
| IEEE-754 float32 | wildly out of range (10³³–10³⁸), RMS flat across deciles |
| int32 / 2³¹ | RMS ≈ 0.57 flat across all ten deciles — no envelope |
| int16 pairs (LE) | RMS ≈ 0.57 flat |
| 7-bit bitstream → 16-bit | RMS ≈ 0.57 flat, 4 480 samples |
| 7-bit bitstream → 24-bit | RMS ≈ 0.57 flat, 2 986 samples |

And the byte statistics say the same thing: **entropy 6.83 of a possible 7 bits/byte**, 1.9 % zero bytes,
and **no silent tail** — a real 2 040-tap IR decays into zeros, a compressed stream does not. So the
payload is compressed or otherwise transformed, and none of the candidate raw encodings can be right.

**Consequence:** `convertWavToCabIr` writes a structurally valid container whose audio the unit cannot
play — every arm was accepted and every arm was silent. Writing IRs needs the payload codec, which one
specimen cannot give. The next useful artefact is a **matched pair**: the same cab exported as `.wav`
and `.syx`, so the known audio can be fitted against the compressed bytes.
