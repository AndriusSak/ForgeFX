// The four "raw field IS the value" rows, pinned through the driver's REAL read and write paths.
//
// MEASURED 2026-10-13 (`review-2026-10-13/probe-bounds-violations.json`, 897 float rows): for CONTROLLERS/32
// Tempo, CONTROLLERS/36 Stages, GLOBAL/67 Bank Size and REVERB/67 TONETYPE the unit's own view-0x00 display
// equals the RAW 14-bit field (120 BPM / 8 / 3 / 1) where the table's normalised map served 24.414 / 2.004 /
// 1.001 / 0. forgefx-midi's range overlay marks the four `valueMap: 'identity'`; the driver reads display ==
// raw and writes the value, not a position.
//
// WHAT THIS ASSERTS: values SERVED by `driver.blockParams()` over a MockTransport against the REAL static FM3
// profile (not a re-derivation of `#display`), the served `norm` (knob position over [min,max]), the exact
// frame `setParam` SENDS for a knob write, that a REFUSED identity write is SURFACED to the caller, and the
// rows' machine-readable write-validation status.
//
// VALIDATION STATUS — must NOT be read as "all four validated". Only TEMPO's WRITE form was exercised on the
// unit (the typed fn-0x01 SET at eid 2 / pid 0x20 — `buildSetTempoViaParam`, forgefx-midi telemetry.ts:238).
// The Stages / Bank Size / TONETYPE writes have NEVER been sent to hardware: their READ mapping is measured,
// their WRITE mapping is INFERRED from the Tempo form. forgefx-midi's overlay carries that distinction
// machine-readably as `writeValidated` (present on Tempo alone — case 8). The GLOBAL/67 read IS exercised here
// (case 3); before this file it was not exercised by any test.

import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const compactHex = (f: readonly number[]): string => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
function blockBulkFrames(eid: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [sysex(0x74, [...enc14(eid), ...enc14(values.length), 0x07]), sysex(0x75, body), sysex(0x76, [])];
}

/** A driver whose bulk poll answers `values`; every other request is silent. */
function makeDriver(eid: number, values: number[]) {
  const profile = PROFILES[MODEL]!;
  const codec = createModernFractalCodec(profile.model);
  const bulk = blockBulkFrames(eid, values);
  const mock = new MockTransport('serial', 'mock-raw-value');
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid)) ? bulk : []);
  const driver = createGen3Driver(profile, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(profile.model, 'balanced') });
  return { profile, codec, mock, driver };
}

/** A driver whose every request is answered by the same reply script — used by the write-path cases. */
function makeReplyDriver(eid: number, replyFn: () => number[][]) {
  const profile = PROFILES[MODEL]!;
  const mock = new MockTransport('serial', `mock-raw-value-${eid}`);
  mock.isOpen = true;
  mock.reply = replyFn;
  const driver = createGen3Driver(profile, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(profile.model, 'balanced') });
  return { profile, mock, driver };
}

/** [family, eid, pid, name, raw the unit was read at, the unit's printed value, declared min, declared max] */
const CONTROLLERS_EID = 2;
const GLOBAL_EID = 1; // virtual GLOBAL effect (global-bulk-read.test.ts)
const REVERB_EID = effectRoster().find((e) => e.slug === 'reverb')!.page;

/** The exact 23-byte typed-SET frame the identity Tempo write must put on the wire (pinned literal). */
const TEMPO_120_FRAME = 'f000017411010900020020000000401704000000006df7';

export const RAW_VALUE_ROWS_CASE_COUNT = 10;

export async function runRawValueRowsTests(): Promise<void> {
  // ── 1. READ: Tempo + Stages (CONTROLLERS, eid 2) through blockParams() ───────────────────────────────
  {
    const profile = PROFILES[MODEL]!;
    const stride = Math.max(profile.rangeSections['CONTROLLERS']?.stride ?? 1, 64);
    const values = new Array(stride * 4).fill(0);
    values[32] = 120; // Tempo — unit "120 BPM"
    values[36] = 8; // Stages — unit "8"
    const { driver } = makeDriver(CONTROLLERS_EID, values);
    const r = await driver.blockParams(CONTROLLERS_EID);
    const tempo = r.named.find((n) => n.id === 32);
    const stages = r.named.find((n) => n.id === 36);
    assert(tempo !== undefined && stages !== undefined, 'CONTROLLERS Tempo(32) and Stages(36) must be served by blockParams');
    assert(tempo.value === 120, `Tempo at raw 120 must SERVE 120 (the unit shows 120 BPM), got ${tempo.value} (the defect served 24.414)`);
    assert(stages.value === 8, `Stages at raw 8 must SERVE 8 (the unit shows 8), got ${stages.value} (the defect served 2.004)`);
    // norm is the knob POSITION over the declared range, so the client draws it where the value sits.
    assert(tempo.norm !== null && Math.abs(tempo.norm - (120 - 24) / (250 - 24)) < 1e-9, `Tempo norm must be the in-range position ${(120 - 24) / 226}, got ${tempo.norm}`);
    assert(stages.norm !== null && Math.abs(stages.norm - (8 - 2) / 30) < 1e-9, `Stages norm must be the in-range position 0.2, got ${stages.norm}`);
    assert(tempo.min === 24 && tempo.max === 250, `Tempo keeps its declared bounds 24..250, got ${tempo.min}..${tempo.max}`);
  }

  // ── 2. READ: REVERB/67 TONETYPE (raw 1 → the unit shows 1, the defect served 0) ──────────────────────
  {
    const profile = PROFILES[MODEL]!;
    const stride = Math.max(profile.rangeSections['REVERB']?.stride ?? 1, 70);
    const values = new Array(stride * 4).fill(0);
    values[67] = 1;
    const { driver } = makeDriver(REVERB_EID, values);
    const r = await driver.blockParams(REVERB_EID);
    const all = [...r.named, ...(r.enums as unknown as Array<{ id: number; value?: number | null }>)];
    const tone = all.find((n) => n.id === 67);
    // TONETYPE is served as an enum or a named float depending on the layout; whichever surface carries it
    // must not serve the normalised 0. If neither surface carries it, say so instead of passing silently.
    assert(tone !== undefined, 'REVERB/67 TONETYPE must be served by blockParams (named or enums)');
    assert((tone as { value?: number | null }).value === 1, `TONETYPE at raw 1 must SERVE 1 (unit shows 1), got ${(tone as { value?: number | null }).value}`);
  }

  // ── 3. READ: GLOBAL/67 Bank Size (eid 1) through blockParams() — the row NO earlier test exercised ───
  {
    const profile = PROFILES[MODEL]!;
    const stride = Math.max(profile.rangeSections['GLOBAL']?.stride ?? 1, 68);
    const values = new Array(stride * 4).fill(0);
    values[67] = 3; // Bank Size — unit "3"
    const { driver } = makeDriver(GLOBAL_EID, values);
    const r = await driver.blockParams(GLOBAL_EID);
    const all = [...r.named, ...(r.enums as unknown as Array<{ id: number; value?: number | null }>)];
    const bank = all.find((n) => n.id === 67) as { id: number; value?: number | null; norm?: number | null; min?: number; max?: number; name?: string } | undefined;
    assert(bank !== undefined, 'GLOBAL/67 Bank Size must be served by blockParams (named or enums)');
    assert(bank!.value === 3, `Bank Size at raw 3 must SERVE 3 (the unit shows 3), got ${bank!.value} (the defect served 1.001)`);
    // norm = the in-range knob position (3-1)/(12-1) = 2/11.
    assert(bank!.norm != null && Math.abs(bank!.norm - 2 / 11) < 1e-9, `Bank Size norm must be 2/11, got ${bank!.norm}`);
    assert(bank!.min === 1 && bank!.max === 12, `Bank Size keeps its declared bounds 1..12, got ${bank!.min}..${bank!.max}`);
  }

  // ── 4. WRITE: a knob norm for Tempo is sent as float32(BPM), the typed-SET form (Tempo's is the ONE
  //      write form validated on the unit) ──────────────────────────────────────────────────────────────
  {
    const { codec, mock, driver } = makeDriver(CONTROLLERS_EID, new Array(1).fill(0));
    await driver.setParam(CONTROLLERS_EID, 32, (120 - 24) / (250 - 24), true);
    const want = compactHex(codec.buildSetParameter(CONTROLLERS_EID, 32, 120));
    assert(mock.sent.some((f) => compactHex(f) === want), `knob norm for 120 BPM must send the typed-SET frame for value 120 (${want}); sent: ${mock.sent.map(compactHex).join(' | ')}`);
    // A norm at the top clamps to the declared max (250), at the bottom to 24 — never an out-of-range value.
    mock.sent.length = 0;
    await driver.setParam(CONTROLLERS_EID, 32, 1, true);
    assert(mock.sent.some((f) => compactHex(f) === compactHex(codec.buildSetParameter(CONTROLLERS_EID, 32, 250))), 'norm 1 must send 250 BPM');
    mock.sent.length = 0;
    await driver.setParam(CONTROLLERS_EID, 32, 0, true);
    assert(mock.sent.some((f) => compactHex(f) === compactHex(codec.buildSetParameter(CONTROLLERS_EID, 32, 24))), 'norm 0 must send 24 BPM');
  }

  // ── 5. FRAME PIN: a successful identity write reaches the wire with the SAME bytes the fix must not
  //      change — the exact 23-byte frame, by literal AND by the codec's own builder ──────────────────────
  {
    const { mock, driver } = makeReplyDriver(CONTROLLERS_EID, () => []); // silent device = accept
    const r = await driver.setParam(CONTROLLERS_EID, 32, (120 - 24) / (250 - 24), true);
    assert(r.ok === true, 'a silent (accepting) identity write stays ok:true');
    const sent = mock.sent.map(compactHex);
    assert(sent.includes(TEMPO_120_FRAME), `identity Tempo(120) write must send the pinned frame ${TEMPO_120_FRAME}; sent: ${sent.join(' | ')}`);
    const codec = createModernFractalCodec(MODEL);
    assert(sent.includes(compactHex(codec.buildSetParameter(CONTROLLERS_EID, 32, 120))), 'the identity write must equal buildSetParameter(2,32,120) exactly');
  }

  // ── 6. REFUSAL SURFACED: a device rejection (0x64 echoing fn 0x01) must reach the CALLER, not be dropped.
  //      Finding #4 splits the two paths: a ONE-SHOT (discrete, continuous:false) identity set still
  //      observes the reply via #write, so its refusal reaches the caller; a continuous knob drag is
  //      fire-and-forget and cannot surface it (case 9 pins that trade-off deliberately). A discrete
  //      Tempo set of 120 sends the SAME typed-SET frame the validated continuous write does. ──────────
  {
    const rejecting = () => [sysex(0x64, [0x01, 0x0b])]; // MULTIPURPOSE_RESPONSE [echoedFn 0x01, resultCode]
    const { mock, driver } = makeReplyDriver(CONTROLLERS_EID, rejecting);
    const refused = await driver.setParam(CONTROLLERS_EID, 32, 120, false); // one-shot discrete set
    assert(refused.ok === false, `a REFUSED one-shot identity write must surface ok:false to the caller, got ${JSON.stringify(refused)}`);
    // And the frame really went out (it was not dropped before the wire).
    assert(mock.sent.some((f) => compactHex(f) === TEMPO_120_FRAME), `the refused identity write must still have been sent (${TEMPO_120_FRAME}); sent: ${mock.sent.map(compactHex).join(' | ')}`);
    // Control: a 0x64 echoing a DIFFERENT function is NOT our rejection — the write stays accepted.
    const { driver: foreign } = makeReplyDriver(CONTROLLERS_EID, () => [sysex(0x64, [0x1f, 0x0b])]);
    const notOurs = await foreign.setParam(CONTROLLERS_EID, 32, 120, false);
    assert(notOurs.ok === true, 'a 0x64 echoing another function (0x1f) must NOT be attributed to the identity write');
  }

  // ── 7. CONTROL: a normalised row's continuous write is UNCHANGED (position, sub 52) ───────────────────
  {
    const { codec, mock, driver } = makeDriver(CONTROLLERS_EID, new Array(1).fill(0));
    await driver.setParam(CONTROLLERS_EID, 2, 0.5, true); // CONTROLLERS_LFO1DEPTH: a normal 0..100 knob
    assert(mock.sent.some((f) => compactHex(f) === compactHex(codec.buildSetParameterContinuous(CONTROLLERS_EID, 2, 0.5))), 'a non-identity row keeps the continuous-position write');
  }

  // ── 8. VALIDATION MARKER: the four identity rows' READS are all measured, but only Tempo's WRITE is
  //      validated — asserted off the machine-readable `writeValidated` the overlay carries, so the three
  //      unvalidated rows cannot read as validated. ───────────────────────────────────────────────────────
  {
    const ranges = PROFILES[MODEL]!.ranges as unknown as Record<string, Record<number, { valueMap?: string; writeValidated?: boolean }>>;
    const IDENTITY: Array<[string, number]> = [['CONTROLLERS', 32], ['CONTROLLERS', 36], ['GLOBAL', 67], ['REVERB', 67]];
    for (const [fam, pid] of IDENTITY) {
      assert(ranges[fam]?.[pid]?.valueMap === 'identity', `${fam}/${pid} must be served as a valueMap 'identity' row`);
    }
    assert(ranges['CONTROLLERS']?.[32]?.writeValidated === true, 'Tempo (CONTROLLERS/32) is the ONE write form validated on the unit — must carry writeValidated:true');
    for (const [fam, pid] of [['CONTROLLERS', 36], ['GLOBAL', 67], ['REVERB', 67]] as Array<[string, number]>) {
      assert(ranges[fam]?.[pid]?.writeValidated !== true, `${fam}/${pid}'s write is NOT hardware-validated — must not be marked writeValidated`);
    }
  }

  // ── 9. FINDING #4 (the observation cost): a CONTINUOUS identity write is a knob drag and must NOT pay
  //      the #write observation (the 250 ms window) per tick — it is fire-and-forget via #send. Pinned by
  //      counting the transport's OBSERVATION calls (dev.request, i.e. #write) vs the fire-and-forget
  //      ones: PRE-FIX every drag tick was an observation, so `requests === 0` FAILED. ──────────────────
  {
    const { mock, driver } = makeReplyDriver(CONTROLLERS_EID, () => []); // silent device = accept
    let requests = 0;
    const origRequest = mock.request.bind(mock);
    mock.request = (b, o) => { requests += 1; return origRequest(b, o); };
    const sentBefore = mock.sent.length;
    for (let i = 0; i < 8; i++) await driver.setParam(CONTROLLERS_EID, 32, 0.5, true); // a knob drag
    assert(requests === 0, `a continuous identity (knob-drag) write must NOT pay the #write observation (250 ms) per tick — made ${requests} observation request(s)`);
    assert(mock.sent.length - sentBefore === 8, `each drag tick must still reach the wire (fire-and-forget); sent ${mock.sent.length - sentBefore} of 8`);
    // Control: a ONE-SHOT identity set DOES observe its reply — that is the path the refusal (case 6)
    // rides on, so case 9 cannot be satisfied by deleting the observation entirely.
    const { mock: m2, driver: d2 } = makeReplyDriver(CONTROLLERS_EID, () => []);
    let req2 = 0;
    const orig2 = m2.request.bind(m2);
    m2.request = (b, o) => { req2 += 1; return orig2(b, o); };
    await d2.setParam(CONTROLLERS_EID, 32, 120, false);
    assert(req2 === 1, `a one-shot identity set must still observe its reply (the refusal path); made ${req2}`);
  }

  // ── 10. FINDING #5 (consume `writeValidated`): a write to an identity row whose frame form has NEVER
  //      been sent to hardware is REFUSED as {ok:false} — visibly unvalidated, in the write path's existing
  //      contract. PRE-FIX only a comment recorded the risk and the frame went out on all three rows, so
  //      the `ok === false` / `sent === 0` assertions below FAILED. ────────────────────────────────────────
  {
    const UNVALIDATED: Array<[number, number, string]> = [
      [CONTROLLERS_EID, 36, 'Stages'],
      [GLOBAL_EID, 67, 'Bank Size'],
      [REVERB_EID, 67, 'TONETYPE']
    ];
    for (const [eid, pid, name] of UNVALIDATED) {
      const { mock, driver } = makeReplyDriver(eid, () => []);
      const r = await driver.setParam(eid, pid, 0.5, true); // a knob drag on an unvalidated identity row
      assert(r.ok === false, `${name} (eid ${eid}/${pid}) is NOT write-validated — the write must be visibly REFUSED, got ${JSON.stringify(r)}`);
      assert(mock.sent.length === 0, `${name}'s refused write must NOT put an unproven frame on the wire; sent ${mock.sent.map(compactHex).join(' | ')}`);
    }
    // Positive control: the ONE validated identity row (Tempo) still goes out — the refusal is specific
    // to unvalidated rows, not a blanket ban on identity writes.
    const { mock, driver } = makeReplyDriver(CONTROLLERS_EID, () => []);
    const ok = await driver.setParam(CONTROLLERS_EID, 32, 120, false);
    assert(ok.ok === true, 'the validated Tempo identity write must still proceed');
    assert(mock.sent.some((f) => compactHex(f) === TEMPO_120_FRAME), 'the validated Tempo write must reach the wire');
  }

  console.log('  raw-value-rows: Tempo 120 / Stages 8 / Bank Size 3 / TONETYPE 1 SERVED through blockParams(); identity write pinned to the exact frame, its one-shot refusal surfaced, its continuous cost fire-and-forget; only Tempo marked writeValidated and only Tempo writable');
}
