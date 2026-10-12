# `query-subs-decode` — ROUND 12: what the three `fn=0x01` sub-actions turned out to be

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

## What is explicitly NOT decoded

- The meaning of `0x2e`'s 576-byte region, of its ~20 one-hot ladders, or of the `+22..+24` trio.
- What `0x03`'s bytes 5-7 count, and why one block's advances on reads while another's waits for a write.
- What `0x1b`'s three per-eid bytes flag.
- Whether any of these carry the bypass state — that question is **open**, not answered in either direction.
