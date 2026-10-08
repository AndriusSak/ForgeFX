// P13 — the per-pid GET (fn 0x01 sub 01 00) is DEAD on FM3 firmware 13.0: it answers every request
// with the same canned compiled-record template, whose value field (the constant septets
// `20 74 00 00 00` at bytes 12-16) decodes to the denormal 2.085e-41 — printed at four places, 0.0000.
// A probe read GLOBAL_FS_BRIGHTNESS through this path, took that 0.0000 as the original, and
// "restored" it, turning the user's footswitch LED rings off. Measured on a real FM3 for a virtual
// GLOBAL eid AND a real block, so the op is unusable generally.
//
// The fix: `readParams` reads through the sub-0x1a range op (FM3-Edit's opcode, NORMALIZED 0..1) and a
// decoded value that could not be a param — non-finite, or SUBNORMAL — is OMITTED, never served. A
// genuine wire 0.0 is not subnormal and passes through. Mocked transport only; the fixture bytes are
// the REAL captured replies (see CAPTURED_*), not invented.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { pack5Septet32 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';
import { createUnifiedHandlers, type StatusSink } from '../../src/runtime/handlers.js';
import type { DeviceRegistry } from '../../src/drivers/registryCore.js';

const MODEL = 0x11; // FM3

export const GET_PATH_CASE_COUNT = 6;

// The REAL captured per-pid GET replies from a live FM3 (fw 13.0). The captures were hand-truncated
// after byte 22 in the incident report (`... 40 ...`); the bytes shown are verbatim, and they include
// everything this decoder touches: the header/echo (5-11) and the value septets (12-16). Only the
// echoed eid/pid (8-11) and the checksum differ between the two replies.
const CAPTURED_GET_EID1_PID0 = [
  0xf0, 0x00, 0x01, 0x74, 0x11, 0x01, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00,
  0x20, 0x74, 0x00, 0x00, 0x00, 0x00, 0x00, 0x38, 0x00, 0x00, 0x40
];
const CAPTURED_GET_EID1_PID1 = [
  0xf0, 0x00, 0x01, 0x74, 0x11, 0x01, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x20, 0x74, 0x00, 0x00, 0x00, 0x00, 0x00, 0x38, 0x00, 0x00, 0x40
];

/** The pre-fix decode, reproduced verbatim so the defect stands as a regression witness. */
function oldUnpackF32(b: number[]): number {
  const v = ((b[0] ?? 0) | ((b[1] ?? 0) << 7) | ((b[2] ?? 0) << 14) | ((b[3] ?? 0) << 21) | ((b[4] ?? 0) << 28)) >>> 0;
  return new Float32Array(new Uint32Array([v]).buffer)[0]!;
}

const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
const replyEidPid = (f: readonly number[]): { eid: number; pid: number } => ({
  eid: (f[8]! | (f[9]! << 7)),
  pid: (f[10]! | (f[11]! << 7)),
});

/** A range-read reply carrying `value` as a 5-septet float32 at bytes 12-16 (echoes the request header). */
function valueReply(req: readonly number[], value: number): number[] {
  const bits = new Uint32Array(new Float32Array([value]).buffer)[0]!;
  return [...req.slice(0, 12), ...pack5Septet32(bits), 0x00, 0x00, 0x00, 0x00, 0xf7];
}
/** The captured canned template, re-headed as a sub-0x1a reply so it MATCHES a range read. Its value
 *  field is still the constant `20 74 00 00 00` → 2.085e-41. */
function cannedTemplate0x1a(): number[] {
  const f = [...CAPTURED_GET_EID1_PID0];
  f[6] = 0x1a;
  return f;
}
/** The canned template, with the echoed (eid,pid) of an actual request so the range-read match holds. */
function cannedTemplateFor(req: readonly number[]): number[] {
  const f = cannedTemplate0x1a();
  f[8] = req[8]!; f[9] = req[9]!; f[10] = req[10]!; f[11] = req[11]!;
  return f;
}

/** A driver over a mocked transport whose replies are scripted by `reply`. */
function driverWithReply(reply: (req: readonly number[]) => number[][]) {
  const profile = PROFILES[MODEL]!;
  const mock = new MockTransport('serial', 'mock-getpath');
  mock.isOpen = true;
  mock.reply = reply;
  return {
    driver: createGen3Driver(profile, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(MODEL, 'balanced') }),
    mock,
  };
}

class Sink implements StatusSink {
  status: number | undefined;
  code(statusCode: number): unknown { this.status = statusCode; return this; }
}

export async function runGetPathTests(): Promise<void> {
  // ── 1. THE DEFECT: the captured template decodes to a denormal that prints 0.0000 ─────────────────
  const septets = CAPTURED_GET_EID1_PID0.slice(12, 17);
  assertEqual(septets.join(' '), '32 116 0 0 0', 'case 1: the captured value field is the constant 20 74 00 00 00');
  const old = oldUnpackF32(septets);
  assert(old !== 0, 'case 1: the old decode is not zero (so it reads as a real value, not an obvious null)');
  assert(Math.abs(old) < 2 ** -126, 'case 1: the old decode is a SUBNORMAL — no param can be one');
  assert(Math.abs(old - 2.0851321149153278e-41) < 1e-54, `case 1: the old decode is the denormal 2.085e-41 (got ${old})`);
  assertEqual(old.toFixed(4), '0.0000', 'case 1: at four places the denormal prints as 0.0000 — the incident value');

  // ── 2. the two captured replies differ ONLY in the echoed address (and checksum) ──────────────────
  const a = replyEidPid(CAPTURED_GET_EID1_PID0);
  const b = replyEidPid(CAPTURED_GET_EID1_PID1);
  assertEqual(a.pid, 0, 'case 2: first capture echoes pid 0');
  assertEqual(b.pid, 1, 'case 2: second capture echoes pid 1');
  assertEqual(
    CAPTURED_GET_EID1_PID0.slice(12).join(' '),
    CAPTURED_GET_EID1_PID1.slice(12).join(' '),
    'case 2: everything past the echoed address is byte-identical — the payload does not track the pid'
  );

  // ── 3. the read goes out on sub 0x1a (NORMALIZED), not the dead 01 00 op ──────────────────────────
  {
    const EID = 62, PID = 25;
    const { driver, mock } = driverWithReply((req) =>
      req[5] === 0x01 && req[6] === 0x1a ? [valueReply(req, 0.5)] : []);
    const out = await driver.readParams!(EID, [PID]);
    assertEqual(out[PID], 0.5, 'case 3: readParams returns the device value 0.5 (normalized 0..1, not a raw count)');
    const rangeFrames = mock.sent.filter((f) => f[5] === 0x01 && f[6] === 0x1a);
    assert(rangeFrames.length === 1, 'case 3: exactly one sub-0x1a range read was sent');
    const deadFrames = mock.sent.filter((f) => f[5] === 0x01 && f[6] === 0x01 && f[7] === 0x00);
    assertEqual(deadFrames.length, 0, 'case 3: the dead per-pid GET (sub 01 00) is NOT sent any more');
    assertEqual(rangeFrames[0]![10]! | (rangeFrames[0]![11]! << 7), PID, 'case 3: the range read addresses the requested pid');
  }

  // ── 4. a canned/non-value reply to the range read is OMITTED — never served as a denormal ─────────
  {
    const EID = 1, PID = 7115;
    // (a) the real canned template, re-headed as a sub-0x1a reply so it matches a range read.
    const { driver } = driverWithReply((req) =>
      req[5] === 0x01 && req[6] === 0x1a ? [cannedTemplateFor(req)] : []);
    const viaParams = await driver.readParams!(EID, [PID]);
    assert(!(PID in viaParams), 'case 4: readParams OMITS a pid answered with the canned template (no denormal)');
    assertEqual(viaParams[PID], undefined, 'case 4: the pid is absent, not a fabricated number');
    const viaRange = await driver.readRange!(EID, [PID]);
    assert(!(PID in viaRange), 'case 4: readRange omits the same non-value query');
    // (b) a non-finite decode is refused on the same principle.
    const { driver: infDriver } = driverWithReply((req) =>
      req[5] === 0x01 && req[6] === 0x1a ? [valueReply(req, Infinity)] : []);
    const inf = await infDriver.readParams!(EID, [PID]);
    assert(!(PID in inf), 'case 4: a non-finite decode is never returned as a value');
  }

  // ── 5. a GENUINE zero is kept: the guard must not mistrust a real read of 0 ───────────────────────
  {
    const EID = 62, PID = 25;
    const { driver } = driverWithReply((req) =>
      req[5] === 0x01 && req[6] === 0x1a ? [valueReply(req, 0)] : []);
    const out = await driver.readParams!(EID, [PID]);
    assertEqual(out[PID], 0, 'case 5: a real wire 0.0 is served as 0 (not omitted, not mistaken for the template)');
    assert(PID in out, 'case 5: the pid is present');
  }

  // ── 6. the route surfaces the normalized map and never junk ───────────────────────────────────────
  {
    // A driver whose readParams answers the value: the handler passes it straight through.
    const reg = { driver: async () => ({ readParams: async () => ({ 25: 0.5 }) }) } as unknown as DeviceRegistry;
    const sink = new Sink();
    const ok = await createUnifiedHandlers(reg).readParamsH(sink, 62, [25]);
    assertEqual((ok as Record<number, number>)[25], 0.5, 'case 6: the route returns the normalized value unchanged');
    assertEqual(sink.status, undefined, 'case 6: a successful read sets no error status');
    // A driver that could read nothing returns an EMPTY map — an honest absence, not a fabricated 0.
    const reg2 = { driver: async () => ({ readParams: async () => ({}) }) } as unknown as DeviceRegistry;
    const sink2 = new Sink();
    const empty = await createUnifiedHandlers(reg2).readParamsH(sink2, 1, [7115]);
    assertEqual(Object.keys(empty as object).length, 0, 'case 6: an unreadable pid yields an empty map, never a denormal');
    assert(!Object.values(empty as object).some((v) => typeof v === 'number' && v !== 0 && Math.abs(v) < 2 ** -126),
      'case 6: the route can never emit a denormal (the 0.0000 incident value)');
  }
}
