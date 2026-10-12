// The fn=0x1F channel-block WIRE STRIDE is a device-true CONSTANT; a device-cache rebuild must not
// change it — and the cache contributes NOTHING to wire geometry.
//
// INCIDENT (measured on the owner's FM3, 2026-10-12, preset 410 "USA Mk IV", Cab eid 62):
//   The unit's own screen read Room Diffusion = 0. The server served 52.287 for the SAME block, from a
//   byte-identical edit buffer (GET /preset/body differed from the captured body by exactly ONE byte,
//   offset 5834, the owner's unrelated Tap Tempo edit). The correct reading had been captured at 21:47
//   (review-2026-10-12/r16-state/cab-1x8-PRINCETONE-params.json: Diffusion 0, Room Level 36.5, Room
//   Size 6.196, Mic Spacing 17, Frequency 5000.07). Between the two readings the ONLY server-side
//   change was a device-cache rebuild (GET /device/cache: builtAt 2026-10-12T19:50:18.387Z, source
//   "live").
//
// ROOT CAUSE: blockParams indexes the bulk body at `base + pid`, where
//   base = min(activeChannel, channelCount-1) * stride   (#channelSlice, gen3.ts)
// and `stride` comes from profile.rangeSections[family].stride. runtimeProfileFrom merged the device
// cache's rangeSections OVER the static ones, and the cache builder writes `stride: sec.size`
// (forgefx-midi/src/cache/assign.ts) — the number of ordinary records the self-describe walk happened
// to observe, NOT the device's channel-block stride. For the FM3 Cab the walk recorded stride 63 while
// the real fn=0x1F stride is 106 (FM3_RANGE_SECTIONS.CABINET, measured). With the Cab on channel D
// (activeChannel 3) the base was 3*106 = 318 before the rebuild (correct) and 3*63 = 189 after it
// (wrong): the block decoded a DIFFERENT 14-record window of the same body, so every Room/Air value
// moved while the hardware held still. Served value = f(device bytes, channel base), and the base
// depends on the cache — which is why a cache rebuild silently changed what the app displayed.
//
// THE HARDENING (this round): the merge fix upstream (36537e2) only preserved the STRIDE — it still
// spread the cache meta's sectionTag/recordCount over the static row, and it still let a cache row for
// a family the static table LACKS supply a stride. Bad strides are already PERSISTED in the
// deviceCaches store (services/deviceCache.ts putDoc) and can also arrive from imports/cloud pulls, so
// any read-side path that takes a stride from a cache row is a latent repeat. runtimeProfileFrom now
// returns the STATIC rangeSections verbatim (no overlay at all). Cases 1-2 pin that; cases 3-5 keep the
// original end-to-end incident reproduction.
//
// Both bases are pinned below against the REAL captured Cab body (GET /preset/blocks/62/raw): at base
// 318 index 318+59 yields raw 0 (Diffusion 0, the unit's screen) and at base 189 index 189+59 yields
// raw 34266 (Diffusion 52.287, the wrong served value). Mocked transport + the real static FM3
// profile: no hardware.
import { PROFILES, runtimeProfileFrom } from '../../src/devices.js';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import type { BuiltCache } from 'forgefx-midi/cache';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const CAB_EID = effectRoster().find((e) => e.slug === 'cab')!.page; // 62
const CAB_CHANNEL = 3; // the preset's Cab block sits on channel D (the incident's active channel)
/** The device-true fn=0x1F channel-block stride (FM3_RANGE_SECTIONS.CABINET, a measured constant). */
const DEVICE_STRIDE = 106;
/** The static profile's declared CABINET record count (ordinary + the 4 special cab-table records). */
const STATIC_RECORD_COUNT = 110;
/** What the live self-describe walk recorded for the same family (assign.ts `stride: sec.size`). */
const CACHE_STRIDE = 63;
const CAB_ITEM_COUNT = 424; // 4 channels x 106 records, measured (max nonzero index 423)
const GOOD_BASE = CAB_CHANNEL * DEVICE_STRIDE; // 318 — the window the unit agrees with
const BAD_BASE = CAB_CHANNEL * CACHE_STRIDE; // 189 — the window the rebuilt cache selected
// The incident's served values (review-2026-10-12/r16-state/cab-1x8-PRINCETONE-params.json).
const GOOD_DIFFUSION = 0;
const BAD_DIFFUSION = 52.287;

// ── Real captured Cab bulk values (GET /preset/blocks/62/raw, sparse: only non-zero records) ──
const CAB_BODY_SPARSE: Readonly<Record<number, number>> = {
  0:3,4:127,8:65534,9:65534,10:65534,11:65534,12:32767,13:32767,
  14:32767,15:32767,25:1,26:1,27:1,28:52427,29:32767,36:34266,
  37:11141,39:65534,41:50995,42:1,44:32767,45:32767,46:32767,53:32767,
  55:26079,66:65534,67:65534,68:65534,69:65534,74:1,75:1,76:1,
  77:1,78:1,79:1,80:1,81:1,93:32767,94:32767,95:32767,
  96:32767,97:13107,98:13107,99:13107,100:13107,105:1,106:1,107:1,
  110:597,111:583,114:62257,115:65534,116:65534,117:65534,118:32767,119:32767,
  120:32767,121:32767,132:1,133:1,134:52427,135:32767,137:1,142:34266,
  143:11141,145:55670,147:50995,148:1,150:32767,151:32767,152:32767,158:1,
  159:32767,161:26079,172:65534,173:65534,174:65534,175:65534,180:1,181:1,
  182:1,183:1,184:1,185:1,186:1,187:1,188:1,189:1,
  191:38,192:38,193:36,194:36,195:2,196:1,198:3,199:32767,
  200:32767,201:32767,202:32767,204:8192,205:13107,206:13107,211:1,212:1,
  213:1,216:597,217:583,220:65534,221:65534,222:65534,223:65534,224:32767,
  225:32767,226:32767,227:32767,238:1,239:1,240:52427,241:32767,243:1,
  248:34266,249:11141,251:55670,253:50995,254:1,256:32767,257:32767,258:32767,
  264:1,265:32767,267:26079,278:65534,279:65534,280:65534,281:65534,286:1,
  287:1,288:1,289:1,290:1,291:1,292:1,293:1,294:1,
  295:1,297:39,298:39,301:2,302:1,305:24617,306:46927,307:32767,
  308:32767,309:5819,310:27056,311:13107,312:13107,317:1,318:1,322:1,
  326:65534,327:65534,328:65534,329:65534,330:32767,331:32767,332:32767,333:32767,
  344:1,345:1,346:52427,347:32767,349:1,353:23920,354:20643,355:11141,
  357:55670,359:50995,360:1,362:32767,363:32767,364:32767,370:1,371:32767,
  373:26079,381:41181,384:65534,385:65534,386:65534,387:65534,392:1,393:1,
  394:1,395:1,396:1,397:1,398:1,399:1,400:1,401:1,
  403:1,404:25,407:2,408:1,411:25387,412:13847,413:32767,414:32767,
  415:15848,416:33324,417:13107,418:13107,423:1
};

function cabBody(): number[] {
  const v = new Array(CAB_ITEM_COUNT).fill(0);
  for (const [i, n] of Object.entries(CAB_BODY_SPARSE)) v[Number(i)] = n;
  return v;
}
function cabFrames(values: readonly number[]): number[][] {
  const b: number[] = [0x00, 0x02];
  for (const x of values) b.push(...packValue16(x));
  return [sysex(0x74, [...enc14(CAB_EID), ...enc14(values.length), 0x07]), sysex(0x75, b), sysex(0x76, [])];
}
function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const x of body) cs ^= x;
  return [...body, cs & 0x7f, 0xf7];
}
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
const compactHex = (f: readonly number[]) => f.map((x) => x.toString(16).padStart(2, '0')).join('');
const statusFrame = (eid: number, channel: number): number[] => sysex(0x13, [...enc14(eid), (channel << 1)]);

/** A synthetic on-connect cache whose CABINET stride is the walk's observed record count (63), plus a
 *  family (`WIDGET`) the static FM3 table has NO entry for — the cache must not inject one either. */
function cacheWithObservedCabStride(): BuiltCache {
  return {
    model: MODEL,
    firmware: '13.0',
    ranges: {},
    rangeSections: {
      CABINET: { sectionTag: 62, stride: CACHE_STRIDE, recordCount: CACHE_STRIDE },
      WIDGET: { sectionTag: 250, stride: CACHE_STRIDE, recordCount: CACHE_STRIDE }
    },
    enumOverrides: {},
    rosters: {},
    cabIrs: {},
    unmappedSections: [],
    unmappedFamilies: [],
    meta: { recordCount: 2581, source: 'live', builtAt: '2026-10-12T19:50:18.387Z' }
  } as unknown as BuiltCache;
}

/** Serve the Cab block through a driver built on `profile`, replying the real captured body and a
 *  status dump placing the Cab on channel D. */
async function serveCabDiffusion(profile: (typeof PROFILES)[number]) {
  const bulk = cabFrames(cabBody());
  const codec = createModernFractalCodec(profile.model);
  const mock = new MockTransport('serial', 'mock-cabinet-wire-stride');
  mock.isOpen = true;
  mock.reply = (req) => {
    if (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(CAB_EID))) return bulk;
    if (req[5] === 0x13) return [statusFrame(CAB_EID, CAB_CHANNEL)];
    return [];
  };
  const driver = createGen3Driver(profile as never, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced')
  } as never);
  const params = await driver.blockParams(CAB_EID);
  return params.named.find((n) => n.id === 59); // Room Diffusion
}

export const CABINET_WIRE_STRIDE_CASE_COUNT = 5;

export async function runCabinetWireStrideTests(): Promise<void> {
  const staticProfile = PROFILES[MODEL]!;
  const cache = cacheWithObservedCabStride();
  const merged = runtimeProfileFrom(cache, staticProfile);

  // ── 1. WIRE GEOMETRY IS NOT OVERLAYABLE. `rangeSections` must come from the STATIC profile verbatim:
  //    the stride (106) AND the non-stride metadata (recordCount 110, sectionTag 11) are hardware
  //    facts, not cache facts, and the returned table must be the static one itself (no cache row,
  //    for ANY family, may touch it). FAILS BEFORE the hardening, which spread the cache's
  //    sectionTag/recordCount over the static row (recordCount read 63). ──
  {
    assert(merged.rangeSections === staticProfile.rangeSections,
      'case 1: runtimeProfileFrom must return the STATIC rangeSections table (wire geometry is not cache-overlayable)');
    assertEqual(merged.rangeSections['CABINET']!.stride, DEVICE_STRIDE,
      `case 1: the device-true CABINET wire stride must be ${DEVICE_STRIDE}, not the cache's observed record count ${CACHE_STRIDE}`);
    assertEqual(merged.rangeSections['CABINET']!.recordCount, STATIC_RECORD_COUNT,
      `case 1: the CABINET recordCount must be the static ${STATIC_RECORD_COUNT}, not the cache's ${CACHE_STRIDE} (no non-stride metadata overlay either)`);
  }

  // ── 2. A family the static table LACKS must NOT be injected from the cache. Before the hardening the
  //    cache fallback installed `WIDGET` with the walk's stride 63, which #channelSlice would then use;
  //    now the family is simply absent, so #channelSlice takes its own `itemCount % 4 === 0` fallback
  //    (EXACT for a 4-channel body — a short observed count is not). ──
  {
    assert(merged.rangeSections['WIDGET'] === undefined,
      'case 2: a cache row for a family the static table lacks must not add a wire stride');
    assert(Object.prototype.hasOwnProperty.call(staticProfile.rangeSections, 'WIDGET') === false,
      'case 2 (control): WIDGET is genuinely absent from the static FM3 table, so this case is not vacuous');
  }

  // ── 3. THE INCIDENT, end to end: with that cache present, the driver must decode the SAME window the
  //    unit holds. Before the fix this returned 52.287 (the wrong window); the unit reads 0. ──
  {
    const diff = await serveCabDiffusion(merged);
    assert(diff != null, 'case 3: Room Diffusion is served');
    assert(Math.abs((diff!.value as number) - GOOD_DIFFUSION) < 0.15,
      `case 3: Room Diffusion must equal the unit's 0, not the wrong-window value; got ${diff!.value}`);
  }

  // ── 4. Independent decode of the captured body at BOTH bases proves the causation (a data-level
  //    positive control that does not depend on the driver): the good base yields raw 0, the bad base
  //    yields the wrong-window raw whose /65534 is exactly the served 0.52287. ──
  {
    const body = cabBody();
    const goodRaw = body[GOOD_BASE + 59]!;
    const badRaw = body[BAD_BASE + 59]!;
    assertEqual(goodRaw, 0, 'case 4: the device-true window holds Room Diffusion raw 0');
    assert(Math.abs(badRaw / 65534 - BAD_DIFFUSION / 100) < 1e-5,
      `case 4: the wrong window holds the served Diffusion norm (got ${badRaw / 65534}); base ${BAD_BASE} is what a cache stride ${CACHE_STRIDE} selects`);
  }

  // ── 5. The device-true window also matches the rest of the saved 21:47 fixture, so the fix is not
  //    specific to one param (Room Level 36.5, Mic Spacing 17, Frequency 5000.07). ──
  {
    const body = cabBody();
    assert(Math.abs((body[GOOD_BASE + 35]! / 65534) * 100 - 36.5) < 0.05, 'case 5: Room Level decodes to the fixture value 36.5');
    assert(Math.abs((body[GOOD_BASE + 37]! / 65534) * 100 - 17) < 0.05, 'case 5: Mic Spacing decodes to the fixture value 17');
    assert(Math.abs(body[GOOD_BASE + 55]! / 65534 - 0.3979461043122654) < 1e-6, 'case 5: Frequency decodes to the fixture norm 0.3979461');
  }
}
