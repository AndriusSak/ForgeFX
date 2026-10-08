# 0005 — The plain per-pid GET (fn 0x01 sub `01 00`) is dead; `readParams` reads through sub 0x1a

Status: Accepted
Date: 2026-10-08
Owners: maintainer

## Context

`readParams` addressed an effect's parameter values with a per-pid GET — fn `0x01`, sub `01 00`, then
`eid:2×7bit` and `pid:2×7bit` — and decoded a 5×7-bit packed float32 at body byte 12.

Measured on a real FM3 (firmware **13.0**, 2026-10-08), the device does **not** answer this op with the
value. It answers with a **canned compiled-record template** — byte-identical bar the echoed address
(bytes 8-11) and the checksum:

```
GETDUMP eid=1 pid=0 raw= f0 00 01 74 11 01 01 00 01 00 00 00 20 74 00 00 00 00 00 38 00 00 40 ...
GETDUMP eid=1 pid=1 raw= f0 00 01 74 11 01 01 00 01 00 01 00 20 74 00 00 00 00 00 38 00 00 40 ...
```

The value field (bytes 12-16) is the constant septets `20 74 00 00 00` → bits `0x00003A20` → the
denormal **2.0851321149153278e-41**, which at four places prints as **`0.0000`**. Every pid returns the
same shape. The same garbage happens for a REAL block, not just a virtual/GLOBAL eid: cab `eid 62,
pid 25` decodes to `5.94e-43`, while the fn=0x1F **bulk** read of that block returns a sensible `1`.
So this op is not merely wrong for a virtual/GLOBAL eid — it is unusable on this firmware generally.

This is the leading suspect for a real incident: a probe read `GLOBAL_FS_BRIGHTNESS` through this path,
got `2.085e-41` (shown `0.0000`), took it as the original value and "restored" that 0 — which turned
the user's footswitch LED-ring brightness **off**. (`docs/decisions/0004` had to caveat that its bulk
fix was a *suspect*, not confirmed, precisely because this read path was still unverified.)

Structurally this is expected: sub `01 00` is the **FC config-selector** read (see `fcReadSwitch`,
which addresses by a single 14-bit selector and gets an 87-byte compiled snapshot). `readParams` had
re-used that opcode with an `eid`+`pid` address, so the device read the `eid` field as a selector and
served the compiled record — ignoring the pid. The opcode's *value* channel for a real param pid is
sub `0x1a` (normalized) / `0x1b` (raw ordinal), which the codebase already documented.

## Decision

**`readParams` no longer sends sub `01 00`. It reads through the sub-0x1a range op** — the opcode
FM3-Edit uses, which addresses by `(eid, pid)` and returns the value. Its contract is therefore a
**NORMALIZED 0..1** value (the device's own wire fraction), **not** a raw 16-bit count; a caller that
needs a raw count must use the fn=0x1F bulk read. This unit change is explicit in code, the driver
interface (`types.ts`), and the route comments.

That change alone would still trust whatever the 0x1a op returns, so the decode is also **guarded**: a
value that could not be a param — non-finite, or **subnormal** (`0 < |v| < 2^-126`) — is refused and
the pid is **omitted** from the result, never fabricated. The canned template's `20 74 00 00 00` is
subnormal, so even if a future firmware (or a mis-headed reply) delivers it, no caller sees a number.
A genuine wire `0.0` is *not* subnormal and passes through — the guard must not mistrust a real zero.

## Alternatives

- **Return the denormal as before.** Rejected: it is the defect, and it reads as a plausible `0.0000`.
- **Throw for the whole op (route → 503).** Rejected *as the primary fix*: a correct per-pid read
  exists (sub 0x1a), so the honest-and-useful move is to return the correct value, not to refuse a
  read the device can actually serve. (The guard still yields an explicit absence — omission → an
  empty/partial map — when the device genuinely cannot answer a pid, which is the "fail explicitly"
  floor.)
- **Route through the fn=0x1F bulk read.** Rejected: the bulk body is a whole-BLOCK read (it is
  pid-indexed — ADR-0004 refuted the old "non-positional" premise — but it returns the entire eid's body),
  so using it to answer a single `(eid, pid)` request is the wrong tool: it is the right path for a
  *block-wide* read, not a per-pid one.
- **Detect the canned template by exact byte compare.** Rejected: brittle (firmware-specific
  checksum/tail), and the subnormal guard is a strictly stronger, shape-based test.

## Consequences

- `readParams` and `readRange` are now the same read (sub 0x1a, normalized); `POST
  /preset/blocks/:eid/read` and `.../readrange` are equivalent. Kept as separate routes for their
  distinct callers/documents.
- The device-probe runbook's Q1 (`GLOBAL_FS_BRIGHTNESS`) reads via the corrected path; its restore
  honesty (same-path read-back → not independently confirmed) is unchanged, and it can no longer
  "restore" a fabricated 0. On a real unit, if 0x1a does not resolve a GLOBAL pid, Q1 is indeterminate
  by construction — the correct outcome, since no read of that param is proven.
- Tests: `drivers/get-path` uses the REAL captured frames as fixtures, proves the old decode yields
  the `0.0000` denormal, and proves the new behaviour (sub 0x1a read, subnormal/non-finite refused,
  genuine zero kept, route never emits a denormal).

## Open question — needs device access

Whether sub `0x1a` resolves a GLOBAL pid (eid 1, pid 7115) correctly on fw13 is **not** established here
— only that it is the documented value opcode and that a garbage reply is refused. Confirming it needs one
live read of `GLOBAL_FS_BRIGHTNESS` via `POST /preset/blocks/1/read`, checked against the independent
fn=0x1F bulk body (`body[7115]`, per `docs/decisions/0004`) rather than a same-path read-back, which is out
of scope for an offline change.
