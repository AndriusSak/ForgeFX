# Per-block audio monitors (FM3)

Measured 2026-10-29 on an FM3 (fw 13.0, preset 408 "80s test", 10 placed blocks) with
`GET /preset/monitors/live?eid=<n>`; each row is one `fn 0x01 sub 0x19` read of
`(effectId, monitorPid)`, values are a normalised 0..1 float mapped to dB by the profile's
monitor table (`FM3_MONITOR_PARAMS`).

| Block   | eid | rows | monitors |
|---------|-----|------|----------|
| Input 1 | 37  | 1 | `INPUT_GAINMONITOR` (level) |
| Comp 1  | 46  | 1 | `COMP_GAINMONITOR` (gain reduction) |
| Amp 1   | 58  | 3 | `DISTORT_GAINMON` (level), `DISTORT_VCCMON` (supply), `DISTORT_VPLATEMON` (headroom) |
| Cab 1   | 62  | 2 | `CABINET_GAINMONITOR` (level), `CABINET_VUMETER` (vu) |
| Output 1| 42  | 2 | `OUTPUT_VUL`, `OUTPUT_VUR` (vu) |
| PEQ 1, PEQ 2, Chorus 1, Delay 1, Reverb 1 | 54, 55, 78, 70, 66 | **0** | — |

**A zero is the device's answer, not a failure of the poll.** These families carry no monitor
parameter in the FM3 profile, so no level can exist for those tiles. The UI must not imply otherwise:
a tile with no monitor shows no fill, and the open block's row count (`meters N · eid X`) is the honest
indicator.

Model families that do report (per the profile table): INPUT, OUTPUT, COMP, MULTICOMP, GATE, FILTER,
DISTORT, CABINET, VOLUME, CONTROLLERS.

## Cost

Each row is one serial round-trip (~1–3 ms on USB). Polling every placed block at UI rate is what
flooded the link and dropped audio; Axis polls the open block at ~250 ms and walks the remaining blocks
**one per tick** (round-robin), so a whole grid refreshes every few seconds without a full sweep.
