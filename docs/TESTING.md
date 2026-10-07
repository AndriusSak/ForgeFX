# Device test checklist (driver-migration builds)

This build migrates ForgeFX to a per-device driver architecture on the `forgefx-midi`
codec package and a unified, capabilities-driven HTTP API (v2). The FM3 path was
regression-verified against live hardware at every step; **AM4, FM9, and Axe-Fx III
need hands-on verification** of the flows below. Everything listed is expected to
work — anything that doesn't is a bug in the migration, please report it.

## How to report

- Note the device, firmware version, and the exact step that failed.
- `GET http://localhost:5056/diag` returns the connection diagnostic — include it in reports.
  (The deprecated `/am4/*` aliases and their hit counter have been removed; every client
  must use the unified routes.)
- The in-app debug report (telemetry upload) bundles the server log + diag.

## Every device — connection & identity

- [ ] Auto-detect finds the unit (USB): correct model name shows in the connection bar.
- [ ] `Connection & Device` manual override works, and clearing it returns to auto.
- [ ] Reconnect after unplugging/replugging the USB cable recovers without a restart.
- [ ] (Windows, Axe-Fx III/FM9) detection works over USB-MIDI — this was the
      long-standing "device offline" bug; it is fixed and regression-tested, verify once.

## FM3 (regression baseline — spot-check only)

- [ ] Grid loads and matches the front panel; place/move/clear a block; draw/remove a cable.
- [ ] Open amp block: knob drag is audible, values match FM3-Edit; bypass/channel/type switch.
- [ ] Scenes: switch, rename; preset: select, rename, save to slot.
- [ ] Tuner streams; tempo set/tap; output meters + CPU move.
- [ ] FC editor (Footswitches): live per-switch view still works (tap/hold, labels, colors).
- [ ] Backup preset → version history → load (audition) → restore to slot.
- [ ] Library deep scan + search still works.

## FM9

- [ ] All of: grid load/edit, block params read/write, bypass/channel/type, scenes,
      preset select/save, tempo/tap, tuner, meters/CPU (same expectations as FM3).
- [ ] **NEW — FC editor**: opens with a Layout (1–8 + Master) × 12-switch grid.
      *No* live read-back (writes are "blind"): set a **tap category** on a spare
      layout's switch, then confirm on the unit's own FC setup screen that it landed
      on the right switch. Please test at least: category, function number, display
      mode, and one params value. If the category names in the dropdown don't match
      what the unit shows, report the mismatch pairs — the ordinal vocabulary is
      FM3-verified and assumed shared; FM9 confirmation is exactly what we need.
- [ ] Modifier flyout on a knob: model loads, bind works, curve edits apply.

## Axe-Fx III

- [ ] Same core flows as FM9 (grid, params, scenes, presets, tempo, tuner, meters).
- [ ] **NEW — FC editor (flat mode)**: a config number picker (0–107) instead of a
      layout grid (the III's layout decomposition isn't decoded yet). Pick a config,
      write a tap category ordinal, and check which physical switch/layout it lands
      on — please note the mapping you observe (config № → layout/switch), that data
      lets us build the full grid UI later.
- [ ] Larger grid (6×14) renders and edits correctly; 280+ amp models list in the type picker.

## AM4

Everything runs through the same unified routes as the other devices (the deprecated
AM4-only alias paths have been removed).

- [ ] 4-slot chain renders; block tiles show correct names/types.
- [ ] Knob drag writes params (continuous + stepped); bypass toggles.
- [ ] Scene switch (1–4); preset load + save shows **bank codes (A01…Z04)** in the
      save dialog and toasts.
- [ ] Library: preset name scan builds the list (104 locations, no deep scan).
- [ ] **Device Tools** (toolbar): backup preset → downloads a `.syx`; restore a `.syx`;
      offline decode of a `.syx` (single dump and full bank); firmware file validation;
      modifier model view (read-only — binding is not wired for AM4 yet, by design).
- [ ] Confirm NO meters/tuner/tempo UI appears (the device doesn't support them —
      their absence is correct, their presence is a bug).

## Cross-checks (nice to have)

- [ ] Remote control (Axis Cloud): live param edits + scene/preset changes relay;
      saving to a slot is (correctly) refused remotely.
- [ ] Two windows on one host stay in sync (SSE) for scene/tempo/grid changes.

## Open hardware questions — one-command probe

The five FM3 questions that prose scattered across the review docs (cached read-back of a
GLOBAL write, a Cab 2 Mute/Solo write, whether a 16-bit-scaled enum wire value like
`PHASER_ORDER` ever arrives, whether a complete bulk read ever pads past the `0x74` itemCount,
and how the device answers a write to an *unknown* effect id) are now a single command:
`npx tsx scripts/probe-device.ts` — **read-only by default**; add `--writes` for the three
mutating probes. `--mock` runs the whole runbook against a built-in scripted FM3 with no
hardware, which is also what `test/drivers/device-probe-runbook.test.ts` drives.

Mutating probes are safe and *honest* about what they can and cannot prove:

- Q1 (GLOBAL write) and Q2 (Cab 2 Mute) capture the original, write, read back, then restore and
  read back again. The restore's read-back uses the **same** path that read the original, so it
  cannot catch an original that was misread — the report prints an `UNPROVEN-RESTORE` block and
  never a bare "verified"; it also lists, per mutating probe, the on-unit check a human should
  perform. If the captured original sits on an off/disabled boundary (0 on a `0..100`
  brightness/level param), Q1 **refuses to write** and flags the hazard loudly rather than
  "restoring" a possible misread 0.
- Q5 sends a deliberately invalid write (unknown eid, changes nothing) and reports one of three
  mutually-exclusive outcomes: **refused** (a `0x64` arrived — with the latency measured to that
  frame), **accepted** (a non-`0x64` reply arrived), or **silent** (nothing arrived — the real
  FM3 behaviour; no latency is fabricated).
- `--writes --dry-run` runs only the READ half of the mutating probes, prints exactly what it
  WOULD write/restore (param + eid/pid + original + boundary flag) and writes **nothing**.

A connection that cannot yield a usable device is named precisely — which of three classes
(`no ports enumerated` / `port present but not openable`, with the errno / `openable but
unresponsive`) plus the port and errno — so a permission error on `/dev/ttyACM0` is never
confused with an absent device. Exit 0 = every *eligible* probe gave a definite verdict; 2 = a
probe could not determine; 3 = nothing was attempted (no device); 4 = `--dry-run` (a plan was
printed, nothing was written). A silent pass is impossible. The script itself is the runbook;
this is only a pointer.
