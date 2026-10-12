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

> **"+6 per READ" IS REFUTED — see the ROUND 14 §6 cadence test.** The step is not per read: it is a
> **free-running counter at ≈93.8 units/s, mod 128**, sampled when the reply is built. At the arm's fixed
> 64 ms cadence that is *exactly* 6.0 units, which is why a hand-read of the arm looked per-read — the
> description does not survive its own drift control, which read at 128 ms and moved +12 per read. Measured
> against idle windows with **zero frames on the bus**: 20 s → +85, 30 s → +1, both matching the clock
> within 1 unit where the counter predicts +6; 19 reads across 351 ms → +33 where the counter predicts +114.

**Verdicts, honestly split**

- **H1 (pure request echo) REFUTED** for `0x03`: identical requests give per-eid and time-varying data.
- **H2 (carries the block's bypass state) NOT ESTABLISHED.** The amp's value moves at a write, but a write is
  not the only thing that moves this field (see `0x5e`), and this design cannot separate a bypass-induced step
  from the read-driven drift. **Nothing about the bypass flag is published.**
- **What IS established:** `0x03[sel=01]` is a genuine per-eid read whose bytes 5-7 are **not usable as stable
  identity** — and ROUND 14 §6 shows *why* for byte 5 on `0x5e`: it is a free-running counter, so it moves
  whether or not you read it.
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
*(CORRECTED IN ROUND 14: "content is three bytes and data 8-13 are zero" holds **only for the zeroed address
tail**. Every selector reply carries content out to data 9 — `1b 14 4c 7a 0a` sits at data 5-9. The tool used
here printed `data[0..7]` in its selector mode, so bytes 8-13 were never in front of a reader.)*

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

- **byte 9 (at[2]) ≠ 0 → the fixed value `01 00 00`** *(CORRECTED IN ROUND 14 — the value it returns is the
  DEFAULT/hole record, and that record is not fixed: it read `01 00 00 00 00 02` at 13:57 and
  `1b 14 4c 7a 0a 02` at 14:26 with a byte-identical request sequence. See the ROUND 14 section.)*, for every
  value `1..15` tested. A mode selector, like `0x2e`'s byte 7.
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

---

# ROUND 14 (2026-10-12) — the two "fixed records" are not fixed, and `0x2e` reads the same table

**Provenance:** `ForgeFX/server/scripts/probe-1b-fixed-records.ts`, READ-ONLY, same unit / fw 13.0 / preset
`"USA Mk IV"` in the edit buffer (read with `fn=0x0d` before the sweep) / same 13 placed eids as ROUND 12–13.
Taps: `1b-fixed-records.tap` (this round's run) and `1b-address-selectors-rerun.tap` (the ROUND 13 tool
`probe-1b-structure.ts --index-sweep 0x46` re-run, which is the evidence for the correction below). Full console
log: `review-2026-10-12/probe-1b-fixed-records.out`. Predictions (H_MODE / H_ADDR / H_MIXED) were committed in
the tool header before the first frame was sent.

## 1. The reply's content is NINE bytes, not three

`1b` answers 14 data bytes. With the address tail zeroed the content really is data 5-7 and data 8-13 are zero.
**With either selector non-zero the content runs to data 9**: both selector replies carry `1b 14 4c 7a 0a` at
data 5-9. ROUND 13's selector mode printed `data[0..7]` only, so bytes 8-13 were never shown — the same
"SIZE A TOOL'S PRINT WINDOW FOR THE NEXT STRUCTURE" trap the HOLD array cost in ROUND 10.

| address (at0..at4) | content, data 5..13 |
|---|---|
| `00 46 00 00 00` (tail zeroed) | `47 42 00 00 00 00 00 00 00` |
| `00 46 01 00 00` (byte 9 = 1) | `1b 14 4c 7a 0a 02 00 00 00` |
| `00 46 00 00 01` (byte 11 = 1) | `1b 14 4c 7a 0a 00 00 00 00` |

## 2. `byte 9 ≠ 0` is NOT `01 00 00` — the value it returns MOVED between two runs of the same tool

This is the round's headline and it is a correction, not an addition. At 13:57 the ROUND 13 tool recorded
`01 00 00 00 00 02 00 00 00` for byte 9 ≠ 0 on eid `0x46`; at 14:26 the **same tool, with a byte-identical TX
sequence** (verified programmatically, all 149 TX frames equal) recorded `1b 14 4c 7a 0a 02 00 00 00`, and the
new tool reproduced that at 14:50. Same preset name, same 13 placed eids.

The mechanism is visible once the whole sweep is compared: the only value that changed anywhere in the 146
exchanges is the one record — and **64 exchanges carry it**:

- the 49 **unused/unplaced eids** whose zeroed-tail record is `01 00 00 00 00 02` (at 13:57) → the same
  record, now `1b 14 4c 7a 0a 02` (at 14:26). Every other eid's record is byte-identical across the two runs.
- the 15 `byte 9 ≠ 0` rows on eid `0x46`, which return **exactly that same record**.

So `byte 9 ≠ 0` does not produce a distinct mode record: it lands on the **DEFAULT / hole record** — the value
the device gives for an address that holds nothing. ROUND 13 read "byte 9 ≠ 0 → `01 00 00`" as a device
constant; it is a *time-stamped reading of the hole record*, and the hole record is what moved.

**REVISED in §9 — this was not purely "uncommanded".** The record is **scene-dependent**, and the
13:18–13:57 value `01 00 00 00 00 02` is exactly the scene-1 value of the map measured in §9, so a scene change
between 13:57 and 14:20 accounts for that half of the move. It is not a fast clock (byte-identical at 14:20,
14:26, 14:50), the preset name and placed-eid set did not change, nothing was written by any ROUND 12–14 probe
at that time, and `journalctl -k` shows **no USB connect/disconnect since 10:43:41** — the unit stayed
enumerated, so it is not a re-enumeration or power-cycle artefact.

**What remains unexplained is the OTHER value**: `1b 14 4c 7a 0a 02`, read from 14:20 to ≈15:2x, whose first
byte `0x1b` is not a legal scene index. So the field has at least two regimes and §9's map holds in the current
one. **Report the scene index alongside this record** — a standing read of (hole record, `fn=0x0d` preset,
`fn=0x13` placed set, scene index) at the head of every probe costs four frames and would date the next regime
change instead of costing a round.

`byte 11 ≠ 0` DID reproduce byte-for-byte across both runs: `1b 14 4c 7a 0a 00 00 00 00`.

## 3. Neither selector returns a device-level constant (task 1(a) answered: REFUTED)

With the selector fixed at 1 and `at[1]` (the "eid" byte) swept `0x00..0x3f`:

| selector | distinct contents over the sweep |
|---|---|
| byte 9 = 1 | **8** (`1b 14 4c` ×45, `00 00 00` ×8, `7e 7f 03` ×4, `18 33 02` ×2, `06 00 00` ×2, `01 00 00` ×1, `29 55 02` ×1, `2a 61 00` ×1) |
| byte 11 = 1 | **4** (`1b 14 4c` ×60, `00 00 00` ×2, `01 60 03` ×1, `01 00 00` ×1) |

So H_MODE(a) — "a selector that ignores its own value is a device-level MODE" — is **REFUTED**: the content
still moves with the byte the reply echoes at data 1. A selector whose *own* value is ignored is a mode; it does
not follow that the record is independent of the rest of the address.

## 4. `0x2e` DOES expose the same record (task 1(b) answered: SUPPORTED)

`0x2e` with request byte 7 ∈ `0x01..0x0f` answers a 23-byte reply whose data 5-9 are `1b 14 4c 7a 0a` with
trailer `00` — **byte-identical, on eid `0x46` in the same session, to `0x1b[at4 ≠ 0]`**. All fifteen selector
values give the same content, so `0x2e`'s byte 7 is a MODE selector in exactly the sense `0x1b`'s at[2]/at[4] are.
The LONG `0x2e` (byte 7 = 0, 590 B) does **not** contain `1b 14 4c` anywhere.

Two doors, one table — but not the same function of the eid: `0x2e[sel=1]` and `0x1b[at4=1]` agree exactly on
eid `0x46` and on **16 of 64** eids over `0x00..0x3f`. The agreement that does hold cleanly is a cross-check
between two independent reads: `0x2e[sel=1]` returns trailer `02` for exactly 16 eids
(`0x24 0x27 0x28 0x29 0x2c 0x2d 0x30 0x31 0x34 0x35 0x38 0x39 0x3b 0x3c 0x3d 0x3f`), and those are **exactly**
the 16 eids whose zeroed-tail `0x1b` record is the default/hole record. The eid space's holes are therefore
visible from two different sub-actions.

## 5b. `0x03` byte 5 on `0x5e` is a FREE-RUNNING COUNTER at ≈93.8 units/s — "+6 per READ" is refuted (§6)

Landed by the ROUND 14 §6 cadence test below; the correction is repeated here because the old wording is
quoted in three places.

## 5c. `sub=0x2e` IS `SUB_LAYOUT_MAP` — part of that region was never anonymous (§7)

The region is not an unexplained bitfield: `SUB_LAYOUT_MAP = 0x2e` (`forgefx-midi/src/devices/gen3/simResponders.ts`)
and the repo's own `parseFm3GridLayout` decodes the reply's TAIL to grid cells whose effectIds are **exactly** the
13 placed eids from an independent `fn=0x13` dump (`SET-EQUAL=true`). The 20 one-hot ladders live in the
**head**, which stays unexplained. Full detail in §7.

## 5. What ROUND 14 does NOT claim

- The five content bytes `1b 14 4c 7a 0a` are **not decoded**. They are not a name, not a param count (the
  round that killed that is ROUND 13), and not a clock.
- What the trailer byte (`00` / `02` / `03`) counts is unknown.
- The old value `01 00 00 00 00 02` and the new `1b 14 4c 7a 0a 02` are **two readings of one field**, not two
  records. ROUND 13's `01 00 00` must not be quoted as a property of byte 9.

### Files added in ROUND 14

| file | produced by | what it holds |
|---|---|---|
| `1b-fixed-records.tap` | `probe-1b-fixed-records.ts` (read-only) | selector sweeps, `at[1]` sweeps under each selector, the `0x2e` selector sweep 0x00..0x0f, and the `0x2e[1]` vs `0x1b[at4=1]` eid comparison |
| `1b-address-selectors-rerun.tap` | `probe-1b-structure.ts --index-sweep 0x46` (read-only) | the ROUND 13 sweep re-run at 14:26; TX sequence byte-identical to `1b-address-selectors.tap` (13:57), one record different |
| `03-cadence-5e.tap` | `probe-03-cadence.ts` (read-only) | the §6 cadence test: 64 ms / 500 ms / tight read blocks, two idle windows with zero frames, and the `0x3a` contrast |

## 6. `0x03[sel=01]` byte 5 on `0x5e` is a free-running counter at ≈93.8 units/s — NOT a per-read step

**Provenance:** `ForgeFX/server/scripts/probe-03-cadence.ts` (READ-ONLY), run on the live FM3, same preset
(`fn=0x0d` = "USA Mk IV") and same 13 placed eids. Tap `03-cadence-5e.tap`, log
`review-2026-10-12/probe-03-cadence.out`. Predictions for three candidate mechanisms were committed in the tool
header before the first frame was sent.

The discriminator is the **idle window**: nothing is sent for 20 s / 30 s, so a per-read counter can only move
by its per-read step, while a free-running clock must move by rate × time. Frames arriving during each window
were COUNTED (`transport.onFrame`), not assumed away.

| block | Δt | reads | measured Δ | clock (≈93.8/s, mod 128) | counter (+6/read) |
|---|---|---|---|---|---|
| A (8 reads @64 ms) | 68–70 ms each | 1 | **+6/+7** | 6–7 | 6 |
| **I20** (idle, 0 frames) | 20 024 ms | 1 | **+85** | 86 | 6 |
| **I30** (idle, 0 frames) | 30 050 ms | 1 | **+1** | 2 | 6 |
| B (8 reads @500 ms) | ~500 ms each | 1 | **+46…+48** | 47 | 6 |
| C (20 tight reads) | 18–19 ms each | 1 | **+1/+2** | 2 | 6 |
| **C first→last** | 351 ms | 19 | **+33** | 33 | 114 |
| contrast: `0x3a` over a 20 s idle | 20 037 ms | 1 | **0** | 87 | 6 |

- **I20/I30 carry ZERO frames** and still move — by +85 and +1. The counter predicts +6 for both. Note the
  30 s case is the wrap: 93.78 × 30.05 s = 2818 units, and `2818 mod 128 = 2`, so the field lands 2 units above
  where it started — the residue is *not* 125 only because the two reads themselves take 50 ms. Both windows
  agree with the clock **within 1 unit**, and both are impossible for any per-read step.
- **C first→last is the cleanest refutation of the counter**: 19 reads, +33 measured, +114 predicted.
- **The contrast is what makes it specific**: in the same 20 s, `0x5e` moved +85 and eid `0x3a` moved **0**.
  So this is not a bus-wide or global clock leaking into every reply; `0x3a`'s byte 5 is genuinely
  write-driven (`+1` per write, unchanged across a 33 s idle in the ROUND 12 arm).
- **The stability control had to be a NON-drifting eid.** A first version of this tool used the target itself
  as its own control and aborted with `3b 3d 3f` — i.e. it failed on exactly the behaviour under test. Fixed:
  eid `0x46` answers `39 39 39` and the target's own drift is reported, not policed. **A stability control
  must be measured on a row you do not expect to move.**
- Rate from this run: 93.74–94.0 units/s (I20 93.74, I30 93.74, B 94.0, C 94.0), independently agreeing with
  an offline fit of the ROUND 12 arm taps at 93.78 units/s.
- **Consequence for the record:** the ROUND 12 arm's "byte 5 advances +6 per READ" is a CADENCE ARTEFACT — 6.0
  units is exactly 64 ms at 93.8/s. Their own drift control read at 128 ms and moved +12 per read, so the
  description did not survive its own control. Nothing about the bypass flag changes; the "cannot separate
  bypass-induced step from drift" verdict is now explained rather than merely cautious.

## 7. `sub=0x2e` IS `SUB_LAYOUT_MAP` — the region is two structures, and the ladders live in the unexplained head

**Provenance:** offline only, no hardware. `forgefx-midi/src/devices/gen3/simResponders.ts` names
`SUB_LAYOUT_MAP = 0x2e`; the repo's `parseGen3GridLayout` / `parseFm3GridLayout`
(`forgefx-midi/src/gen3/axe-fx-iii/gridLayout.ts`) decode it, with `FM3_REGION_OFFSET = 366`, `FM3_BASE_BIT = 6`,
a column-major 12×4 grid, one 32-bit big-endian record per cell, empty cell = all zero. Run against
`2e-volatility-64sample.tap`, the parser returns **13 cells whose effectIds are exactly the 13 placed eids** from
the independent `fn=0x13` status dump (`SET-EQUAL=true`).

**So the 576-byte region is not one anonymous bitfield:**
- **tail** (the grid region) — decoded by the repo, matches the placed set;
- **head** — 8-byte-periodic, holds **all 20** one-hot ladders (`40 20 10 08 04 02 01`, longest run 7, every one
  starting at offset ≡ 7 mod 8, range 39…343), and is **not decoded**.

Three further hypotheses for the ladders were killed offline, so they are not worth hardware time:
1. **"The ladders are grid/cell fields"** — no: they all lie *before* the grid region the repo's own offsets
   define, and no ladder byte is inside it.
2. **"record count = number of families"** — no: the head holds ~44 8-byte records; the repo's counts are 47
   catalog families / 46 eid-map entries / 40 block families / 48 grid cells. None matches.
3. **"a family record can index its params"** — no: a record is 8 B, and the largest family (GLOBAL, 173 params)
   cannot be indexed by 64 bits. Also "the region is a preset-body u16 param array" dies on stride (measured
   period 8, not 2) and on size (576 B = 288 u16 matches no FM3 family).

**What this changes:** task 4's premise ("name the ladder, or leave it killed") resolves as *neither wholly* —
the region is partly named already, and the remaining question is scoped to the head. The one falsifiable test
left there is `H_head`: move ONE block to another grid cell (or toggle its bypass) with the no-write drift
control and 5 reads per stage, and count **how many of the ~44 head records change**. Pre-committed meanings:
exactly one head record changing 1:1 with the one tail cell ⇒ a per-placement state table; zero ⇒ the head is
preset-static metadata; changes with no write ⇒ volatile, mask it; nothing moves ⇒ the region is a device
constant. **Not yet run.**

**The instrument exists and is proven able to fail (offline, 2026-10-12).**
`scripts/diff-2e-head-vs-grid.ts` takes two or three taps (before / during / after) and prints one verdict line;
it imports the repo's REAL `parseFm3GridLayout` rather than reimplementing the grid, and DERIVES the head/tail
boundary from `FM3_REGION_OFFSET` / `FM3_BASE_BIT` at runtime (it prints the boundary in all four index
conventions: region start = mido 366 = wire 367 = payload 360 = **data 355**, so head = 355 data bytes = 44
8-byte records + 3 trailing bytes). `scripts/make-2e-head-selftest-taps.ts` writes four synthetic taps forcing
the four verdicts; the parent session re-ran all four before adoption and all four fired, including the
`device constant (nothing changed)` case a worthless tool could not return.

**Operational caveat for the run, found while building it:** the documented per-read volatile trio sits at
**data 22–24**, which lands inside head records **#2 and #3** at the data-0 anchor. An `H_head` run must mask
those bytes (or use frames that are stable per stage), or a genuine one-record change is indistinguishable from
the trio's drift. The tool labels that case `volatile / unattributable` rather than guessing.

### 7b. `H_head` HAS BEEN RUN — the region does not reflect BYPASS

**Provenance:** `scripts/probe-2e-head-bypass.ts` (ONE self-restoring bypass toggle, 3 long replies per stage,
one tap PER STAGE), decided offline by `scripts/diff-2e-head-vs-grid.ts … --mask 22,23,24`. Taps
`2e-head-bypass-{before,during,after}.tap`; logs `review-2026-10-12/probe-2e-head-bypass.out` and
`review-2026-10-12/diff-2e-head-bypass.out`. Target eid `0x3a`, preset `"USA Mk IV"` throughout.

| stage | long replies | non-trio bytes within the stage | trio distinct |
|---|---|---|---|
| before | 3 | STABLE | 3/3 (per-read, as documented) |
| during (bypassed) | 3 | STABLE | 3/3 |
| after (restored) | 3 | STABLE | 3/3 |

The write's landing and the restore were both proved through the **`fn=0x13` status dump** — a different path
from the one that was compared: `bypassed=false → true (✔ LANDED) → false (RESTORED)`.

**Result: 0 of 44 head records changed, 0 tail grid cells changed, in both the before→during and
before→after deltas.** The consistency line confirms the index mapping first (`content 576B = head 355B + tail
221B`, parser needs 221B ✔), so the null is a real null and not a misaligned window.

**That lands the pre-committed fifth outcome:** the region does **not** carry bypass state. Combined with the
source's own note that a scene switch never changes the grid structure, this means `H_head` as originally
posed ("does the head track a block's state") needs a **PLACEMENT** change — moving a block between grid cells
— which is a structural preset edit with a weaker restore-proof (the only oracle for placement is the same
`0x2e` grid reply being diffed). **Proposed, not run.**

Minor fix landed with it: the differ's summary printed `reverted=false` on a no-change run, which reads as
"a change failed to revert" — the opposite of what happened. It now prints `n/a (nothing changed)`.

## 8. Task 2's SYMMETRY half: the at1 and at3 axes are NOT one flat index (`H_FLAT` refuted)

**Provenance:** `ForgeFX/server/scripts/probe-1b-symmetry.ts`, READ-ONLY (no writes at all), run on the live FM3,
preset `"USA Mk IV"`, same 13 placed eids. Tap `1b-symmetry.tap`, log `review-2026-10-12/probe-1b-symmetry.out`.

Five 64-row sweeps of the nine-byte content `C9 = data[5..13]`, all with at0 = at2 = at4 = 0:
`V(0x46)` walks at3 with at1 fixed at `0x46`; `V(0x3a)` the same at `0x3a`; `U(D)` walks at1 with at3 fixed
at `D` for D ∈ {0x00, 0x01, 0x08}.

`H_FLAT` says `C9 = T(at1 + at3)`, which predicts `U_D(b) == V_E(b + (D − E))` — a shift of exactly `D − E`.

| comparison | best Δ (scanning −63…+63) | rows compared | mismatch at best Δ | mismatch at the PREDICTED Δ = D−E |
|---|---|---|---|---|
| `U(0x01)` vs `V(0x46)` | +42 | 22 | 8/22 = 0.364 | **Δ = −69 — OUTSIDE the scan; 0 rows comparable** |
| `U(0x08)` vs `V(0x46)` | +41 | 23 | 9/23 = 0.391 | Δ = −62 → 2 rows, 2 differ |
| `U(0x01)` vs `V(0x3a)` | +27 | 37 | 29/37 = 0.784 | Δ = −57 → 7 rows, 5 differ (0.714) |
| `U(0x08)` vs `V(0x3a)` | −5 | 59 | 46/59 = 0.780 | Δ = −50 → 14 rows, 13 differ (0.929) |
| `U(0x01)` vs `U(0x00)` — SAME axis | 0 | 64 | 11/64 = 0.172 | (reference row) |
| `U(0x08)` vs `U(0x01)` — SAME axis | 0 | 64 | 13/64 = 0.203 | (reference row) |

- **`H_FLAT` is REFUTED.** At the shift the hypothesis predicts, the mismatch is 0.71–0.93 over whatever rows
  exist — never 0. There is no shift anywhere in the scanned range that makes the at1 map a translate of an
  at3 map (`U(0x01)` vs `V(0x3a)`: the best of all 127 shifts still mismatches 78% of its rows).
- **`H_TWO` is not cleanly supported either, and the reason matters.** Against `V(0x46)` the best shift agrees
  on 14 of 22 rows (0.64) against an in-run null of 0.25 — above chance, but (a) only 22 rows exist there and
  (b) it is NOT the predicted shift. Both maps are dominated by their modal token (`00 00 00…` is 46% of all
  320 readings pooled), so shared modal structure alone can produce that. **Recorded as unexplained, not as a
  finding.**
- **What the same-axis rows DO establish:** moving at3 from `0x00` to `0x01` changes **11 of 64** rows of the
  at1 axis; from `0x01` to `0x08`, **13 of 64**. So at3 is a *perturbation of the at1-keyed records* rather
  than a second offset into one table — which is a strictly better description than "both bytes address things"
  and is what refutes the flat-index reading.
- **Reproduction, and a design limit worth stating.** `V(0x46)` = **23 distinct** and `V(0x3a)` = **37
  distinct** reproduce ROUND 13's table exactly on a fresh tap. But for `E = 0x46` the predicted shift
  `D − E` falls outside a ±63 scan, so that pair cannot test the hypothesis at all — the test is only sound
  where the two fixed values are close, and `E = 0x3a` is the pair that carries the refutation.

### 8c. Task 2's STABILITY half HAS BEEN RUN — the content is scene-INVARIANT, except the hole record

**Provenance:** `scripts/probe-1b-symmetry.ts --with-scene` (ONE self-restoring scene change, 5 reads per anchor
per stage, 8 anchors, 4 stages). Tap `1b-symmetry-scene.tap`; log
`review-2026-10-12/probe-1b-symmetry-scene.out`. Scene writes `{ok:true}` both ways, device read back `0 → 1 → 0`.

Stages A (scene 0) · A′ (no write) · B (scene 1) · C (scene 0 restored). Every anchor was stable **within** every
stage (5/5 identical), so the design's own gate passed and a change between stages is attributable.

| anchor | A · A′ · B · C |
|---|---|
| `C9(0x46, at3=0)`, `C9(0x46, at3=1)`, `C9(0x46, at3=8)`, `C9(0x2a, at3=0)`, `C9(0x3a, at3=0)`, `C9(0x25, at3=0)`, `C9(0x2e, at3=0)` | **identical across all four stages** |
| `C9(0x24, at3=0)` — the HOLE record | **SCENE-DEPENDENT**: B differs, C reverts |

**Verdict: `H_SCENE_DEPENDENT`, from one anchor out of eight.** The `0x1b` content is **not** scene state — with
the single exception of the hole/default record, which is followed up in §9 and turns out to be the scene index
itself.

### 8b. Independent re-derivation of §8 — agrees on every published number, and adds three caveats

An independent child re-derived §8 from `1b-symmetry.tap` alone (own parser, 584 pairs, echo check 0 mismatches)
without reading this README or the tool. **Every published number reproduced**: `V(0x46)` = 23 distinct,
`V(0x3a)` = 37 distinct, the at1 maps at 8 / 9 / 8 distinct, and the whole translation table
(`U(0x01)` vs `V(0x46)` best Δ=42 → 8 of 22 differ; `U(0x08)` vs `V(0x3a)` best Δ=−5 → 46 of 59). It also
reproduced the same-axis rows independently as at3-vs-at3: `0x00↔0x01` 11/64, `0x00↔0x08` 13/64, `0x01↔0x08`
13/64.

**Three caveats it found that this section did not state. They are all now part of the record:**

1. **`1b-symmetry.tap` contains NINE 64-row sweeps, not five — `FORGEFX_TAP` APPENDS.** The first (superseded)
   version of the tool ran four at1-sweeps into the same file before the fixed version added its five. A reader
   parsing that tap must segment it (the second block starts after the four warm-up control pairs at indices
   260–263) or, as the analyses here do, take the LAST occurrence of each `(at1, at3)` tuple. Both the parent
   and the child took the last; the numbers agree. **From here on, name the tap per run** — an appending tap
   that cannot be told apart from a sibling run's is not provenance, which is the rule the handover already
   carries.
2. **The at1 maps are byte-identical ACROSS runs.** The run-1 and run-2 sweeps of the same tuple diff by **0**:
   `at3=0x00` three times, `at3=0x01` twice, `at3=0x08` twice. So the at1 axis is reproducible across separate
   sessions ~10 minutes apart — which is the opposite of the hole record's behaviour and makes it the *right*
   axis to key anything on.
3. **Ratios computed on a handful of rows are artefacts, and the null is pooling-dependent.** For the
   `at1=0x3a` pairs the argmin can land at |Δ|≈62 with only **2** compared rows and a ratio of 0.5 that means
   nothing (at Δ=0 that pair differs ~0.86). And "chance" is not one number: `sum(p²)` = **0.250** over the five
   distinct maps, **0.299** over all nine runs, **0.370** over the first block alone. §8 quotes 0.250; say which
   pooling a null came from.

**Files added in ROUND 14 §8**

| file | produced by | what it holds |
|---|---|---|
| `1b-symmetry.tap` | `probe-1b-symmetry.ts` (read-only) | the five 64-row sweeps (two at3 maps, three at1 maps) plus controls. **Holds NINE sweeps: it APPENDS, and the discarded first version of the tool wrote four of them here** — take the LAST occurrence per `(at1, at3)` |
| `1b-symmetry-scene.tap` | `probe-1b-symmetry.ts --with-scene` | the §8c scene arm: 8 anchors × 5 reads × 4 stages (A, A′ no-write, B scene 1, C restored) |
| `1b-hole-vs-scene.tap` | `probe-hole-vs-scene.ts` | the §9 sweep: the hole record at each of the eight scenes, with the `0x46` control |
| `2e-head-bypass-{before,during,after}.tap` | `probe-2e-head-bypass.ts` | the §7b arm: 3 long `0x2e` replies per stage, **one tap per stage** so the stages cannot be conflated |

---

## 9. The "hole" record's first byte IS THE SCENE INDEX — 8 for 8

**Provenance:** `scripts/probe-hole-vs-scene.ts` (one self-restoring scene write per step, original scene
restored and re-read at the end), tap `1b-hole-vs-scene.tap`, log
`review-2026-10-12/probe-hole-vs-scene.out`. Predictions committed before the first frame.

| scene | device read-back | C9(0x24, at3=0) | C9(0x46, at3=0) — control |
|---|---|---|---|
| 0 | 0 | `00 00 00 00 00 02 00 00 00` | `47 42 00 …` |
| 1 | 1 | `01 00 00 00 00 02 00 00 00` | `47 42 00 …` |
| 2 | 2 | `02 00 00 00 00 02 00 00 00` | `47 42 00 …` |
| 3 | 3 | `03 00 00 00 00 02 00 00 00` | `47 42 00 …` |
| 4 | 4 | `04 00 00 00 00 02 00 00 00` | `47 42 00 …` |
| 5 | 5 | `05 00 00 00 00 02 00 00 00` | `47 42 00 …` |
| 6 | 6 | `06 00 00 00 00 02 00 00 00` | `47 42 00 …` |
| 7 | 7 | `07 00 00 00 00 02 00 00 00` | `47 42 00 …` |

**Eight scenes → eight distinct values, byte 0 equal to the scene index, byte 5 constant `02`, bytes 6-8 zero.**
The control anchor did not move at all, so this is not a link-wide artefact. The scene write landed every time
(read back) and the original scene 0 was restored and confirmed.

This is the record that the at2-selector returns and that the 49 unused eids answer — so §2's "hole/default
record" is now partly decoded: **on this unit, in this regime, it reports the current scene.**

**What this does NOT yet explain, and must not be smoothed over.** The value read from 14:20 to ≈15:2x,
`1b 14 4c 7a 0a 02 00 00 00`, has first byte `0x1b` — not a legal scene index. So the same address resolves to
at least two different regimes, and the 8-for-8 map above is measured in the *current* one. Two readings of one
field in two regimes is a **state we have not characterised**, not a refutation of the map and not evidence
against it.

**And a tap-backed fact about who wrote what.** `setScene` on this unit is **not** `fn=0x0c` — the FM3 profile
sets `sceneChannelWriteMode: 'fm3-edit-fn01'`, so a scene write is `fn=0x01 sub=0x24 0x00`. Grepping every tap
in this directory for that frame: it appears in **exactly two files**, `1b-symmetry-scene.tap` (2 — scene 1,
then the restore to 0) and `1b-hole-vs-scene.tap` (8 — the sweep), both authorised, both self-restoring, both
ending at scene 0. **No other tap here holds a scene write, including all of ROUND 12/13** — so the
13:57 → 14:20 change in the hole record has no frame of this stack's behind it, and the two scene arms are the
only scene writes ROUND 14 made. (`fn=0x0c` frames exist only as the GET SCENE *read*, `… 0c 7f 67 f7`, in
those same two taps.)

**Cheap instrument, and the reason to add it now:** the hole record is worth four frames at the head of every
probe run — (hole record, `fn=0x0d` preset name, `fn=0x13` placed set, **scene index**). That dates the next
regime change instead of costing a round, which is exactly what today's version could not do.

---

# ROUND 15 (2026-10-12, same unit, preset `"USA Mk IV"`) — the volatile set is DERIVED, and the oracle moves the subject

Two read-only measurements, both on the live FM3, taken because the ROUND 14 mask (`--mask 22,23,24`) turned
out to be a guess that the first ROUND 15 pairing contradicted. Nothing was written in either run.

## 1. The per-read volatile set is 22/23/24 — but a body dump adds 25/26/27 for ~one read group

**`scripts/probe-2e-volatility.ts`** (16 consecutive long `sub=0x2e` replies, ONE connection, nothing
written, `sub 0x99` silent as the negative control, reply length and address echo asserted constant):
**570 of 576 data offsets read one value in all 16 reads**; the offsets with a non-constant value are
**22, 23 and 24** and nothing else. The derived mask equals the documented trio — 16 reads do not extend it.

**The constraint is that the mask is only valid while the reply is undisturbed.** The first ROUND 15 pairing
(two reads taken immediately after two edit-buffer BODY dumps) moved **22, 23, 25 and 27** — 24 did *not*
move and 25/27 did. That is the same reply, the same preset, no write anywhere, and a different volatile
FOOTPRINT, which is what "some preceding traffic leaves the region looking different" looks like.
`scripts/probe-2e-dump-perturbation.ts` measured it as four read groups in one connection (4 reads each):

| group | intervention before it | data 25 / 26 / 27 |
|---|---|---|
| A | none | `46` / `50` / `4a` — single values |
| A2 | none (the self-drift control) | `46` / `50` / `4a` — **identical to A** |
| B | one edit-buffer body dump (`fn 0x77/0x78/0x79`) | `{3c,44,46,7a}` / `{10,50}` / `{2a,4a}` — **moved** |
| B2 | none | `46` / `50` / `4a` — back to canonical |
| B3 | none | `46` / `50` / `4a` — holds |
| C | one `fn=0x13` status dump | `46` / `50` / `4a` — unmoved |

So: **the edit-buffer body dump transiently perturbs data 25/26/27 for about one 4-read group**, and by the
next group the reply is back to the values two no-intervention groups agreed on. The `fn=0x13` status dump
moves nothing. Reproduced on a second run with the same verdict (`dump-perturbation-02.tap`).

**The operative rules this gives the `0x2e` arms** — CORRECTED the same evening by §3, and the correction
matters more than the finding that prompted it:

- Mask the **derived trio 22/23/24** for the release comparison. **Do NOT mask 25/26/27**: masking them hides
  head record **#3**, which is the one record that answers `H_head` (§3). The first ROUND 15 placement run
  masked 22..27 and reported `preset-static metadata` — a **false negative produced by the mask**, not by the
  device.
- Use a **dwell trace** (many reads over seconds, nothing else happening, per-read values printed) to tell the
  two apart: a per-read/dump value moves *within* the dwell, a placement STATE byte holds for the whole dwell
  and reverts when the placement is undone. That is a cheaper and more honest discriminator than widening the
  mask over the answer.
- The ROUND 14 `H_head` null (§7b) used `--mask 22,23,24`; its three stage taps were written at 15:57 and its
  "0 of 44 head records changed" is what it reported. §3 does NOT contradict it: that arm toggled BYPASS, and a
  bypass write does not move record #3 (measured: 25/26 read `46/50` in all three of its stages).

**Files added in ROUND 15 §1:** `scripts/probe-2e-volatility.ts`, `scripts/probe-2e-dump-perturbation.ts`,
`review-2026-10-12/volatility-2e.tap` + `-01.tap`, `dump-perturbation-01.tap` + `-02.tap`,
`volatility-2e.json`, `dump-perturbation.json`.

## 2. The standing read (the instrument ROUND 14 asked for) — and the hole record's current regime

`scripts/standing-read.ts` takes the four frames in one connection and **appends a dated JSONL line** to
`~/repos/stack/standing-read.jsonl`: the hole record (`fn=0x01 sub=0x1b` at `[00 24 00 00 00]`), the preset
name (`fn=0x0d`), the placed set (`fn=0x13`) and the scene index (`fn=0x0c`), with two controls (negative
`sub 0x99` silent; the reply must have arrived). It is exported as `standingRead(session)` so any probe can
put it at its head.

Readings today, local time (the log stores UTC):

| when | preset | scene | hole record (`payload[5..13]`) |
|---|---|---|---|
| 16:17 | `USA Mk IV` | 0 | `00 00 00 00 00 02 00 00 00` |
| 16:21 | `USA Mk IV` | 0 | `00 00 00 00 00 02 00 00 00` |
| 16:32 | `USA Mk IV` | 0 | `00 00 00 00 00 02 00 00 00` |

All three are the **scene-index regime** (§9): scene 0, byte 0 = `00`. The other regime (`1b 14 4c 7a 0a 02 …`,
whose byte 0 is not a legal scene index) is not present in any reading taken after 15:3x local, and the
stack sent no frame that could have ended it — its end is therefore still undated, and the next transition
is now DATED by construction rather than reconstructed by hand.

**Files added in ROUND 15 §2:** `scripts/standing-read.ts`, `~/repos/stack/standing-read.jsonl`.

## 3. `H_head` IS ANSWERED — the `0x2e` HEAD is a per-placement STATE TABLE, and one body dump does not hide it

The arm the ROUND 14 plan left open, run three times on the live unit with the owner's go-ahead.
**Instrument:** `scripts/probe-2e-placement.ts` (`--go`; dry-run by default) — it places a NOT-placed block
instance into a **verified-empty** cell and clears it again, so the existing chain is never touched and the
restore is a single clear of a cell that was empty before. Three writes per run: `placeCell(r,c,0x4f)`,
`placeCell(r,c,0)`, nothing else. No slot is written.

| arm | cell (route) | landing (`fn=0x13`) | restore proof (edit-buffer BODY) | release differ (`--mask 22,23,24`) |
|---|---|---|---|---|
| 1 | r1c1 | placed ✔ / removed ✔ | BYTE-IDENTICAL ✔ | **1 head record + 1 tail cell, reverted** |
| 2 | r1c2 | placed ✔ / removed ✔ | BYTE-IDENTICAL ✔ | **1 head record + 1 tail cell, reverted** |
| 3 | r4c12 | placed ✔ / removed ✔ | BYTE-IDENTICAL ✔ | **1 head record + 1 tail cell, reverted** |

In all three runs the SAME record moved, with the SAME values:

```
record #3 (data 24..31)   unplaced:  00 46 50 4a 55 1a 04 40
                          placed:    00 4c 10 4a 55 1a 04 40        ← only data 25 and 26 move
```

The tail cell that appeared is always the cell that was written (col 0 row 0 / col 1 row 0 / col 11 row 3),
and the `after` stage is byte-identical to `before` — so the pre-committed outcome table resolves to
**`per-placement state table`**: one head record and one tail cell moving together and reverting.

**It is STATE, not a transient.** A **dwell trace** (12-20 reads over 3-5 s with nothing else happening,
per-read values printed) holds `4c/10` for the whole dwell while the block is placed, and holds `46/50` for the
whole dwell once it is cleared. A per-read or dump-derived value cannot do that — it moves inside the dwell.

**It is a single GLOBAL placement field, not a per-cell record.** Three different cells — two adjacent in the
top row and the far corner of the bottom row — move the SAME record #3 to the SAME values. Prediction written
down before arm 3 ("global field ⇒ record #3 moves again for a distant cell") and it held.

**It is not "any write".** ROUND 14's bypass arm (a param write) left data 25/26 at `46/50` in all three of its
stages, and the `fn=0x13` status dump moves nothing.

**What it is NOT.** Data 25/26's SEMANTICS are undecoded — nothing here says whether the pair is a hash, a
count, a "grid edited" flag or a bitfield, and the values are observations from this preset, not device
constants. Two further measured wrinkles worth keeping: ONE body dump perturbs 25/26 transiently with values
that never included `4c` (so the dump's effect and the placement's are distinguishable), and one read in the
r1c2 dwell sampled `4b/50` — a single intermediate sample, unexplained.

**The methodological lesson.** The first run of the arm masked 22..27 (the mask derivation in §1) and reported
`preset-static metadata`: **masking the perturbed bytes hid the very record that answers the question.** A mask
must cover only what is *genuinely* per-read; anything wider must be justified by a dwell, not assumed.

**Files added in ROUND 15 §3:** `scripts/probe-2e-placement.ts`, `scripts/probe-grid-baseline.ts`,
`review-2026-10-12/placement-{before,during,after}-cell11.tap`, `placement-arm-0{1,2,3,4}.tap`,
`placement-diff*.out`, `cell12/placement-*.tap`, `cell4-12/placement-*.tap`.

## 4. WHAT record #3's bytes ENCODE — data 25 IS a content function, data 26 is NOT clean

`scripts/probe-2e-record3.ts` (dry-run by default), run twice, each run a 6-write state chain, every write
self-restoring and every restore proven byte-identical through the edit-buffer body. States, in order:
`S0` nothing extra · `S1` chorus 2 at r1c1 · `S2` chorus 2 **and** comp 2 · `S3` comp 2 cleared · `S4` both
cleared · `S5` comp 2 alone at r1c1 · `S6` cleared. Each stage = 6 reads + 8 dwell reads; **data 24 is
excluded from every comparison** because it is the last member of the per-read volatile trio 22/23/24 (it took
13 distinct values across 14 reads of ONE stage — including it makes a value that repeats exactly look like it
does not).

| state | run 1 record #3 (data 25..31) | run 2 (same chain, same order) |
|---|---|---|
| empty (S0/S4/S6) | `46 50 4a 55 1a 04 40` | `46 50 4a 55 1a 04 40` |
| chorus 2 alone (S1/S3) | `4c 10 4a 55 1a 04 40` | `4c 10 4a 55 1a 04 40` |
| comp 2 alone (S5) | `4d 10 4a 55 1a 04 40` | `4d 10 4a 55 1a 04 40` |
| both placed (S2) | `52 10 4a 55 1a 04 40` | **`52 50 4a 55 1a 04 40`** |

Pre-committed hypotheses, and what the chain answered:

- **H_FLAG refuted** — a dirty/edited flag predicts the same value for 1 block and 2 blocks; the 2-block state
  reads `52`, not `4c`/`4d`.
- **H_COUNT refuted** — a count predicts chorus-alone = comp-alone (both are one block); they read `4c` and
  `4d`, and both are stable over 14 reads each.
- **H_HASH supported, with a caveat** — the value is state-dependent AND repeatable: S1 and S3 (the same state
  reached by different edit histories) read identically, and the canonical `46 50` returns at S4 and S6. **But
  data 26 is not a clean function of the content**: identical chains in two runs gave `10` and `50` at the
  2-block state while data 25 stayed `52` both times. So **data 25 is the reliable content carrier**
  (`46` empty, `4c` chorus alone, `4d` comp alone, `52` two blocks — identical in both runs) and data 26
  carries a second, slowly-updating component (bit 6, `0x10` vs `0x50`) that is not explained yet. Data 27..31
  never moved in any state.

**The encoding is still NOT cracked**, and the negative results are recorded so they are not re-tried: no
simple function of the reply reproduced the pair — XOR, byte sums (mod 128 / 256), 16- and 32-bit big-endian
word sums, CRC-16/CCITT, CRC-32, Adler-32, non-zero counts and popcounts, over five regions of the reply
(whole content, head, tail grid, bytes 28..355, bytes 22..26). A 5-septet float32 (`decode5SeptetFloat32`) at
every offset 20..25 decodes to `0`. What it is NOT is a per-read value: within each state it held for the whole
14-read stage.

**Files added in ROUND 15 §4:** `scripts/probe-2e-record3.ts`, `review-2026-10-12/record3/` and
`record3-run2/` (one tap per stage, named by state), `record3-run-0{1,2}.tap`, `record3-chain.json`.

## 5. Record #3 is NOT time-driven and NOT a settling effect — but data 26 is bimodal across runs

Two long read-only traces and one long held dwell, all on the live unit (`scripts/trace-2e-record3.ts`,
`scripts/probe-2e-placement.ts --dwell 80`):

- **100 reads over ~50 s with NOTHING happening: data 25..31 held one value, `46 50 4a 55 1a 04 40`**, the
  whole time (only data 24 moved — 54 distinct values, the per-read trio again). ⇒ it is not time-driven.
- **A placement held for 80 reads over 20 s: `4c 10` on every read. After the clear, 80 reads: `46 50` on
  every read.** ⇒ there is no delayed settle and no drift while a state is held.
- Two further runs of the §4 state chain (runs 3 and 4) reproduced the same content values for empty
  (`46 50`), chorus 2 alone (`4c 10`) and comp 2 alone (`4d 10`) — **but data 26 took `0x50` for the
  two-block state in two runs and `0x10` in the other two**, and in run 3 the ONE-block state showed BOTH
  `4c 10` and `4b 50` inside a single 12-read stage. A `4b 50` sample had already been recorded once
  mid-dwell in the ROUND 15 placement arm.

So the honest position after four runs: **data 25 looks like a reproducible function of grid content**
(`46` empty, `4c` chorus 2 alone, `4d` comp 2 alone, `52` two extra blocks) and **data 26 is bimodal for the
two-block state** (`0x10`/`0x50`), with rare mixed samples (`4b 50`) that are not explained by time, by
settling, or by any content difference we have captured. The encoding of data 25 remains uncracked.

**Files added in ROUND 15 §5:** `scripts/trace-2e-record3.ts`, `review-2026-10-12/trace-record3-01.tap`,
`placement-settle-01.tap`, `record3-run-0{3,4}.tap`, `record3-run{3,4}/`.

---

## What is explicitly NOT decoded

- The meaning of `0x2e`'s 576-byte region's **HEAD** (~44 8-byte records, all 20 one-hot ladders) and of the
  `+22..+24` trio. The region's TAIL is the repo's own grid layout and IS decoded (§7).
- What `0x03` byte 5 *counts*. Its mechanism on `0x5e` is now measured — a free-running ≈93.8 units/s counter,
  mod 128 (§6) — and `0x3a`'s is write-driven, but what either number MEANS is open.
- ~~Whether the ~44 head records track placement (`H_head`, §7)~~ — **ANSWERED in ROUND 15 §3**: they do,
  but as ONE GLOBAL field, not a per-cell table. Record #3 (data 24..31, bytes 25/26) moves `46 50 → 4c 10`
  for a block placed in ANY of three different empty cells, holds for the whole dwell and reverts on the clear.
  ROUND 15 §4 then showed **data 25 IS a reproducible function of the grid content** (`46` empty, `4c` chorus
  alone, `4d` comp alone, `52` two blocks, identical across two independent runs) while **data 26 is not a
  clean function of it** (`0x10`/`0x50` for the same 2-block state in the two runs). What the numbers are —
  hash, index, size — is still open, and so is the meaning of data 26's second component.
- `0x1b`'s content bytes. ROUND 13's "addressed read of a table, at[2]/at[4] selectors, at[3] an index joint
  with the eid" survives; ROUND 14 adds that the selector replies carry nine content bytes, that the byte-9
  reply is the hole/default record, and that the hole record is time-varying. **The "21 bits" framing is dead —
  count the bytes from the tool, not from a sentence.**
- Whether any of these carry the bypass state — that question is **open**, not answered in either direction.
