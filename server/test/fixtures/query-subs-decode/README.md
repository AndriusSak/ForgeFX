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

**What is NOT established:** why it moved — but every candidate trigger has been excluded. It is not a fast
clock (byte-identical at 14:20, 14:26 and 14:50). The preset name and the placed-eid set did not change.
Nothing was written to the unit by any ROUND 12–14 probe (all read-only; ROUND 13's bypass arms self-restored
and were proven restored through `fn=0x13`). The unit's owner confirms he did not touch it during the window,
and `journalctl -k` shows **no USB connect/disconnect at all since 10:43:41** — the device stayed enumerated
across the change, so it is not a re-enumeration or a power-cycle artefact either. So this is an **uncommanded
internal state change**: a defect candidate, not a decode, and never a stable identity.

Whoever picks this up: the cheap instrument is a standing read — log this record (plus `fn=0x0d` preset and
`fn=0x13` placed set) at the head of every future probe run, so a drift gets a time series for free instead of
costing a round.

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

---

## What is explicitly NOT decoded

- The meaning of `0x2e`'s 576-byte region's **HEAD** (~44 8-byte records, all 20 one-hot ladders) and of the
  `+22..+24` trio. The region's TAIL is the repo's own grid layout and IS decoded (§7).
- What `0x03` byte 5 *counts*. Its mechanism on `0x5e` is now measured — a free-running ≈93.8 units/s counter,
  mod 128 (§6) — and `0x3a`'s is write-driven, but what either number MEANS is open.
- Whether the ~44 head records track placement (`H_head`, §7) — the one falsifiable test left there.
- `0x1b`'s content bytes. ROUND 13's "addressed read of a table, at[2]/at[4] selectors, at[3] an index joint
  with the eid" survives; ROUND 14 adds that the selector replies carry nine content bytes, that the byte-9
  reply is the hole/default record, and that the hole record is time-varying. **The "21 bits" framing is dead —
  count the bytes from the tool, not from a sentence.**
- Whether any of these carry the bypass state — that question is **open**, not answered in either direction.
