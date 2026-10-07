// P1.3 — a TORN block bulk read must NOT be served as a complete block.
//
// The fn=0x1F whole-block read arrives as a 0x74 head (blockId + advertised itemCount), one or more
// paged 0x75 body sections, and a 0x76 end. blockParams() decoded it inside a try and, on ANY throw,
// reset ONLY `named` and fell through to a zero-filled knob fallback — swallowing the failure. The
// handler (runtime/handlers.ts#blockParamsH) then saw a normal return, so a torn/failed read was
// answered 200 as a valid-looking snapshot (every knob 0, no enums, no type) instead of surfacing.
//
// Two torn shapes are covered:
//   A. a MALFORMED 0x75 body (too short to parse) → assembleGen3BlockBulkRead throws;
//   B. a SHORT-but-well-formed burst: a valid 0x74 head advertising itemCount values, but the 0x75
//      sections carry fewer (a dropped page) → assemble returns fewer values than advertised with NO
//      throw, and the `?? 0` reads silently zero the missing tail params.
// Both must reject so blockParamsH's existing 404 + {error} mapping applies. The success path must
// stay intact (a complete burst still decodes real values).
//
// Mocked transport + the REAL static FM3 profile: no hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { createUnifiedHandlers, type StatusSink } from '../../src/runtime/handlers.js';
import type { DeviceRegistry } from '../../src/drivers/registryCore.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const AMP_EID = effectRoster().find((e) => e.slug === 'amp')!.page;
const STRIDE = PROFILES[MODEL]!.rangeSections['DISTORT']!.stride; // AMP/DISTORT body stride (144)

export const BLOCK_READ_FAILURE_CASE_COUNT = 6;

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
/** 0x74 head advertising an itemCount (so a short body is detectable as torn). */
const head = (effectId: number, itemCount: number) => sysex(0x74, [...enc14(effectId), ...enc14(itemCount), 0x07]);
/** 0x75 body carrying `values` (3-septet packed, one per paramId). */
function body(values: readonly number[]): number[] {
  const b: number[] = [0x00, 0x02];
  for (const v of values) b.push(...packValue16(v));
  return sysex(0x75, b);
}
const end = () => sysex(0x76, []);

/** A complete burst: head advertising `values.length`, one full body, end. */
function completeBurst(effectId: number, values: readonly number[]): number[][] {
  return [head(effectId, values.length), body(values), end()];
}

/** Drive blockParams over a mocked transport whose bulk-read poll answers with `frames()`. */
function makeDriver(frames: () => number[][]) {
  const profile = PROFILES[MODEL]!;
  const codec = createModernFractalCodec(profile.model);
  const mock = new MockTransport('serial', 'mock-block-read-failure');
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(AMP_EID)) ? frames() : []);
  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(profile.model, 'balanced'),
  });
  return driver;
}

/** Assert `fn()` rejects; throws (failing the suite) when it resolves. */
async function rejects(fn: () => Promise<unknown>, msg: string): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(msg);
}

class Sink implements StatusSink {
  status: number | undefined;
  code(statusCode: number): unknown { this.status = statusCode; return this; }
}

export async function runBlockReadFailureTests(): Promise<void> {
  // ── A. malformed 0x75 body → the decode throws and must NOT be swallowed into a 200 ──
  const malformed = makeDriver(() => [head(AMP_EID, STRIDE * 4), sysex(0x75, []), end()]);
  await rejects(() => malformed.blockParams(AMP_EID), 'case 1: a malformed 0x75 body must reject, not return a zeroed snapshot');

  // ── B. short-but-valid burst (head advertises 4 channels, only a partial body arrives) ──
  const torn = new Array(200).fill(0); // < STRIDE*4 → a dropped page
  const short = makeDriver(() => [head(AMP_EID, STRIDE * 4), body(torn), end()]);
  await rejects(() => short.blockParams(AMP_EID), 'case 2: a short (torn) body must reject, not be served as a complete block');

  // ── the handler maps the thrown decode to the repo's existing 404 + {error} shape ──
  const handlerFor = (d: ReturnType<typeof makeDriver>) => {
    const reg = { driver: async () => d } as unknown as DeviceRegistry;
    return createUnifiedHandlers(reg);
  };
  const sinkA = new Sink();
  const bodyA = (await handlerFor(malformed).blockParamsH(sinkA, AMP_EID)) as { error?: string };
  assertEqual(sinkA.status, 404, 'case 3: a torn read answers 404, not 200');
  assert(typeof bodyA.error === 'string' && bodyA.error.length > 0, 'case 4: the 404 body carries a non-empty error');

  // ── success path unchanged: a COMPLETE burst still decodes real values (all-max → every norm 1) ──
  const full = makeDriver(() => completeBurst(AMP_EID, new Array(STRIDE * 4).fill(65534)));
  const ok = await full.blockParams(AMP_EID);
  assert(ok.named.length > 0, 'case 5: a complete burst still yields knobs');
  assert(ok.named.every((n) => n.norm === 1), 'case 5: every knob reflects the real 0..65534 wire value (norm 1), not the zeroed fallback');

  const sinkOk = new Sink();
  const bodyOk = (await handlerFor(full).blockParamsH(sinkOk, AMP_EID)) as { named?: unknown[] };
  assertEqual(sinkOk.status, undefined, 'case 6: a good read never sets an error status');
  assert(Array.isArray(bodyOk.named) && bodyOk.named.length > 0, 'case 6: a good read still answers the block snapshot');
}
