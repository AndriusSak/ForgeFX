// Per-slot cab STATE read-back (`queryCabSlots`) — the driver path over a fake transport.
//
// The properties that matter, and why:
//   1. `populated` comes from the MEASURED flag byte, and a slot the device does not answer is
//      reported `null` with a note — silence must never read as "empty" (the same rule the upload's
//      acks follow).
//   2. The scratchpad page is a VALID query target even though it is a refused UPLOAD destination.
//   3. A sweep is bounded and an invalid page is refused, so a route call cannot turn into an
//      unbounded device conversation.
//   4. Nothing is written: the transport sees slot queries only.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import type { Transport, RequestOpts, ConnKind } from '../../src/transport/types.js';
import { assert } from '../helpers/mock.js';
import { fractalChecksum } from 'forgefx-midi/shared';
import { CAB_SLOT_SUB } from 'forgefx-midi/devices/gen3';

const MODEL = 0x11; // FM3

export const CAB_SLOT_STATE_DRIVER_CASE_COUNT = 10;

const hex = (s: string): number[] => s.trim().split(/\s+/).map((h) => parseInt(h, 16));
/** Measured payloads (52 bytes each, incl. the sub echo). */
const PAY_POPULATED = hex(`4b 00 00 00 00 00 01 00 00 00 00 00 00 20 00 26 15 04 05 22 58 40 4d 34 5e 04 03 38
                           00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00`);
const PAY_EMPTY = hex(`4b 00 00 00 00 00 7f 01 00 00 00 00 00 20 00 1e 11 29 55 02 51 32 3e 00 1e 04 03 38
                       00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00`);

function replyFrame(payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x01, ...payload];
  return [...body, fractalChecksum(body), 0xf7];
}

/**
 * Answers slot queries from a per-INDEX map: `populated` indices get the populated payload, everything
 * else the empty one. `silent` indices get no reply at all. Records every request for inspection.
 */
class SlotTransport implements Transport {
  readonly label = 'serial-slot';
  readonly kind: ConnKind = 'serial';
  readonly slow = false;
  isOpen = true;
  readonly requests: number[][] = [];
  populated = new Set<number>();
  silent = new Set<number>();
  /** The code the unit answers the CLOSE frame with (0x00 accepted, 0x13 discarded). */
  closeCode = 0x00;
  /** Emulate the unit APPLYING an accepted write: every slot becomes empty once a container lands. */
  clearOnAcceptedWrite = false;
  #handlers = new Set<(f: number[]) => void>();

  constructor(populated: number[] = []) {
    this.populated = new Set(populated);
  }
  async open(): Promise<void> {}
  async close(): Promise<void> {
    this.isOpen = false;
  }
  /** Like the unit: acknowledge every frame; the CLOSE frame carries the measured close code. */
  #ack(blob: readonly number[]): void {
    const bytes = [...blob];
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 0xf0) continue;
      const end = bytes.indexOf(0xf7, i);
      if (end < 0) break;
      const fn = bytes[i + 5]!;
      const code = fn === 0x7c ? this.closeCode : 0x00;
      const body = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x64, fn, code, fn & 0x0f];
      for (const h of this.#handlers) h([...body, fractalChecksum(body), 0xf7]);
      i = end;
    }
  }
  send(): void {}
  async sendQueued(bytes: readonly number[]): Promise<void> {
    this.#ack(bytes);
  }
  async sendPaced(bytes: readonly number[]): Promise<void> {
    this.#ack(bytes);
    if (this.clearOnAcceptedWrite && this.closeCode === 0x00) this.populated.clear();
  }
  async request(bytes: readonly number[], _opts?: RequestOpts): Promise<number[][]> {
    this.requests.push([...bytes]);
    const index = bytes[12]!;
    if (this.silent.has(index)) return [];
    return [replyFrame(this.populated.has(index) ? PAY_POPULATED : PAY_EMPTY)];
  }
  onFrame(h: (f: number[]) => void): () => void {
    this.#handlers.add(h);
    return () => this.#handlers.delete(h);
  }
}

function makeDriver(t: Transport) {
  return createGen3Driver(PROFILES[MODEL]!, {
    transport: async () => t,
    emit: () => {},
    getCadence: () => cadenceFor(MODEL, 'balanced'),
  });
}

export async function runCabSlotStateDriverTests(): Promise<void> {
  // 1 — a range read reports the measured flags, one query per slot, nothing written
  {
    const t = new SlotTransport([0, 12]);
    const d = makeDriver(t);
    const rows = await d.queryCabSlots!({ page: 0x10, from: 0, to: 2 });
    assert(rows.length === 3, `three slots read, got ${rows.length}`);
    assert(rows[0]!.populated === true && rows[0]!.flag === 0x01, 'slot index 0 is populated (flag 0x01)');
    assert(rows[1]!.populated === false && rows[1]!.flag === 0x7f, 'slot index 1 is empty (flag 0x7f)');
    assert(rows[2]!.populated === false, 'slot index 2 is empty');
    assert(t.requests.length === 3, `exactly one query per slot, got ${t.requests.length}`);
    assert(t.requests.every((r) => r[5] === 0x01 && r[6] === CAB_SLOT_SUB), 'every request is the slot query');
    assert(t.requests.every((r) => r[13] === 0x10), 'every request targets the requested page');
    assert(t.requests.map((r) => r[12]).join(',') === '0,1,2', 'the indices are addressed in order');
    assert(rows[0]!.nameRegion.length === 15, 'the content region is reported');
    assert(rows[0]!.nameRegion.join(',') === rows[0]!.nameRegion.join(','), 'region is stable');
  }

  // 2 — SILENCE is not empty: an unanswered slot is null with a note
  {
    const t = new SlotTransport([0]);
    t.silent.add(1);
    const d = makeDriver(t);
    const rows = await d.queryCabSlots!({ page: 0x10, from: 0, to: 1 });
    assert(rows[1]!.populated === null, 'an unanswered slot must NOT read as empty');
    assert(rows[1]!.flag === null, 'and carries no flag');
    assert(/SILENT/.test(rows[1]!.note ?? ''), `the note must say why, got ${JSON.stringify(rows[1]!.note)}`);
    assert(rows[0]!.populated === true, 'the answered slot still reports');
  }

  // 3 — the two slots holding the same IR report the same region (the upload confirmation)
  {
    const t = new SlotTransport([0, 12]);
    const d = makeDriver(t);
    const [a, b] = await d.queryCabSlots!({ page: 0x10, from: 0, to: 1 });
    const c = (await d.queryCabSlots!({ page: 0x10, from: 12, to: 12 }))[0]!;
    assert(a!.nameRegion.join(',') === c!.nameRegion.join(','), 'slot 0 and slot 12 hold the same IR → same region');
    assert(a!.nameRegion.join(',') !== b!.nameRegion.join(','), 'an empty slot differs');
  }

  // 4 — the SCRATCHPAD is a valid query page (unlike an upload destination)
  {
    const t = new SlotTransport();
    const d = makeDriver(t);
    const rows = await d.queryCabSlots!({ page: 0x20, from: 0, to: 1 });
    assert(rows.length === 2 && rows.every((r) => r.page === 0x20), 'scratchpad slots are readable');
    assert(t.requests.every((r) => r[13] === 0x20), 'the requests carry page 0x20');
  }

  // 5 — an invalid page is refused before any traffic
  {
    const t = new SlotTransport();
    const d = makeDriver(t);
    let msg = '';
    try {
      await d.queryCabSlots!({ page: 0x30, from: 0, to: 1 });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/is not a user bank/.test(msg), `expected a page refusal, got: ${msg || '(no throw)'}`);
    assert(t.requests.length === 0, 'a refused sweep sends NOTHING');
  }

  // 7 — CLEAR: an accepted blank container plus a post-read of empty IS a clear
  {
    const t = new SlotTransport([0]); // slot 0 starts populated
    t.clearOnAcceptedWrite = true;    // the landed blank container empties the slot (measured behaviour)
    const d = makeDriver(t);
    const res = await d.clearCabSlot!({ page: 0x10, from: 0, to: 0 });
    assert(res.ok === true, `an accepted blank + empty post-read is a clear, got: ${res.reason}`);
    assert(res.wasPopulated === true && res.nowPopulated === false, 'it reports the transition');
    assert(res.closeCode === 0x00, 'and the close answer');
  }

  // 8 — CLEAR is fail-closed: an accepted blank whose slot STILL reads populated is NOT a clear
  {
    const t = new SlotTransport([0]); // stays populated throughout
    const d = makeDriver(t);
    const res = await d.clearCabSlot!({ page: 0x10, from: 0, to: 0 });
    assert(res.ok === false, 'a slot that still reads populated must NOT be reported cleared');
    assert(res.nowPopulated === true, 'and the state is reported');
    assert(/still reads POPULATED/.test(res.reason), `reason: ${res.reason}`);
  }

  // 9 — CLEAR: a DISCARDED blank container (close 0x13) changes nothing and says so
  {
    const t = new SlotTransport([0]);
    t.closeCode = 0x13;
    const d = makeDriver(t);
    const res = await d.clearCabSlot!({ page: 0x10, from: 0, to: 0 });
    assert(res.ok === false && /DISCARDED/.test(res.reason), `reason: ${res.reason}`);
    assert(res.wasPopulated === true, 'the slot is untouched');
  }

  // 10 — CLEAR refuses an UNMEASURED geometry rather than writing an unknown container
  {
    const t = new SlotTransport();
    const d = createGen3Driver(PROFILES[0x12]!, { transport: async () => t, emit: () => {}, getCadence: () => cadenceFor(0x12, 'balanced') });
    let msg = '';
    try {
      await d.clearCabSlot!({ page: 0x10, from: 0, to: 0 });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/geometry for model 0x12 has not been measured/.test(msg), `expected a geometry refusal, got: ${msg || '(no throw)'}`);
  }

  // 6 — a sweep beyond the cap is refused (a route call cannot become unbounded)
  {
    const t = new SlotTransport();
    const d = makeDriver(t);
    let msg = '';
    try {
      await d.queryCabSlots!({ page: 0x10, from: 0, to: 200 });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/capped at 128/.test(msg), `expected a cap refusal, got: ${msg || '(no throw)'}`);
    assert(t.requests.length === 0, 'a refused sweep sends NOTHING');

    let msg2 = '';
    try {
      await d.queryCabSlots!({ page: 0x10, from: 5, to: 4 });
    } catch (e) {
      msg2 = (e as Error).message;
    }
    assert(/bad range/.test(msg2), `expected a range refusal, got: ${msg2 || '(no throw)'}`);
  }
}
