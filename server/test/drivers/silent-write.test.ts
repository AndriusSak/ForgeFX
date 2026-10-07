// SILENT-WRITE semantics of the gen-3 discrete-write confirmation path (gen3.ts `#write`).
//
// FINDING (P8) — a silently-ignored device write is reported to the client as SUCCESS.
//
// Measured against a real FM3 (scripts/probe-device.ts --writes, Q5): a write to an unknown eid
// (0x3ffe = 16382) draws NO reply at all — the FM3 SILENTLY IGNORES it rather than refusing it
// with a 0x64. And on a legitimate ACCEPT the device is also silent (docs/write-protocol.md:
// "The device sends nothing on accept"). So an accepted write and a silently-ignored write are
// BYTE-IDENTICAL on the wire, and `#write` maps both to `{ ok: true }`:
//
//   wire seen by `#write`                →  returned `{ok}`   →  HTTP status (runtime/handlers.ts)
//   ────────────────────────────────────────────────────────────────────────────────────────────
//   a 0x64 whose body echoes our fn       →  { ok: false }     →  200 {ok:false}   (explicit reject)
//   silence (accept OR silent-ignore)     →  { ok: true }      →  200 {ok:true}    (reported accepted)
//
// The client (Axis `paramWriteOutcome.ts`) reads `{ok:true}` as `status:'ok'` and KEEPS the
// optimistic value on screen with no toast. So a device write it silently ignored is surfaced as
// an accepted, applied edit — the exact defect this suite pins.
//
// The same is true a fortiori for the fire-and-forget ops (`#send` → sendQueued): they collect no
// reply AT ALL, so their verdict is `{ok:true}` unconditionally (setScene, tapTempo, selectCell,
// setTempo, a continuous knob stream).
//
// This suite LOCKS the current semantics so they cannot drift silently. It does NOT change any
// behaviour: there is no signal that distinguishes an accept from a silent-ignore (both are
// silence), so mapping silence → {ok:false} would break EVERY write. The honest remediation is
// read-back verification for the writes that matter — see docs/write-protocol.md
// "Residual: silently-ignored writes".
//
// Mocked transport + the REAL static FM3 profile: no hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import type { RequestOpts } from '../../src/transport/types.js';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const BOGUS_EID = 0x3ffe; // 16382 — the probe's deliberately-invalid eid (unknown to the FM3)
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page; // a real placed instance

export const SILENT_WRITE_CASE_COUNT = 16;

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** MockTransport that counts WHICH transport primitive each op used. The suite needs this because
 *  `#send` (fire-and-forget) is observably different from `#write` (reject-watched) ONLY in the
 *  primitive it calls — sendQueued vs request — and `#send` never consults `reply`, so a reply-scripted
 *  assertion alone cannot fail. Counting the primitive makes the fire-and-forget claim falsifiable. */
class SpyTransport extends MockTransport {
  requestN = 0;
  queuedN = 0;
  pacedN = 0;
  sendN = 0;
  async request(bytes: readonly number[], opts?: RequestOpts): Promise<number[][]> {
    this.requestN += 1;
    return super.request(bytes, opts);
  }
  async sendQueued(bytes: readonly number[], settle?: number): Promise<void> {
    this.queuedN += 1;
    return super.sendQueued(bytes, settle);
  }
  async sendPaced(bytes: readonly number[], chunk?: number, delay?: number): Promise<void> {
    this.pacedN += 1;
    return super.sendPaced(bytes, chunk, delay);
  }
  send(bytes: readonly number[]): void {
    this.sendN += 1;
    super.send(bytes);
  }
}

/** A driver over a spy mock whose reply script is `reply` (default: silence — the device says nothing). */
function gen3(reply: (bytes: readonly number[]) => number[][] = () => []) {
  const mock = new SpyTransport('serial', 'mock-silent-write');
  mock.isOpen = true;
  mock.reply = reply;
  const driver = createGen3Driver(PROFILES[MODEL]!, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(MODEL, 'balanced')
  });
  return { driver, mock };
}

/** Every gen-3 write op that routes through `#write` (the reject-watched path), over one silent device. */
async function everyWatchedWriteUnderSilence(): Promise<Array<{ op: string; ok: boolean }>> {
  const out: Array<{ op: string; ok: boolean }> = [];
  { const { driver } = gen3(); out.push({ op: 'setParam(discrete)', ok: (await driver.setParam(AMP_EID, 16, 16, false)).ok }); }
  { const { driver } = gen3(); out.push({ op: 'setType', ok: (await driver.setType(AMP_EID, 0)).ok }); }
  { const { driver } = gen3(); out.push({ op: 'setBypass', ok: (await driver.setBypass(AMP_EID, true)).ok }); }
  { const { driver } = gen3(); out.push({ op: 'setChannel', ok: (await driver.setChannel(AMP_EID, 'B')).ok }); }
  { const { driver } = gen3(); out.push({ op: 'setSceneName', ok: (await driver.setSceneName(0, 'S')).ok }); }
  { const { driver } = gen3(); out.push({ op: 'setPresetName', ok: (await driver.setPresetName('P')).ok }); }
  { const { driver } = gen3(); out.push({ op: 'placeCell', ok: (await driver.placeCell(1, 1, AMP_EID)).ok }); }
  { const { driver } = gen3(); out.push({ op: 'cable', ok: (await driver.cable(1, 1, 2, true)).ok }); }
  { const { driver } = gen3(); out.push({ op: 'selectPreset', ok: (await driver.selectPreset(1)).ok }); }
  { const { driver } = gen3(); out.push({ op: 'store', ok: (await driver.store(1)).ok }); }
  return out;
}

export async function runSilentWriteTests(): Promise<void> {
  // ── 1. THE FINDING. A write the device SILENTLY IGNORES (unknown eid, no reply — the probe's
  //       observed FM3 behaviour) comes back {ok:true}: reported to the client as accepted. ────────
  {
    const { driver } = gen3(() => []); // the FM3 says nothing to a bogus-eid write
    const r = await driver.setParam(BOGUS_EID, 0, 0, false);
    assert(r.ok, 'a silently-ignored write (no reply) is reported {ok:true} — the pinned defect');
  }

  // 2. CONTRAST. The SAME write draws a 0x64 rejection → {ok:false}. Only a reply (never silence)
  //    can produce a non-accepted verdict.
  {
    const { driver } = gen3((req) => [sysex(0x64, [req[5]!, 0x05])]); // fn echoed, code 0x05 = invalid eid
    const r = await driver.setParam(BOGUS_EID, 0, 0, false);
    assert(!r.ok, 'a 0x64 echoing our fn is an explicit reject — {ok:false}');
  }

  // 3. THE ONLY WIRE SIGNAL IS THE 0x64. The verdict is a function of exactly one thing — whether a
  //    0x64 echoing our fn replies — so a device that stays silent (an ACCEPT and a silent-IGNORE are
  //    both silence, hence byte-identical and inseparable by device identity) AND a device that replies
  //    with an unrelated NON-0x64 frame both map to {ok:true}; only a matching 0x64 flips it to
  //    {ok:false}. Each row is a DIFFERENT reply script, so this can fail: if the driver ever treated a
  //    non-0x64 reply as a rejection, `chatty` would go {ok:false}; if it stopped honouring 0x64,
  //    `reject` would go {ok:true}. (The old form compared two IDENTICAL silent mocks — a tautology.)
  {
    const silent = gen3(() => []); // accept OR silent-ignore — indistinguishable, both silence
    const chatty = gen3(() => [sysex(0x0c, [0x00])]); // a benign unrelated reply (e.g. a scene echo)
    const reject = gen3((req) => [sysex(0x64, [req[5]!, 0x05])]); // our own fn echoed in a 0x64
    const rs = await silent.driver.setParam(BOGUS_EID, 0, 0, false);
    const rc = await chatty.driver.setParam(BOGUS_EID, 0, 0, false);
    const rr = await reject.driver.setParam(BOGUS_EID, 0, 0, false);
    assert(rs.ok, 'silence (accept = silent-ignore) → {ok:true}');
    assert(rc.ok, 'an unrelated NON-0x64 reply is NOT a rejection → {ok:true}');
    assert(!rr.ok, 'a 0x64 echoing our fn is the ONE signal that flips the verdict → {ok:false}');
    assertEqual(
      silent.mock.sent[0]!.join(','),
      chatty.mock.sent[0]!.join(','),
      'the outgoing request is byte-identical whether the device stays silent or replies — no reply-driven resend'
    );
  }

  // 4. THE WHOLE WATCHED SURFACE under silence → {ok:true}. Every op that reject-watches reports an
  //    accepted write when the device is silent (accept or silent-ignore alike).
  {
    const results = await everyWatchedWriteUnderSilence();
    assertEqual(results.length, 10, 'all ten #write-routed ops were exercised');
    for (const { op, ok } of results) assert(ok, `${op}: silence ⇒ {ok:true}`);
  }

  // 5. setScene is FIRE-AND-FORGET (gen3.ts setScene → #send → sendQueued): it does not watch for a
  //    0x64 at all, so a device refusal there is unreportable — the verdict is {ok:true} regardless.
  //    Pinned so a future "route scene through #write" change is a deliberate one. The reply script is a
  //    matching 0x64 that WOULD reject a `#write`; since #send never reads it, the only thing that makes
  //    this non-vacuous is asserting the PRIMITIVE: it went out via sendQueued with ZERO request() calls
  //    (a request() path would both flip `r.ok` to false and show requestN ≥ 1 → this fails).
  {
    const { driver, mock } = gen3(() => [sysex(0x64, [0x01, 0x05])]); // a reject a #write would catch
    const r = await driver.setScene(0);
    assert(r.ok, 'setScene uses #send — it never collects a reply, so its verdict is always {ok:true}');
    assert(mock.queuedN >= 1, 'setScene actually went out via #send → sendQueued');
    assertEqual(mock.requestN, 0, 'setScene issued NO request() — so no 0x64 could ever reach it');
  }

  // 6. The continuous knob path is fire-and-forget BY DESIGN (gen3.ts setParam continuous → #send):
  //    silence (the only possible reply for a fire-and-forget write) → {ok:true}. Same primitive pin as
  //    case 5 so the fire-and-forget claim is falsifiable rather than an always-true reply-blind assert.
  {
    const { driver, mock } = gen3(() => []);
    const r = await driver.setParam(AMP_EID, 1, 0.5, true);
    assert(r.ok, 'a continuous setParam (#send) is fire-and-forget — {ok:true}');
    assert(mock.queuedN >= 1, 'continuous setParam went out via #send → sendQueued');
    assertEqual(mock.requestN, 0, 'continuous setParam issued NO request() — no reply is ever collected');
  }
}
