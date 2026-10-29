# Write protocol (gen-3)

How ForgeFX writes to the device: parameter edits, bypass/channel, grid editing,
preset switch/store. Implemented in `Fm3Device` (pure body builders + send/verify) and
exposed by the server's write endpoints. Frames are the gen-3 family ops; the FM3 shapes
below are byte-confirmed against FM3-Edit captures (via the mcp-midi-control codec — see
`NOTICE`). Everything is little-endian 7-bit; the envelope is the usual
`F0 00 01 74 11 <fn> <body> <cksum> F7`.

## Ops

| Write | Wire | Body |
|-------|------|------|
| Set param (knob) | fn `0x01` sub `0x52 00` | `eid14 pid14 float32(normalized 0..1) 00 00 00 00` |
| Set param (model/type) | fn `0x01` sub `0x09 00` | `eid14 pid14 float32(ordinal) 00 00 00 00` |
| Bypass | fn `0x0A` | `eid14 dd` (dd: 1=bypassed) |
| Channel | fn `0x0B` | `eid14 ch` (0..3 = A..D) |
| Place/clear block | fn `0x01` sub `0x32` | `blockId14 00 00 gridPos14 …` · `gridPos=(col-1)*rows+(row-1)`, FM3 rows=4 · blockId 0 clears |
| Cable | fn `0x01` sub `0x35` | FM3 4-row: `b21=srcGp>>1`, `b22=((srcGp&1)<<6)\|srcCol`, `b23=(destRow-1)<<5` · `srcGp=(srcCol-1)*4+(srcRow-1)` |
| Switch preset | fn `0x01` sub `0x27` | `preset14 @ pos 6` |
| Store preset | fn `0x01` sub `0x26` | `preset14 @ pos 6` |

`eid` = effect id (the block's base id + instance-1). `pid` = parameter index. The value is a
5-septet float32 — for a knob it's the normalized 0..1 value; for a model/type select it's the
roster ordinal as a float.

## Accept / reject model

The device sends **nothing on accept**. On rejection it returns a `0x64` MULTIPURPOSE_RESPONSE
whose 2-byte body is `[echoedFn, resultCode]`. `Fm3Device.SendWrite` sends a frame and watches a
short window for a `0x64` rejection of the function it sent; no rejection ⇒ accepted. Result
codes (`DescribeResultCode`) include `0x05` invalid effect id, `0x06` invalid param id, `0x0b`
bad grid position, `0x0c` DSP overload, etc.

### Residual: silently-ignored writes (P8)

The accept/reject model above assumes the device *refuses* a bad write with a `0x64`. Measured
against a real FM3 (`scripts/probe-device.ts --writes`, Q5): a write to an unknown eid
(`0x3ffe` = 16382) draws **no reply at all** — the FM3 silently IGNORES it rather than refusing
it. Since an accepted write is ALSO silent, an accepted write and a silently-ignored write are
**byte-identical on the wire** and `#write` (`src/drivers/gen3.ts`) maps both to `{ok:true}`:

| wire seen by the driver | returned `{ok}` | HTTP (`src/runtime/handlers.ts`) |
|---|---|---|
| `0x64` echoing our fn | `{ok:false}` | `200 {ok:false}` (explicit reject) |
| silence (accept **or** silent-ignore) | `{ok:true}` | `200 {ok:true}` (reported accepted) |

The client (Axis `paramWriteOutcome.ts`) reads `{ok:true}` as accepted and keeps the optimistic
value on screen. So a write the device silently ignored is surfaced to the user as applied.

**There is no distinct signal that separates accept from silent-ignore** — both are silence, on
both directions of the wire. Mapping silence → `{ok:false}` would therefore break EVERY write
(every accepted write would be reported as rejected). The current mapping is left UNCHANGED, and
`server/test/drivers/silent-write.test.ts` PINS it so it cannot drift silently.

The honest remediation is **read-back verification scoped to the writes that matter**, not a
blanket verdict change — this needs a genuine independent read, since a value read back
immediately after a write can reflect our own write rather than the device's persisted state:

- **Verify (independent read-back).** Parameter writes that change PERSISTED global state —
  the `GLOBAL` block params (e.g. `GLOBAL_FS_BRIGHTNESS` 7115, `GLOBAL_FS_LCD_CONTRAST`,
  the `GLOBAL_FC_DEFAULT_LAYOUT_*` set) — and other structural/persisted writes where a silent
  no-op is harmful and low-frequency: `store`, `placeCell`/`cable`, `setPresetName`/`setSceneName`.
  Cost: one extra GET per write (the probe's Q1/Q2 read-back pattern). Scope it to these; the
  server write path currently does NO verification for ANY write (`setParamH` → `d.setParam`
  returns the driver verdict directly; see `src/runtime/handlers.ts`).
- **Leave fire-and-forget.** High-frequency continuous knob streams (`setParam(..., continuous)`
  → `#send`), `tapTempo`, `selectCell`, `setTempo` — a read-back per frame would double the traffic
  on the hot path for no benefit.

A continuous write is the worst case for this residual: `#send` collects no reply at all, so its
verdict is `{ok:true}` unconditionally — a `GLOBAL_FS_BRIGHTNESS` write sent with
`continuous:true` (as the Axis client sends float globals) has no confirmation whatsoever.

## Safety

- **`?dryRun=true`** on any write endpoint returns the exact frame hex **without sending** —
  use it to preview/verify before touching the device.
- **`--writes false`** starts the server read-only; every write endpoint then returns `403`.
- **Store is live-verified on the FM3 (2026-10-29) but stays beta.** Measured on an FM3:
  `POST /preset/store` to slot 408 drew the unit's own echo `F0 00 01 74 11 01 26 ...` **1,402 ms**
  after the request, and the edit-buffer body read back unchanged. The acknowledgement is slow — a
  fixed 250 ms window misses it, so the driver now waits for the echo and only reports a rejection on
  a real `0x64`. Persistence across a power cycle is still unmeasured. ForgeFX never auto-saves during
  navigation.

## Confidence

Set param (continuous + typed), bypass, switch-preset, and the FM3 4-row cable formula are
FM3-hardware-confirmed (per the source captures). Grid block placement (sub `0x32`) and store
(sub `0x26`) are spec/capture-derived but **not yet confirmed on this project's FM3** — treat
them as beta and verify with `dryRun` + a single live test first. Tracked in
[#4](https://github.com/sKuhLight/ForgeFX/issues/4).
