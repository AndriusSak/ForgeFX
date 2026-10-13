// A fn-0x13 status dump that cannot be read must NOT silently substitute channel A for a block's
// ACTIVE channel.
//
// DEFECT (the reconciliation's "silent channel-A substitution via `?? 0`" item): gen3.ts resolved a
// block's active channel with `(await this.#statusByEffectId()).get(eid)?.channel ?? 0` at three sites
// (blockParams, cabState, meters). `#statusByEffectId` swallowed every failure, so a TIMED-OUT or torn
// fn-0x13 dump yielded an EMPTY or PARTIAL map — and every affected block then sliced channel A. The
// fn=0x1F body is CHANNEL-BLOCKED (it holds all channels), so on a unit sitting on channel B the editor
// served channel A's values while the code's own comment claimed the round-trip existed to prevent
// exactly that.
//
// The fix distinguishes the two situations an empty/partial map makes look identical:
//   (a) the read SUCCEEDED and this eid is simply not in it (the block is NOT PLACED) → the documented
//       channel-A default stands. The exception is asserted EXPLICITLY below so it can never be
//       mistaken for the failure case.
//   (b) the read FAILED, or came back PARTIAL for a block this driver has evidence IS placed → the
//       channel is UNKNOWN and must not be served as A. Each site refuses in its own contract's shape:
//       blockParams/cabState THROW a named reason (their established failure shape — the torn-read guard
//       and blockParamsH→404), and meters leaves that block's vals EMPTY (an honest "no reading").
//
// "Evidence a block is placed" is the driver's own remembered placed set (`#placedCache`), which a
// successful, COMPLETE dump enumerates — in production the registry's channel watch refreshes it every
// Nth meter tick. WITHOUT that evidence a failed read is indistinguishable from "this driver has never
// looked", so the documented default applies (case 5 pins that boundary; it is also why every suite
// whose mock answers only the bulk poll is untouched by this change).
//
// Mocked transport + the REAL static FM3 profile: no hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page; // 58, DISTORT family
const CAB_EID = effectRoster().find((e) => e.slug === 'cab')!.page; // 62, CABINET family
const DELAY_EID = effectRoster().find((e) => e.slug === 'delay')!.page; // 70, DELAY family
const AMP_STRIDE = PROFILES[MODEL]!.rangeSections['DISTORT']!.stride; // 144
const CAB_STRIDE = PROFILES[MODEL]!.rangeSections['CABINET']!.stride; // 106
const DELAY_STRIDE = PROFILES[MODEL]!.rangeSections['DELAY']!.stride; // 88
const TYPE_PID = 6; // DISTORT_TYPE — the Amp model selector
// Three DISTINCT model ordinals, one per channel, so a served type NAMES the channel that was sliced.
const TYPE_ON_A = 213;
const TYPE_ON_B = 250;
const TYPE_ON_C = 316;

export const STATUS_CHANNEL_UNKNOWN_CASE_COUNT = 14;

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
/** A fn-0x13 status dump enumerating `entries` ([eid, channel]) — the PLACED blocks only. */
function statusDump(entries: readonly (readonly [number, number])[]): number[] {
  const payload: number[] = [];
  for (const [eid, ch] of entries) payload.push(...enc14(eid), ch << 1); // dd: not bypassed, channel ch
  return sysex(0x13, payload);
}
function bulkFrames(eid: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [sysex(0x74, [...enc14(eid), ...enc14(values.length), 0x07]), sysex(0x75, body), sysex(0x76, [])];
}

interface Harness {
  driver: ReturnType<typeof createGen3Driver>;
  /** Script the fn-0x13 answer: a frame, or `null` for NO 0x13 frame at all (a timed-out read). */
  setStatus: (frame: number[] | null) => void;
  /** Script what the unit answers the fn-0x0D patch-name query with — the preset IDENTITY the placement
   *  evidence is keyed to (finding #15). Default: no answer (identity unknown). */
  setPreset: (number: number, name: string) => void;
  ampBody: number[];
}

/** A fn-0x0D QUERY PATCH NAME reply: `[nn nn preset#][dd*32 name]`. */
function patchNameReply(number: number, name: string): number[] {
  const bytes = [...enc14(number)];
  for (let i = 0; i < 32; i++) bytes.push(name.charCodeAt(i) & 0x7f || 0x00);
  return sysex(0x0d, bytes);
}

/** Amp body with a different model ordinal on channels A/B/C, plus a complete Cab and Delay body. */
function makeHarness(): Harness {
  const codec = createModernFractalCodec(MODEL);
  const ampBody = new Array(AMP_STRIDE * 4).fill(0);
  ampBody[TYPE_PID] = TYPE_ON_A;
  ampBody[AMP_STRIDE + TYPE_PID] = TYPE_ON_B;
  ampBody[2 * AMP_STRIDE + TYPE_PID] = TYPE_ON_C;
  const cabBody = new Array(CAB_STRIDE * 4).fill(0);
  const delayBody = new Array(DELAY_STRIDE * 4).fill(0);
  let status: number[] | null = null;
  let preset: { number: number; name: string } = { number: -1, name: '' }; // default: the unit does not answer the identity query
  const mock = new MockTransport('serial', 'mock-status-channel');
  mock.isOpen = true;
  mock.reply = (req) => {
    if (req[5] === 0x13) return status ? [status] : []; // no frame = the dump timed out
    if (req[5] === 0x0d) return preset.number >= 0 ? [patchNameReply(preset.number, preset.name)] : [];
    if (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(AMP_EID))) return bulkFrames(AMP_EID, ampBody);
    if (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(CAB_EID))) return bulkFrames(CAB_EID, cabBody);
    if (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(DELAY_EID))) return bulkFrames(DELAY_EID, delayBody);
    return [];
  };
  const driver = createGen3Driver(PROFILES[MODEL]!, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(MODEL, 'balanced')
  });
  return { driver, setStatus: (frame) => { status = frame; }, setPreset: (number, name) => { preset = { number, name }; }, ampBody };
}

/** Assert `fn()` REJECTS and carries `re` — a bare catch would also accept a typo in the harness. */
async function rejects(fn: () => Promise<unknown>, re: RegExp, msg: string): Promise<string> {
  let served: unknown;
  let threw = false;
  let message = '';
  try { served = await fn(); } catch (e) { threw = true; message = (e as Error).message ?? String(e); }
  assert(threw, `${msg} — it RESOLVED instead of refusing (served: ${JSON.stringify(served)?.slice(0, 160)})`);
  assert(re.test(message), `${msg} — wrong refusal (expected ${re}, got: ${message})`);
  return message;
}

/** A grid stub placing just the Amp, so meters() has a cell to walk (its real source is the dump). */
const ampOnlyGrid = async () => ({
  model: 'fm3', name: 'x', crcValid: true, rows: 4, cols: 12, scenes: [], source: 'dump' as const,
  cells: [{ effectId: AMP_EID, isShunt: false, row: 0, col: 0, name: 'Amp 1', routeFlag: 0, fromRows: [] }]
});

export async function runStatusChannelUnknownTests(): Promise<void> {
  // ── 1. REQUIRED: the dump TIMES OUT → the block's channel is UNKNOWN, not A. ──
  {
    const h = makeHarness();
    h.setStatus(statusDump([[AMP_EID, 0]]));
    await h.driver.getActiveChannels(); // the channel watch enumerates the placed Amp (the evidence)
    h.setStatus(null); // the fn-0x13 read now times out (no 0x13 frame at all)
    const msg = await rejects(
      () => h.driver.blockParams(AMP_EID),
      /active channel UNKNOWN: .*not readable/,
      'a timed-out status dump must NOT resolve the block to channel A'
    );
    assert(/placed as of the last good dump/.test(msg), 'the refusal names the evidence (the Amp was placed)');
  }

  // ── 2. REQUIRED: the dump SUCCEEDS and places the block on channel 2 → the slice uses channel 2. ──
  {
    const h = makeHarness();
    h.setStatus(statusDump([[AMP_EID, 2]])); // channel C
    const r = await h.driver.blockParams(AMP_EID);
    assertEqual(r.type?.value, TYPE_ON_C, 'a successful dump makes the slice follow the block’s own channel (C=2)');
    // control: the SAME body read as channel A yields the channel-A ordinal, so case 2 is not vacuous.
    const a = makeHarness();
    a.setStatus(statusDump([[AMP_EID, 0]]));
    assertEqual((await a.driver.blockParams(AMP_EID)).type?.value, TYPE_ON_A,
      'control: with the dump placing the Amp on A, the channel-A ordinal is served (the two differ)');
  }

  // ── 3. REQUIRED: the dump SUCCEEDS and the block is ABSENT (not placed) → the documented A default
  //    still applies. Asserted EXPLICITLY so this exception is visible and cannot be read as case (b). ──
  {
    const h = makeHarness(); // a FRESH driver: no evidence the Amp is placed
    h.setStatus(statusDump([[DELAY_EID, 1]])); // a complete dump that legitimately does not list the Amp
    const r = await h.driver.blockParams(AMP_EID); // must NOT refuse
    assertEqual(r.type?.value, TYPE_ON_A,
      'a block absent from a successful dump (not placed) keeps the documented channel-A default');
  }

  // ── 4. REQUIRED: a PARTIAL dump (some triples present, the block missing) → UNKNOWN, not A. ──
  {
    const h = makeHarness();
    h.setStatus(statusDump([[AMP_EID, 0], [DELAY_EID, 0]]));
    await h.driver.getActiveChannels(); // evidence: the Amp IS placed
    h.setStatus(statusDump([[DELAY_EID, 0]])); // PARTIAL: an OK dump that now omits the Amp
    await rejects(
      () => h.driver.blockParams(AMP_EID),
      /omitted eid \d+, which an earlier dump .* enumerated as placed/,
      'a partial dump omitting a block we saw placed must NOT be served as channel A'
    );
    // control: the block the partial dump DOES carry is still served — no over-rejection.
    const d = await h.driver.blockParams(DELAY_EID);
    assert(d.slug === 'delay', 'control: a block present in the partial dump is still served');
  }

  // ── 5. The boundary: with NO placement evidence a failed dump keeps the documented A default. This
  //    is case (a)'s "no evidence" arm, and it is why a suite whose mock answers only the bulk poll
  //    (no 0x13 frame) is unaffected by this change. ──
  {
    const h = makeHarness();
    h.setStatus(null); // the dump fails from the very first call — nothing says this eid is placed
    const r = await h.driver.blockParams(AMP_EID);
    assertEqual(r.type?.value, TYPE_ON_A,
      'no evidence of placement + a failed dump → the documented channel-A default is preserved');
  }

  // ── 6. Site 2: cabState refuses a substituted channel too. ──
  {
    const h = makeHarness();
    h.setStatus(statusDump([[CAB_EID, 3]])); // the Cab is placed on channel D
    await h.driver.getActiveChannels(); // evidence
    h.setStatus(null); // the dump times out
    await rejects(
      () => h.driver.cabState(CAB_EID),
      /cabState eid \d+ active channel UNKNOWN: .*not readable/,
      'cabState must refuse to serve the Cab picker from a substituted channel'
    );
  }

  // ── 7. Site 3: meters leaves the block's vals EMPTY rather than reporting another channel's level. ──
  {
    const h = makeHarness();
    (h.driver as unknown as { grid: () => Promise<unknown> }).grid = ampOnlyGrid;
    h.setStatus(statusDump([[AMP_EID, 0]]));
    await h.driver.getActiveChannels(); // evidence
    h.setStatus(null); // the dump times out
    const m = await h.driver.meters({});
    const blk = m.find((b) => b.effectId === AMP_EID)!;
    assertEqual(Object.keys(blk.vals).length, 0, 'a failed dump yields NO meter reading for a placed block, not channel A’s');
    assertEqual(blk.typeName, '', 'no meter type name is fabricated from a substituted channel');
    // control: with no placement evidence the same failed dump still serves the A slice (documented default).
    const h2 = makeHarness();
    (h2.driver as unknown as { grid: () => Promise<unknown> }).grid = ampOnlyGrid;
    h2.setStatus(null);
    const blk2 = (await h2.driver.meters({})).find((b) => b.effectId === AMP_EID)!;
    assert(Object.keys(blk2.vals).length > 0, 'control: with no placement evidence the documented A default still serves');
  }

  // ── 8. Positive control: a GOOD dump on channel A still serves the Amp, so cases 1/4/6 refuse for the
  //    right reason and not because the harness can never succeed. ──
  {
    const h = makeHarness();
    h.setStatus(statusDump([[AMP_EID, 0]]));
    await h.driver.getActiveChannels();
    h.setStatus(statusDump([[AMP_EID, 1]])); // still readable, on channel B
    const r = await h.driver.blockParams(AMP_EID);
    assertEqual(r.type?.value, TYPE_ON_B, 'a readable dump is still served, on the channel it reports');
  }

  // ── 9. FINDING #1 (the review's exact check). The EDIT-POLL path must not wipe the placement
  //    evidence. A failed dump makes `getActiveChannels()` return an EMPTY map WITHOUT throwing, so the
  //    old `#sweepTargets` (reached through readDeviceEditState) stored `{eids: [], at: now}` — erasing
  //    the evidence AND refreshing its stamp. With the cache also aged past PLACED_TTL_MS (Date.now is
  //    advanced) the old wall-clock expiry resolved channel A on its own. Both must now REFUSE. ──
  {
    const h = makeHarness();
    h.setStatus(statusDump([[AMP_EID, 2]])); // the Amp is placed on channel C
    await h.driver.getActiveChannels(); // seed the placement evidence
    const realNow = Date.now;
    Date.now = () => realNow() + 20_000; // age the evidence past PLACED_TTL_MS
    try {
      h.setStatus(null); // the fn-0x13 dump now FAILS
      await h.driver.readDeviceEditState(); // the edit-poll path — runs #sweepTargets, which used to wipe + refresh the cache
      await rejects(
        () => h.driver.blockParams(AMP_EID),
        /active channel UNKNOWN: .*not readable/,
        'after the edit-poll path, an aged cache + a failed dump must still REFUSE (not resolve channel A)'
      );
    } finally { Date.now = realNow; }
  }

  // ── 10. HEALTHY-SESSION CONTROL (no regression): a GOOD dump must serve every placed block on its
  //    real channel even with an aged cache, and a block genuinely not placed keeps the documented A
  //    default. The evidence change must never make a healthy session refuse anything. ──
  {
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000; // well past any TTL
    try {
      const h = makeHarness();
      h.setStatus(statusDump([[AMP_EID, 1], [DELAY_EID, 0]])); // a complete, healthy dump
      const amp = await h.driver.blockParams(AMP_EID);
      assertEqual(amp.type?.value, TYPE_ON_B, 'healthy dump + aged evidence: the placed Amp is served on its real channel B');
      assert((await h.driver.blockParams(DELAY_EID)).slug === 'delay', 'healthy dump + aged evidence: the placed Delay is still served');
      // A block absent from a healthy dump it has never been seen placed in keeps channel A.
      const h2 = makeHarness();
      h2.setStatus(statusDump([[DELAY_EID, 1]]));
      assertEqual((await h2.driver.blockParams(AMP_EID)).type?.value, TYPE_ON_A,
        'a block not placed in a healthy dump keeps the documented A default (no over-refusal)');
    } finally { Date.now = realNow; }
  }

  // ── 11. FINDING #9 + #3 (removal semantics + reason text): a block omitted from SUCCESSIVE successful
  //    dumps (the only way a real front-panel removal ever shows) is retired after PLACED_MISS_LIMIT
  //    such omissions and then served as NOT PLACED — never refused forever. Finding #3 requires those
  //    omissions to be SEPARATED IN TIME, so the clock is advanced by PLACED_MISS_MIN_INTERVAL_MS between
  //    them; that is what makes them independent observations rather than one partial dump read thrice. ──
  {
    const h = makeHarness();
    h.setStatus(statusDump([[AMP_EID, 0], [DELAY_EID, 0]]));
    await h.driver.getActiveChannels(); // evidence: the Amp is placed
    h.setStatus(statusDump([[DELAY_EID, 0]])); // every subsequent successful dump omits the Amp
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      const m1 = await rejects(
        () => h.driver.blockParams(AMP_EID),
        /omitted eid \d+, which an earlier dump .* enumerated as placed/,
        'the first counted omission still refuses'
      );
      assert(/no longer placed/.test(m1), 'the refusal names the removal possibility, not a flat "PARTIAL"');
      clock += 5_000; // PLACED_MISS_MIN_INTERVAL_MS — the next omission is a DISTINCT observation
      await rejects(() => h.driver.blockParams(AMP_EID), /omitted eid \d+/, 'the second counted omission still refuses');
      clock += 5_000; // PLACED_MISS_LIMIT-th counted omission: retired → the block reads as not placed.
      assertEqual((await h.driver.blockParams(AMP_EID)).type?.value, TYPE_ON_A,
        'after PLACED_MISS_LIMIT TIME-SEPARATED successful omissions the block is treated as genuinely removed');
    } finally { Date.now = realNow; }
  }

  // ── 12. FINDING #3 (the defect this reopens): a PERSISTENTLY PARTIAL dump hammered at the registry's
  //    real channel-watch cadence must NOT retire the placed block. The watch calls getActiveChannels()
  //    every 8th meter tick (0.48–3.2 s) — facetiously fast compared to any single read — so if every
  //    read counted a miss, three of them would retire the block in ~1.5 s, FASTER than the 10 s TTL the
  //    fix removed, and the channel-A substitution would return. The reads below happen back-to-back
  //    (well inside PLACED_MISS_MIN_INTERVAL_MS), which is exactly that cadence. ──
  {
    const h = makeHarness();
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      h.setStatus(statusDump([[AMP_EID, 0], [DELAY_EID, 0]]));
      await h.driver.getActiveChannels(); // evidence: the Amp is placed
      h.setStatus(statusDump([[DELAY_EID, 0]])); // a PARTIAL dump that omits the Amp, forever
      // 10 watch ticks at the FASTEST real cadence (performance mode: 60 ms meter tick × 8 = 480 ms).
      // Pre-fix this was 10 counted misses → retired well under 1 s. Post-fix it is ONE observation.
      for (let i = 0; i < 10; i++) { await h.driver.getActiveChannels(); clock += 480; }
      await rejects(
        () => h.driver.blockParams(AMP_EID),
        /omitted eid \d+, which an earlier dump .* enumerated as placed/,
        'a partial dump read at the channel-watch cadence must NOT retire the placed block (faster-than-TTL channel-A substitution)'
      );
    } finally { Date.now = realNow; }
  }

  // ── 13. FINDING #3, the LEGITIMATE half: a block omitted from dumps that ARE separated in time (a real
  //    front-panel removal) IS retired eventually. The control for case 12: the interval only slows the
  //    clock, it does not stop a genuine removal from ever retiring the block. ──
  {
    const h = makeHarness();
    h.setStatus(statusDump([[AMP_EID, 0], [DELAY_EID, 0]]));
    await h.driver.getActiveChannels(); // evidence
    h.setStatus(statusDump([[DELAY_EID, 0]]));
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      for (let i = 0; i < 2; i++) {
        await rejects(() => h.driver.blockParams(AMP_EID), /omitted eid \d+/, `time-separated omission ${i + 1} still refuses`);
        clock += 5_000;
      }
      assertEqual((await h.driver.blockParams(AMP_EID)).type?.value, TYPE_ON_A,
        'a genuinely removed block IS retired once its omissions are separated in time');
    } finally { Date.now = realNow; }
  }

  // ── 14. FINDING #15: a front-panel / MIDI preset change moves the preset IDENTITY, which the evidence
  //    is keyed to. A successful dump of the NEW preset that omits a block from the OLD one must DROP the
  //    stale evidence and serve the documented channel-A default — not refuse the old-preset block as a
  //    torn read. ──
  {
    const h = makeHarness();
    h.setPreset(7, 'OLD'); // the identity the evidence is seeded under
    h.setStatus(statusDump([[AMP_EID, 0], [DELAY_EID, 0]]));
    await h.driver.getActiveChannels(); // evidence seeded with preset 7:OLD
    h.setPreset(8, 'NEW'); // the owner switched presets on the unit's front panel (or via MIDI)
    h.setStatus(statusDump([[DELAY_EID, 1]])); // the new preset does not place the Amp
    assertEqual((await h.driver.blockParams(AMP_EID)).type?.value, TYPE_ON_A,
      'a preset change must drop the stale evidence and serve the channel-A default, not refuse the old-preset block');
    // control: the block the NEW preset DOES place is served (no over-refusal on the healthy half).
    assert((await h.driver.blockParams(DELAY_EID)).slug === 'delay', 'control: the new preset’s placed block is still served');
  }
}
