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

## 1d. What the payload is NOT — and the strongest remaining hypothesis

Exhaustive offline tests on the real export's 2 040 sample words (`/tmp/real-ir.syx`):

| test | result |
|---|---|
| lag-1 autocorrelation (a real IR must be smooth) | 0.02 for int32, 0.01 int16-pairs, −0.01 float32, ≤0.04 for every 7-bit bitstream width 8/12/16/20/24 |
| early-energy share (first 15 % of taps) | 9–16 % everywhere — no envelope |
| high byte of each 32-bit word | **256 distinct values, entropy 7.91 of 8** — uniform |
| complex-pair magnitude spectrum (1 020 re/im pairs) | magnitudes flat 0.06–1.37, correlation with index ≈ 0 |
| deflate / raw-deflate / lzma / bzip2 on the 8 960-byte 7-bit bitstream | all fail |
| public spec | none — Fractal's IR transport is explicitly *proprietary SysEx*, with "Standard" and "UltraRes" subformats |

So the payload is compressed or otherwise transformed, and one specimen cannot give the transform.

**Hypothesis worth one more export:** this slot is an **UltraRes** IR — the file's 32nd name slot carries `0xA0`
where ours carries `0x20`, i.e. a flag bit, and UltraRes is the subformat known to store more than 2 040
plain taps. If so, a **Standard** IR export should decode as plain samples under one of the encodings
above and our writer may already be correct for that subformat. That is a cheap, decisive check: export
the same cab as `Standard` and compare entropy — a plain standard payload must show far lower entropy and
a visible decay envelope.

## 1e. The vendor pack settles it: the payload is an opaque compressed blob

The owner supplied everything shipped with the cab (a working commercial IR):

| file | size | what it is |
|---|---|---|
| `LT_TV_Mix_7.syx` | 10 345 B | vendor SysEx, model byte **0x10** (Axe-Fx II generation — not the FM3's `0x11`) |
| `LT_TV_Mix_7.ir` | 33 460 B | Cab-Lab `.ir`: 176-byte header (name + `Copyright 2014 Fractal Audio Systems, LLC`), **32 768 bytes of payload**, then 516 bytes of zero padding |
| `LT_TV_Mix_7.wav` ×2 | 145 KB / 1.58 MB | demo renders (0.49 s stereo, 10.9 s mono, 48 kHz/24-bit) — audio, not the IR |

The `.ir` payload is **7.99 bits/byte entropy, 0.4 % zeros, byte autocorrelation −0.004** — i.e. maximal
entropy. Raw audio of any layout (float32, int16, int24, either endianness) cannot look like that: a
float32 cab IR has its sign/exponent bytes clustered, giving 3–4 bits/byte. So both the `.ir` master and
the `.syx` payload are **compressed or encrypted**, and none of zlib / raw-deflate / lzma / lzma-alone /
bzip2 decodes them at any byte offset 0–7.

The FM3 export's 2 040-word payload is a different byte stream from the vendor file's (the vendor file is
gen-2), so the two cannot be cross-fitted either.

The `.ir` header also carries `0x2000` = 8 192 at offset 0x40, matching 32 768 payload bytes / 4 — so the
master is 8 192 32-bit words, and **every bit of it is statistically random** (ones-density 0.499, uniform
across all 32 KiB, so not bit-plane packed either).

**Verdict: the vendor's own files cannot be produced by this stack.** The IR payload is a proprietary packed
format with no public specification; it is not a `wav` conversion, not a bit-packed PCM variant, and not
any standard container. Axis therefore cannot produce a playable IR, and says so in the UI.

## 1f. RESOLVED — the codec is plain float32, and the format bit was the bug

The owner ran a controlled experiment: a ruler WAV (impulses of +1.0/−0.5/+0.25/−0.125/+0.0625/−1.0/+0.5/−0.25/
+0.125 at samples 0/64/128/256/384/512/768/1024/1536, a 1 kHz 3-cycle burst at 1800–1943, and +0.75 at 2000,
exact zeros elsewhere) imported through FM3-Edit and exported in four variants.

| export | result |
|---|---|
| slot 13 (UltraRes) vs slot 14 (same input) | **0 differing bytes** — the encoder is deterministic; no per-file IV |
| slot 15 (Standard) | 92.7 % zeros, entropy 0.74 → **2040 little-endian IEEE-754 float32 samples**, every impulse back at its exact position and sign, uniformly scaled by 0.363457 (the editor's import normalisation) |
| slot 16 (one sample changed, 0.75 → 0.70) | 13 % of bytes differ, not an avalanche — the UltraRes path transforms; nothing like a block cipher |
| UltraRes payload | still 7.98 bits/byte on a 90 %-silent input → opaque, **not writable** |

So `float32` was right all along. What broke every earlier container was **the format bit in the 32nd name
slot**: a Standard IR carries `0x80` (NUL + flag), an UltraRes IR carries `0xA0` (space + flag). Ours wrote
`0xA0` while carrying raw samples, i.e. it declared UltraRes and shipped Standard data — the unit accepted
the bytes (the close check only XORs content) and played nothing.

**Verification, both directions:**
- rebuilding a container from export 15's own words with `buildCabIrContainerFromWords` reproduces that file
  **byte-for-byte**, except the `0x7A` destination field (the export writes the `7F 7F` sentinel);
- a container built here from the ruler WAV (`user 17`, name `LYKOS OURS`) uploaded with `closeCode 0x00`
  and all 8 data acks, then **auditioned on the unit: it plays**, slightly louder than the editor's own
  copy because the editor normalises on import and we do not.

Code: `forgefx-midi` `9d38724` (builder emits the NUL terminator, encoding marked measured, status text
rewritten, parser trims the terminator). Slots 13–22 were cleared afterwards.

## 1g. UltraRes writing — reverse-engineering status (open)

Goal: produce the UltraRes payload ourselves so Axis can write UltraRes, not just Standard.

**Oracle facts already in hand** (from the same ruler experiment):
- deterministic (two exports of one input: 0 differing bytes), so the encoder is a pure function;
- fixed size: 2040 words, always 8 160 bytes, even for a 90 %-silent input → no compression gain;
- entropy 7.98 bits/byte, 256 distinct byte values, no 1 KiB block deviates;
- a one-sample input change moves **13 % of bytes**, in runs at byte offsets 0, 256, 512, 1024, 1536 and a
  562-byte run in the middle — diffusion without avalanche, i.e. a transform, not a block cipher;
- UltraRes payload vs the Standard float32 payload of the same input: not a byte permutation and not a
  fixed XOR mask (multisets differ; XOR is 99.7 % non-zero and full-range).

**Static analysis done** (Ghidra 12.2 headless, JDK 25, both installed under `~/re/ghidra-tools`, project
`~/re/ghidra-tools/proj/FM3` with `FM3-Edit.exe` imported, full auto-analysis, 244 s):
- the editor is a 19.3 MB native x64 Qt build, no symbols, no PDB — RTTI is present but names are stripped;
- geometry-constant scan over 1 388 203 instructions: 195 functions touch 2040/8160/8192/2048;
  `FUN_140222c60` (2040 ×8) sits in a worker-thread dispatcher, `FUN_140321670` uses 1020/1024/8192 with a
  892-double stack array — the shape of an FFT/transform stage, which matches the measured diffusion;
- `"UltraRes: "` has one code reference (`FUN_14018e790`); the `cabir_import` / `TERROR_UNCOMPRESSION_FAILED`
  strings are QString literals with no resolved xref, so they need QString-constructor tracing, not string xrefs.

**What is left:** identify the packing of the transform output (how 2040 numbers become 8160 uniform bytes),
then reimplement. That is the hard half and it is not done — do not claim UltraRes support until a container
built here is auditioned on the unit, exactly as Standard was.

**Recommendation:** ship Standard writing + verbatim UltraRes passthrough (import an UltraRes `.syx` and
re-upload it unchanged), and keep UltraRes *writing* as a separate, honest follow-up.
