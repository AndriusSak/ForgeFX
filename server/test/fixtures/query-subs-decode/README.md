# `query-subs-decode` — ROUND 12 + ROUND 13: what the three `fn=0x01` sub-actions turned out to be

**Provenance:** every tap here was written by a READ-ONLY probe against the owner's FM3 (fw 13.0, model byte
`0x11`) on **2026-10-12**, preset `"USA Mk IV"` in the edit buffer, except the three `03-bypass-arm-*.tap`
which contain ONE self-restoring bypass write each (named per file below). The preset name was read before
and after each run; it did not move. `2e-volatility-spacing.tap` and `2e-volatility-64sample.tap` are
produced by `scripts/probe-map-volatility.ts`; the rest by `scripts/probe-subs-per-eid.ts`. Taps are read
with `scripts/inspect-tap.ts` / `inspect-map-volatility.ts`, never by eye.

This directory is the ROUND 12 counterpart to `../query-subs/` (ROUND 11, which established *that* the
three subs answer at all). Nothing here is a MEANING unless a row says it is a measurement.

---

## 1. `sub 0x2e` — the three volatile bytes are per-READ, and it is not a counter

`2e-volatility-spacing.tap` — two connections, 8 reads each. CONN 1 at a constant 500 ms spacing, CONN 2 at
250/500/1000/2000/4000/8000 ms. The two connections predict **different** numbers under the two surviving
hypotheses, which is the only reason the run is worth anything:

| hypothesis | CONN 1 predicts | CONN 2 predicts | measured |
|---|---|---|---|
| H1 free-running counter | constant Δ column | Δ ∝ spacing | **no** — the 8000 ms step moved no further than the 250 ms one |
| H2 per-read nonce / pseudorandom | no constant Δ | no relation to spacing | **yes** — 16/16 trios distinct, Δ tracks neither |

`2e-volatility-64sample.tap` — 64 reads of the long reply, 64+64 of the short one, one connection.

- **`+22` never left `0..3` in 64 samples** (`0×14 1×14 2×22 3×14`). A uniform random byte would have had
  probability `(4/256)^64` of that: the trio is not three independent random bytes.
- `+23` spans `0x00..0x78` (40 distinct of 64, repeats common, mostly even), `+24` spans `0x02..0x7e`
  (44 distinct, dense). All three stay inside SysEx's 7-bit range, as every byte of the region does.
- **The SHORT `0x2e` reply (request byte 7 = `0x01`) is fully REPRODUCIBLE: 1/64 distinct for a zero
  address and 1/64 for address `01 3a`** — it is not a nonce, and the "byte flipped 00→01 between runs"
  noted in ROUND 11 was the address change, not volatility. Its data is the address echo plus zeros.

**Verdict:** the trio is per-read and its source is NOT one of time, frame count, session, or the request.
`+22`'s boundedness is unexplained. All three bytes stay non-identity — mask `+22..+24` and every other byte
of the reply is byte-identical across all 80 reads taken here.

## 2. `sub 0x2e` — the 576-byte region is periodic at **8 bytes**, and it is not a uniform encoding

Measured by `scripts/decode-layout-map-matrix.ts` on `2e-volatility-64sample.tap`:

- **Period 8.** Autocorrelation over all lags 1..128: the top lags by exact-byte agreement are 8 (54.4% vs a
  27.4% field), then 40, 72, 32, 16, 112 — **every one a multiple of 8**.
- Single-bit runs: lengths `1→32, 2→6, 3→2, 4→2, 5→2, 6→2, 7→20`, longest **7**. The 20 runs of exactly 7 are
  full occurrences of the ladder `40 20 10 08 04 02 01`.
- 241 zero bytes, 220 single-bit bytes, 115 multi-bit bytes.

**Two hypotheses KILLED — kept because a killed hypothesis is a result:**

1. **"A family's bit-run length equals its param count"** (the prediction this round was asked to test):
   REFUTED. No run exceeds 7, and the smallest family has far more than 7 params.
2. **"The region is a column-major one-bit-per-byte bit matrix"**: REFUTED. Every `(start, width)` pair in
   `start 0..72 × width 4..10` was enumerated; **no alignment is violation-free** (best: `start 70, width 4`
   still leaves 92 bytes with more than one bit set). Only ~20 of the 8-byte columns are fully one-hot.

So the region is *periodic at 8* and *contains ~20 one-hot ladders*, but a single uniform encoding does not
cover it. That is where this stops: **no byte of the region is decoded.**

## 3. `sub 0x03` / `0x1b` per eid — `0x03` is a per-eid read with a volatile component

`03-1b-per-eid-sweep.tap` (READ-ONLY). Placed eids from the fn=0x13 status dump:
`0x25 0x2a 0x2b 0x2e 0x3a 0x3e 0x42 0x46 0x4e 0x52 0x5a 0x5e 0x76`; plus `0x36`/`0x32` as UNPLACED.
The negative control `sub 0x99` stayed SILENT, so "no answer" on this device means "no answer", not "lost".

- **`0x03[sel=01]`** answers 14 data bytes: `01 <eid> 00 00 00 <b5> <b6> <b7> 00 …`, i.e. bytes 0-1 echo the
  request, 2-4 are zero, **5-7 carry per-eid content**, 8-13 are zero. With `sel=00` the same reply is all
  zeros. Content differs per eid (`0x2a → 28 03`, `0x3a → 6f 0e 01`, `0x46 → 39 4d`, `0x5e → 06 3a 57`).
- **`0x1b[sel=00]`** answers stable per-eid content at the same offsets (`0x2a/0x2b → 7f 7f 01`,
  `0x3a/0x3e → 00 00 00`, `0x46 → 47 42 00`, `0x4e → 0c 00 00`, …). **`0x1b[sel=01]` is all zeros for every
  eid.** `0x1b` did not move on any read or write here.

### The bypass arm — and the false positive it nearly published

`03-bypass-arm-superseded.tap` is the FIRST version of the arm, kept as evidence of a trap. It read
`0x03[01]` before/during/after a bypass toggle and saw `6f → 70 → 71`; the obvious reading — "0x03 carries
this block's live state" — is **wrong**, because an unrelated eid (`0x5e`) also moved with no write anywhere
near it. A before/during/after comparison with **no no-write baseline** cannot attribute anything.

The arm was rebuilt with (a) a drift control that reads each eid 3× with **nothing written** immediately
before, and (b) `--reads 5` per stage so a stage that is stable within itself is a usable baseline.
`03-bypass-arm-amp.tap` and `03-bypass-arm-0x5e.tap` are that design (one self-restoring `setBypass` write
each, restore proven through the fn=0x13 status dump — a different path than the one that read the original).

| eid | stage | within-stage | across stages | reading |
|---|---|---|---|---|
| `0x3a` (amp) | 5 reads × 3 stages | **STABLE 1/5** each | `…73 0e 01` → `74 0e 01` → `75 0e 01` | byte 5 advances by **exactly +1 per WRITE** to that block, and does not move on reads |
| `0x5e` | 5 reads × 3 stages | **DRIFTS 5/5** | byte 5 advances **+6 per READ** (64,6a,70,76,7c …); byte 6 steps at a write | the field moves **on reads alone** — no write is needed |
| drift control (no write) | `0x3a`, `0x25`, `0x2a` | stable | — | those eids are stable without a write; `0x5e` is not |

**Verdicts, honestly split**

- **H1 (pure request echo) REFUTED** for `0x03`: identical requests give per-eid and time-varying data.
- **H2 (carries the block's bypass state) NOT ESTABLISHED.** The amp's value moves at a write, but a write is
  not the only thing that moves this field (see `0x5e`), and this design cannot separate a bypass-induced step
  from the read-driven drift. **Nothing about the bypass flag is published.**
- **What IS established:** `0x03[sel=01]` is a genuine per-eid read whose bytes 5-7 are **not usable as stable
  identity** — at least one placed block's field advances on reads alone.
- **`0x1b` is the stable one**: per-eid, reproducible, unmoved by reads and writes. It is the better candidate
  for a next round, and its `sel=00`/`sel=01` split (data vs all-zero) is a clean selector.

## Files

| file | produced by | what it holds |
|---|---|---|
| `2e-volatility-spacing.tap` | `probe-map-volatility.ts` | 2 connections × 8 reads, constant vs geometric spacing |
| `2e-volatility-64sample.tap` | `probe-map-volatility.ts --sample 64` | 64 long + 128 short replies, one connection |
| `03-1b-per-eid-sweep.tap` | `probe-subs-per-eid.ts` (read-only) | sub 0x03/0x1b × sel {00,01} × 15 eids |
| `03-bypass-arm-superseded.tap` | `probe-subs-per-eid.ts --write` | the arm WITHOUT the drift control — kept for the trap |
| `03-bypass-arm-amp.tap` | `probe-subs-per-eid.ts --write --eid 0x3a --reads 5` | drift control + 5 reads/stage on the amp |
| `03-bypass-arm-0x5e.tap` | `probe-subs-per-eid.ts --write --eid 0x5e --reads 5` | the same on 0x5e, where the field drifts on reads |

---

# ROUND 13 (2026-10-12) — `0x1b` is an ADDRESSED read, not a per-block flag query

**Provenance:** `ForgeFX/server/scripts/probe-1b-structure.ts`, READ-ONLY, same unit / fw / preset as ROUND 12. Taps:
`1b-eid-sweep.tap` (eid `0x20..0x7f` with a zeroed address tail), `1b-address-selectors.tap` (eid `0x46`, each of
address bytes 9/10/11 swept `0..15`), `1b-at3-sweep-delay.tap` and `1b-at3-sweep-amp.tap` (byte 10 swept
`0x00..0x3f` on eid `0x46` and eid `0x3a`). The two byte-10 sweeps were **re-run and reproduced their maps
exactly** (23 distinct values for the delay, 37 for the amp) — table and provenance, not a one-off.

**The reply shape, now measured rather than assumed.** 14 data bytes:
`<at0> <at1> <at2> <at3> <at4> <b5> <b6> <b7> 00 00 00 00 00 00` — **data 0-4 echo the whole five-byte address
region**, the content is the three bytes at data 5-7 (21 bits), data 8-13 are zero. (ROUND 12 described the tail
as "zero"; the head is an echo, which is what makes the selector test possible at all.)

**With the address tail zeroed, the content is per-eid — and structured:**

| family | eid(s) | b5 b6 b7 | set bits |
|---|---|---|---|
| OUTPUT, GEQ, PEQ, ENHANCER | `0x2a/0x2b`, `0x32/0x33`, `0x36/0x37`, `0x7a/0x7b` | `7f 7f 01` | 15 |
| VOLUME, MIXER | `0x66/0x67`, `0x7e/0x7f` | `7e 7f 03` | 15 |
| INPUT | `0x25/0x26` | `66 4c 01` | 8 |
| ROTARY | `0x56/0x57` | `65 4c 02` | 8 |
| DELAY | `0x46`, `0x47` | `47 42 00`, `66 4c 00` | 6, 7 |
| COMP | `0x2e/0x2f` | `00 00 01` | 1 |
| AMP, CAB, FILTER, TREMOLO, FORMANT, MULTITAP | `0x3a`, `0x3e`, `0x72..0x75`, `0x6a/0x6b`, `0x62/0x63`, `0x4a` | `00 00 00` | 0 |
| REVERB, CHORUS, FLANGER, PHASER, WAH, DRIVE | `0x42`→`02`, `0x4e`→`0c`, `0x52/0x53`→`03`, `0x5a`→`05`, `0x5e..0x61`→`01`, `0x76`→`0e` | (b5 only) | 1-3 |
| beyond-limit instances (and unused eids) | most remaining | `01 00 00` | 1 |

**Three hypotheses KILLED — each by the sweep itself, not by argument:**

1. **H_A "one family ⇒ one value"** REFUTED: DELAY has `47 42 00` and `66 4c 00`, CHORUS `0c` and `03`,
   AMP `00` and `01`, and the value `01 00 00` spans 51 eids of many families.
2. **H_C "placed/unplaced sentinel"** REFUTED: `0x32`/`0x33` (GEQ) are UNPLACED yet carry `7f 7f 01`, while the
   PLACED amp `0x3a` and cab `0x3e` carry `00 00 00`. Placement does not order this field.
3. **H_D "sized by the family's parameter count"** REFUTED: the amp has 143 parameters and reads 0 bits; OUTPUT
   has 26 and reads 15. No ordering, and 15 is a cap the repo's families all exceed.

**The big new fact: address bytes 9, 10 and 11 are SELECTORS, and byte 10 walks a table.** On eid `0x46`:

- **byte 9 (at[2]) ≠ 0 → the fixed value `01 00 00`**, for every value `1..15` tested. A mode selector, like
  `0x2e`'s byte 7.
- **byte 11 (at[4]) ≠ 0 → the fixed value `1b 14 4c`**, likewise for `1..15`.
- **byte 10 (at[3]) walks a value table.** `0x46` → **23 distinct values** over `0x00..0x3f`, including two
  (`4b 19 03` at `0x01`, `7c 0f 00` at `0x08`) that **never appear in the 96-eid sweep** — so the content space
  is larger than the eid dimension alone exposes. `0x3a` → **37 distinct values** over the same range.
- **The byte-10 table is JOINT with the eid, not global**: the two maps differ (`0x46` at `at[3]=0x00` →
  `47 42 00`, `0x3a` at `at[3]=0x00` → `00 00 00`; the value sets and index sets do not correspond). This
  refutes "at[3] indexes a shared family table".

**What this means, stated no more strongly than the data supports.** `0x1b` answers a **function of
(at1, at2, at3, at4)** with two of those bytes acting as mode selectors and one walking a table. Upstream's name
for it, PARAM FLAGS, is **not supported by anything measured here** and now looks wrong: a "flags" reply would
not depend on three address bytes this way. What the 21 bits MEAN is still open.

### Files added in ROUND 13

| file | produced by | what it holds |
|---|---|---|
| `1b-eid-sweep.tap` | `probe-1b-structure.ts` | sub 0x1b over eid 0x20..0x7f, address tail zeroed |
| `1b-address-selectors.tap` | `probe-1b-structure.ts --index-sweep 0x46` | eid 0x46, address bytes 9/10/11 each swept 0..15 |
| `1b-at3-sweep-delay.tap` | `probe-1b-structure.ts --index-sweep 0x46 --pos 3 --to 0x3f` | byte 10 over 0x00..0x3f on the delay (23 distinct) |
| `1b-at3-sweep-amp.tap` | `probe-1b-structure.ts --index-sweep 0x3a --pos 3 --to 0x3f` | the same on the amp (37 distinct) |

## What is explicitly NOT decoded

- The meaning of `0x2e`'s 576-byte region, of its ~20 one-hot ladders, or of the `+22..+24` trio.
- What `0x03`'s bytes 5-7 count, and why one block's advances on reads while another's waits for a write.
- What `0x1b`'s 21 bits mean — now known to be an addressed read of a table, with at[2] and at[4] as selectors
  and at[3] an index into a table that is joint with the eid.
- Whether any of these carry the bypass state — that question is **open**, not answered in either direction.
