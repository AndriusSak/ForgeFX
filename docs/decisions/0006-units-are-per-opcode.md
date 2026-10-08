# 0006 — GLOBAL continuous writes take DISPLAY units (withdrawn — write units are PER-OPCODE)

**Status: SUPERSEDED by measurement, 2026-10-08.** This ADR is kept rather than deleted, because it records a
wrong call and the reason it was made — which is more useful than a clean history. The status applies to the
DISPLAY-units decision it originally made; the surviving rule is the per-opcode one stated in the title and
below (with the open caveat in the last section).

## What this ADR originally decided (now withdrawn)

That the FM3's GLOBAL family takes DISPLAY units (0..100) on the wire, so a normalized↔display conversion
belonged in the data catalogue and the driver's **continuous** write path should apply it.

## Why that was wrong

The premise came from a diagnostic, not from the device. `verify-global-write.ts` called
`setParam(eid, pid, 0.40)` **without the `continuous` argument**. `continuous` is a required parameter with no
default, so the call fell through to the **discrete** branch — which takes PERCENT — and set 0.4%. That reading
was then misread as "the app writes GLOBAL values 100x too small". The app never did: Axis's knob writes pass
`continuous: true` with a 0..1 value (`editor.svelte.ts:1684`).

### MEASURED, second device session (2026-10-08) — the wire value is the param's DISPLAY value

The first measurement above used pid 7115, whose display range is **0..100** — where percent, display value
and a 0-based ordinal all coincide. Two measurements that CAN separate them:

| what | written on the DISCRETE opcode | device | conclusion |
|---|---|---|---|
| `GLOBAL/110` (float, range **25..100**) | `50` | raw 21845 → display **50.0** | the wire number IS the display value (a percentage would give raw 32767 → display 62.5) |
| `GLOBAL/110` restore | `100` | raw 65534 = 100% | restore verified through the bulk body |
| `GLOBAL/7389` selector, options `["1 SECOND","2 SECONDS",…]` | (read only) | body raw **2**, panel shows **2 SECONDS** | the stored/wire value is the DISPLAY value (1-based), NOT a 0-based ordinal (which would be 1) |
| `GLOBAL/7113` selector, options `"CC #1"…"CC #128"` | (read only) | body raw **128** | same — the value is the display number |

**So the rule is: the discrete set takes the parameter's DISPLAY value, in its own range.** "Percent 0..100"
was a special case of that, and stating it as the general rule was wrong. The `7389` row is worth keeping:
the panel's own reading ("2 SECONDS") is what pinned it, which is the cheapest oracle available.

**No off-by-one in the app, verified:** for a scale-1 enum `ordMax === max`, so the served value equals the
raw, and Axis writes the served value straight back (`blockOps.ts`, `blockLibrary.ts` → `continuous: false`).
Offset selectors like "2 SECONDS" / "CC #128" therefore round-trip correctly.

**The scaled enum — MEASURED 2026-10-08, and the app is correct.** With a Phaser placed (eid 90), `PHASER/1`
(ORDER) has body raw **1**, the app serves value **1**, and its option list is
`[{0:"2"},{1:"4"},{2:"6"},{3:"8"},{4:"10"},{5:"12"}]`. Every display label is **even**, so a raw of `1` cannot
be a display value — **the raw is the ORDINAL** for a scaled row, and the app's ordinal-indexed list plus
verbatim write-back is the correct handling. This is also why the `raw > max` unscale branch never fires here
(raw 1 ≤ max 10): do not "simplify" it away without re-measuring.

**Scale-1 OFFSET selector — CLOSED 2026-10-08 (server-side).** A scale-1 OFFSET enum stores the *display*
value: `GLOBAL/7389` has body raw `2` while the unit shows **"2 SECONDS"** (its list starts `"1 SECOND"`), so
the stored value is not a 0-based index. The driver's `#enumOptions` serves the display value as the option
`value` (correct) but read the device-true label at index `value` instead of `value - displayMin`, so a served
`2` labelled the option AFTER the true one. Six served FM3 offset enums were affected (DELAY/87 SVF Type showed
BANDPASS for LOWPASS; PITCH/35 Track Mode; PITCH/76 Tempo; FILTER/21 · FLANGER/30 · PHASER/23 Quantize).
Fixed in `server/src/drivers/gen3.ts` by indexing the label tables at `value - min` (`min` = displayMin; a no-op
for every 0-based list and the scaled PHASER_ORDER case). The Axis client needed no change — it renders
`options.find(o => o.value === value)`, so correct labels are sufficient. Guarded by
`server/test/drivers/enum-coverage.test.ts` (the DELAY/87 mapping pinned literally + an invariant over every
served offset enum against `FM3_ENUM_OVERRIDES` at `value - displayMin`).

## What the device actually does (measured 2026-10-08, raw floats sent straight to the codec, body read back)

| opcode | value sent | `body[7115]` | unit |
|---|---|---|---|
| **continuous** | `0.25` | 16384 = **25.0%** | **normalized 0..1** |
| continuous | `40` | 65534 = 100.0% (clamped) | (consistent — 40 is far above 1.0) |
| **discrete** | `0.25` | 164 = **0.3%** | **percent 0..100** |
| discrete | `40` | 26214 = **40.0%** | percent |

End-to-end through the driver's real continuous path, on the live unit: `norm 0.40` → `raw 26214` (40.0%),
restore `norm 0.70` → `raw 45874` (70.0%), both read from the fn-0x1F bulk body (an independent path).

## The rule this leaves behind

- **Units are per-opcode, not per-family.** Anything keyed to a family alone will be wrong for half the callers.
- **Never call `setParam` without `continuous` explicitly.** Omitting it silently selects a different opcode with
  a different unit, and the mistake is invisible — the write succeeds, at the wrong scale.
- **A unit claim must come from the device, not from a table or from a script's own output.** This is the same
  class as ADR 0004: a stride read off a catalogue, and a value read off a script that skipped a parameter, are
  both not measurements.
- The original P14 change was reverted (`ForgeFX 1b380d3`, `forgefx-midi 6ae3636`). **No app-side fix was needed.**

## OPEN / UNDER-DETERMINED — the discrete unit is only established for a 0..100 param

The "discrete takes percent" reading rests on **ONE** param — `7115` (`GLOBAL_FS_BRIGHTNESS`), whose display
range is `0..100`. For that param **percent, display units, and a wire ordinal all coincide**, so the reading
cannot tell them apart. Two independent sources say the discrete opcode actually carries a read-roster
**ORDINAL**, not a percent:

- the codec's own sources — `forgefx-midi/src/gen3/axe-fx-iii/setParam.ts` (`~402-408`: "the value is the
  read-roster ORDINAL emitted as `float32(ordinal)`"; its interface doc at `~2318` says the same) and
  `forgefx-midi/src/devices/gen3/catalog.ts` (`~189-195`: "resolve a NAME to its read-roster ORDINAL … the
  ordinal IS the set value");
- the server handler — `server/src/runtime/handlers.ts` (`~205`, `~224-226`) requires, for a discrete write,
  "an integer read-roster ORDINAL in the same 14-bit 0..16383 space as the effect/param ids".

Two unmeasured cases would decide it:

- **(a) a SCALED enum** — e.g. `PHASER_ORDER`, whose display = ordinal × 2 — written discretely with ordinal
  `k` and read back. If the device stores `k` (not `2k`, not a percent), the discrete unit is the ordinal.
- **(b) an integer written discretely to a float with a range other than 0..100** — e.g. a 0..1 or 0..16383
  param, where percent and ordinal diverge — and read back.

**Until one of those is measured, "discrete takes percent" is established only for a 0..100 param.** The
per-opcode *principle* (continuous = normalized; discrete ≠ normalized) is solid; the discrete unit outside a
0..100 range is not.
