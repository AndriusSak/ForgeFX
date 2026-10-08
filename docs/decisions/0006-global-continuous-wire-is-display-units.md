# 0006 — GLOBAL's continuous wire value is DISPLAY units; the fact lives in the catalogue, not the driver

Status: Accepted
Date: 2026-10-08
Owners: maintainer

## Context

The gen-3 CONTINUOUS SET (fn `0x01`, sub `52 00`) rides `float32(normalized)` with
`normalized ∈ [0,1]`, and the device maps that fraction through the param's display range. The
client's currency is `norm` uniformly: `ControlSurface.svelte:664` clamps to 0..1 and
`editor.setParam(p, norm)` reaches `forgefx.setParam(eid, pid, norm, continuous)`. That contract is
reaffirmed and stays.

Measured on a real FM3 (firmware **13.0**, 2026-10-08) with the fn=0x1F bulk body as the panel
oracle, the **GLOBAL** family does not obey that contract:

```
setParam(1, 7115, 70)   → panel 70%   (body[7115] = 45874 ≈ 0.700 · 65534)
setParam(1, 7115, 0.70) → panel 0.7%  (body[7115] = 459   ≈ 0.007 · 65534)
```

The float the device receives **is the display value**, not a 0..1 fraction. So every GLOBAL
continuous write from the UI — brightness (`7115`), contrast (`7116`) and the FC/CS numeric knobs —
lands ~100x too small. Enums are unaffected: they send ordinals on the DISCRETE path (`09 00`).
Reads are already correct: the fn=0x1F body serves the panel's own values (the same measurement read
70 / 50 / 100 back), so only the write path is wrong.

The display range is device-true and known: `ranges.generated.ts` gives `GLOBAL/7115` and `GLOBAL/7116`
as `displayMin 0, displayMax 100`, and the body's raw `65534 == 100%`.

## Decision

We will make the wire-unit semantics **a catalogue fact**, and have the driver honour it on the
**continuous write path only**:

- **forgefx-midi** (hand-maintained `src/gen3/fm3/params.ts`) exports
  `FM3_DISPLAY_UNIT_FAMILIES` (a family-level `ReadonlySet<string>`, today `{'GLOBAL'}`) plus the total
  predicate `fm3WireUnitsAreDisplay(family)`. A marked family's continuous wire value is in DISPLAY
  units; the caller converts `norm` → display via the param's device-true range
  (`display = displayMin + norm · (displayMax − displayMin)`). The measured evidence and date live in
  the export's doc-comment.
- **ForgeFX** (`server/src/drivers/gen3.ts`) converts `norm` → display in `setParam`'s
  `continuous: true` branch, and only for the FM3 model byte (`0x11`) — FM9/III are unmeasured and must
  keep the default 0..1 wire. Every other family stays **byte-identical**. The `param` event still
  broadcasts the 0..1 `norm`, so the wire conversion is invisible to other windows.
- The lookup is **total**: an unknown model, family, pid, or a non-float / zero-width range returns the
  `norm` unchanged — exactly the pre-existing behaviour, never a throw.

The marker is a **family-level set**, not a per-row field, because the quirk is a family property
(the whole GLOBAL continuous family), and the alternative would touch ~100 rows plus the shared
`Param` type and the generated JSON catalog.

`unit: 'unverified'` on `7115`/`7116` is **left as-is** and the reason is recorded: what is measured
is the *wire semantics* and the *display range* (0..100), not the display-unit *label* ('percent' vs a
plain 0..100 count). Changing the field is also not an additive change. The measured facts are carried
by the new marker's doc-comment instead.

## Alternatives

- **Convert in the driver, keyed on the family name hard-coded in `gen3.ts`.** Rejected: the next
  family with the same quirk becomes a code change, not a data change. The user chose the permanent
  shape — the fact belongs with the catalogue data.
- **A per-row `Param` field (e.g. `wireUnits: 'display'`).** Rejected: it needs the shared `Param` type
  edited, ~100 GLOBAL rows tagged, and the generated JSON catalog (`catalog/fm3.json`) regenerated; the
  property is family-wide, so a family-level set is the smaller, more honest shape.
- **Put it in `ranges.generated.ts` / `enumOverrides.ts`.** Not available: those are GENERATED, and
  their generator is maintained **outside this package** — only the derived DATA ships here. They
  cannot carry a hand-authored marker.
- **Fix it in the Axis client (send display units for GLOBAL).** Rejected: it breaks the uniform
  `norm` contract the client is built on and spreads device quirks into the UI.
- **Mark the whole GLOBAL family and convert using each param's own range.** Chosen: it is the faithful
  reading of "the family takes display units". Only the percent knobs (7115/7116/110) are measured; the
  rest of the family is converted through its own range and flagged unverified.

## Consequences

- The UI's GLOBAL writes now land at the intended level (brightness 0.7 → 70%, not 0.7%).
- The next family with the same quirk is a **one-line data change** in `FM3_DISPLAY_UNIT_FAMILIES`
  (plus its evidence in the doc-comment), no driver change.
- **Honest limitation:** the marker cannot live in the generated catalog yet. The upstream generator
  (outside this package) should eventually emit the display-unit fact alongside `ranges.generated.ts`
  so the generated JSON catalog carries it for non-TypeScript consumers; until then it lives only in
  the hand-maintained `params.ts` and is **not** in `catalog/fm3.json`.
- Tests: `forgefx-midi` gains `fm3/wire-units` (marker shape + the 0..100 range the conversion relies
  on); ForgeFX gains `drivers/gen3-global-wire-units`, which asserts at the FRAME level that a marked
  param written with norm `0.7` carries display `70`, an unmarked family is byte-identical to the
  pre-change frame, a non-FM3 device is unchanged, the lookup is total, the discrete path is untouched,
  and a write→read round-trip agrees on the display value (raw `45874`). `drivers/device-probe-runbook`
  and the Q1 scripted device were updated to model the display-unit wire.
- `scripts/verify-global-write.ts` now sends `norm` like every other caller (it sent display units
  before, which after this change would be 100x too large) and prints both the norm it sent and the
  display % expected.

## Still unverified

- Whether the *rest* of the GLOBAL family (EQ gains, offsets, remaining FC/CS numeric knobs) behaves
  identically to the measured percent knobs — marked by family, measured only for 7115/7116/110.
- The display-unit **label** for 7115/7116 ('percent' vs plain count); the `unit` tag stays `unverified`.
- Whether FM9/III GLOBAL behaves the same. They are deliberately **not** marked until measured.
