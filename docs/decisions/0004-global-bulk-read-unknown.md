# 0004 — Non-positional families (GLOBAL) are served UNKNOWN, not fabricated

Status: Accepted
Date: 2026-10-07
Owners: maintainer

## Context

`blockParams` reads a placed block via the fn=0x1F whole-block bulk read. The reply is a 0x74 head
(blockId + advertised itemCount), N paged 0x75 bodies and a 0x76 end; `assembleGen3BlockBulkRead`
reconstructs them as a POSITIONAL array where `values[i]` is *the param whose device-true paramId is
i*. `blockParams` then resolves each catalog param with `bulk.values[base + p.paramId]`, where
`base = activeChannel * stride` and `stride` is the family's declared fn=0x1F wire stride.

That identity (`record ordinal == paramId`) only holds for a DENSE family — one whose catalog pids
tile `0..stride-1`. The FM3 `GLOBAL` family (virtual effect id 1) is NOT dense: it declares
`stride 186` (`forgefx-midi/src/gen3/fm3/ranges.generated.ts`) yet its catalog carries 173 pids up to
**65522**, 91 of them `>= 186` (`forgefx-midi/src/gen3/fm3/params.ts`). Those pids are device WIRE
ADDRESSES (mined from FM3-Edit's own param tables), not positions in the sealed body.

The read coerced the miss with `?? 0`. Consequences, both real:

- `pid >= stride` ran past the block → `undefined` → **a fabricated 0**. On record: a probe read
  `GLOBAL_FS_BRIGHTNESS` (pid 7115) as `0.0000` on a unit whose footswitch LED rings were visibly ON,
  and a later restore wrote that 0 over the real value. **Attribution caveat:** that probe reads through
  the per-pid GET (`readParams`), not through this bulk path — so this path is the leading SUSPECT, not a
  confirmed cause. (The per-pid GET itself was later measured dead on FM3 fw13 and re-routed through
  the sub-0x1a range op — see `0005-per-pid-get-is-dead.md`.) The defect above stands on its own
  evidence (the fabricated zero is proven by the fixture and the coverage test).
- `pid < stride` resolved to *whatever record shared that ordinal* → a silently **WRONG** value, not
  zero. E.g. `GLOBAL_REVERBMIX` (pid 1) read the record at ordinal 1, which need not be that param.

`layout-param-coverage` could not catch this: it filled its fixture with zeros and asserted only that
the id was in the SERVED set — no value was ever checked, so a fabricated 0 passed vacuously.

## Decision

**Do not index a family the catalog cannot prove is positional.** `blockParams` now detects the case
structurally (`#bulkUnresolvedReason`): if any ordinary (`< 0xff00`) catalog pid of the family reaches
the declared stride, the family is not positional. Its values are served as an explicit **UNKNOWN**:
`value: null`, `norm: null`, and an `unresolved` string naming the cause. `type` is left `null` rather
than a fabricated type 0. The param stays in `named`/`enums` so the device layout still renders its
control (the P1.2 fix) — only the *value* becomes honest.

Shape rationale: the DTO (`NamedParam`/`EnumParam`) now allows `value: number | null`, mirroring the
existing `FcReadState.fields: Record<string, number | null>` convention for an unread field. The
handler serializes `null` straight through, so nothing downstream can turn the unknown into a 0. A
dense family is unchanged (its pids are all `< stride`, so it is never flagged), and the same honesty
now also covers a short body: a record absent from the body is UNKNOWN, never 0.

We did NOT invent a pid→ordinal map: the catalog ships none. `ranges.generated.ts` keys its GLOBAL
table by paramId (`1: {…}, 3598: {…}, 7115: {…}`), not by position, and emits no ordinal/record
metadata; the generator is maintained outside this package. With no evidence for a mapping, refusing
is the only honest option — a wrong number is worse than an absent one.

## Alternatives

- **Keep `?? 0`.** Rejected: the defect.
- **Drop GLOBAL params from the served list with a reason.** Rejected: it re-blanks the GLOBAL page
  (undoing P1.2) and still hides which controls exist.
- **Guess a mapping** (e.g. treat sub-stride pids as ordinals). Rejected: the sub-stride readings are
  demonstrably untrustworthy (they read an unrelated record), so any guess is a silent wrong number.
- **Throw for the whole GLOBAL family (404 + `{error}`).** Rejected here: it is consistent with the
  torn-read throw, but the layout-membership contract needs the ids served; a per-param UNKNOWN keeps
  the controls visible while removing the lie.

## Consequences

- GLOBAL values read `null` + `unresolved` until the mapping is established. Axis should render such a
  control as unknown/—; it must not substitute 0.
- `PRESET` is the only other family the structural test flags, and it has no blockParams effectId, so
  nothing changes for it.
- Tests: `drivers/global-bulk-read` (sparse pid `>= stride` is never 0; a sub-stride pid is never the
  wrong record; dense regression) and a strengthened `drivers/layout-param-coverage` that now fills a
  NON-ZERO fixture and asserts GLOBAL values are UNKNOWN. Both fail on the old code.

## Open question — needs one FM3 device dump (settles the mapping)

The only thing that can establish a real pid→record-ordinal map is a capture of the actual GLOBAL
body. With the FM3 attached (firmware 12.0) and the serial port free:

1. **Capture the GLOBAL bulk body.** Poll `F0 00 01 74 11 1F 01 00 <xor> F7` (fn=0x1F, eid 1) and
   record every reply frame verbatim. From the 0x74 head read the **advertised itemCount**; from the
   0x75 bodies count the **total record count**. Question: is it **186** (one channel), **186×3/×4**
   (multi-channel), or something else entirely? (An eid-1 body structurally unlike a block body would
   by itself rebut the positional model.)
2. **Get ground truth for a few params.** Read specific pids via the per-pid GET
   `F0 00 01 74 11 01 01 00 01 00 <pid:2×7bit LE> 00 00 00 00 00 00 00 00 00 <xor> F7` — the
   `readParams` path (`GET /preset/blocks/1/read`), which addresses by paramId directly and is not
   positional. Read at least `GLOBAL_FS_BRIGHTNESS` (7115), `GLOBAL_REVERBMIX` (1) and
   `GLOBAL_TUNINGREF` (5).
3. **Find each value's index in the body.** Search the captured 0x1F body for each per-pid value; the
   record index where a (distinctive, non-zero) value appears IS that pid's ordinal. Do it for several
   params with distinct values to derive the map, then feed it back to the catalog generator.

Question to answer: **"What is the length of the eid-1 (GLOBAL) 0x75 body, and at which record index
does a known GLOBAL pid (e.g. 7115 Brightness) appear?"** Until that is captured, GLOBAL stays UNKNOWN.
