// ────────────────────────────────────────────────────────────────────────────────
// probe-52-crux — READ-ONLY: read, in ONE session and for the SAME param, (a) the unit's own
// DEFINITION record (view 0x1c) and (b) the unit's own DISPLAY string (view 0x00).
//
// WHY. Round 18 measured 28/28 agreement between our table's cache bounds and the unit's view-0x1c
// records for the typecode-0x52 class, and on that basis REFUTED the earlier "this class is 0..10
// linear" reading. But the taper audit's own artifact says the opposite about the same rows: for the
// six 0x52 rows that carry a non-zero norm, the unit's display is EXACTLY 10 x norm
// (6.06/0.6064, 4.62/0.4621, 6.15/0.6152, 4.00/0.4004, 3.71/0.3713, 1.99/0.1990 — all = 10.00),
// and for the class's norm-0 rows the unit displays 0.00 where our table's MINIMUM is 0.5 / 0.1 /
// 200. `norm` is not a decode: the driver serves `clamp01(raw / 65534)`, a raw-byte readout that 235
// other rows corroborate. A displayed value BELOW our declared minimum cannot be fixed by any taper.
//
// So two measurements disagree about the same rows. This probe puts both in front of the unit at the
// same instant, and adds the controls the round-18 sweep never read: rows we KNOW the unit agrees
// with (0..10 rows, log frequency rows), so the record layout can be checked against a row whose
// display mapping is already settled rather than only against rows under dispute.
//
// It also sweeps view 0x1c and view 0x00 over param ids that DO NOT EXIST in a family. If the unit
// answers those, then "the record matched our table" is not by itself evidence that the address
// names the parameter — the fallback question the round-18 correction was itself about.
//
// NOTHING IS WRITTEN: view 0x1c and view 0x00 reads only. The unit's own display strings are the
// oracle; no value here is divided by our own decode.
//
// USAGE  npx tsx scripts/probe-52-crux.ts [--port /dev/ttyACM0] [--out <path.json>]
//        (the ForgeFX server must be stopped — one serial owner)
// ────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { patchNameQuery } from './standing-read.js';
import { adaptRequest } from '../src/services/deviceCache.js';
import type { Transport } from '../src/transport/types.js';
import { buildDefQuery, buildValueQuery, decodeReply, parseDisplayValue } from 'forgefx-midi/cache';
import { FM3_RANGES, FM3_RANGE_SECTIONS, fm3EffectId } from 'forgefx-midi/gen3/fm3';

const MODEL = 0x11;
const hex = (b: readonly number[]) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' ');

/** eid -> family, from the codec's own effect-id map (never a hand-kept list). */
function eidToFamily(): Map<number, string> {
  const m = new Map<number, string>();
  for (const fam of Object.keys(FM3_RANGE_SECTIONS)) {
    const eid = fm3EffectId(fam, 1);
    if (eid != null && !m.has(eid)) m.set(eid, fam);
  }
  return m;
}

/**
 * The rows this probe asks about. PROVEN rows are the controls: their display mapping is already
 * settled against the unit (0..10 rows and log frequency rows matched the audit exactly). CRUX rows
 * are the 0x52 rows whose device display the audit could not reproduce from our table.
 */
const PROVEN: [number, number, string][] = [
  [94, 1, 'Frequency Min (log, matched)'],
  [94, 4, 'Q Tracking (0..10, matched)'],
  [94, 9, 'Fat (0..10, matched)'],
  [118, 1, 'Drive 1 (0..10, matched)'],
  [118, 12, 'Bass (0..10, matched)'],
  [118, 8, 'Low Cut (log, matched)'],
  [62, 33, 'Drive (0x52, MATCHED after the taper fix)'],
  [70, 16, 'Low Cut (log, matched)'],
];
const CRUX: [number, number, string][] = [
  [94, 3, 'Resonance Q (0x52: unit 6.06, ours 129.15)'],
  [94, 10, 'Drive (0x52: unit 4.62, ours 4.675)'],
  [82, 20, 'Drive (0x52: unit 4.00, ours 20.049)'],
  [70, 22, 'Drive (0x52: unit 3.71, ours 185.97)'],
  [70, 58, 'Resonance (0x52: unit 1.99, ours 41.395)'],
  [118, 6, 'Slew Rate (0x52: unit 6.15, ours 61.907)'],
  [66, 32, 'Drive (0x52: unit 0.00, ours 0.1)'],
  [66, 54, 'Voice 1 Shift (unit 0.00, ours -24)'],
  [78, 20, 'Drive (0x52: unit 0.00, ours 0.5)'],
  [82, 26, 'Bass Focus (0x52: unit 0.00, ours 200)'],
];
/** Param ids that must NOT exist in the WAH family — the fallback check. */
const BOGUS: [number, number][] = [
  [94, 200],
  [94, 201],
  [94, 250],
  [94, 255],
];

interface Reply {
  view: string | null;
  tc?: number;
  id?: number;
  min?: number;
  max?: number;
  scale?: number;
  def?: number;
  step?: number;
  value?: string;
  label?: string;
  frameLen: number | null;
}

async function readView(transport: Transport, query: Uint8Array): Promise<Reply> {
  const frame = await adaptRequest(transport, query);
  if (!frame) return { view: null, frameLen: null };
  const dec = decodeReply(frame);
  if (!dec) return { view: null, frameLen: frame.length };
  if (dec.view === 'definition')
    return {
      view: 'definition',
      id: dec.id,
      tc: dec.tc,
      min: dec.min,
      max: dec.max,
      scale: dec.scale,
      def: dec.def,
      step: dec.step,
      frameLen: frame.length,
    };
  if (dec.view === 'value') return { view: 'value', value: dec.value, frameLen: frame.length };
  if (dec.view === 'enum_label') return { view: 'enum_label', label: dec.label, frameLen: frame.length };
  if (dec.view === 'string') return { view: 'string', label: dec.text, frameLen: frame.length };
  const fallback = dec as unknown as { view: string };
  return { view: fallback.view, frameLen: frame.length };
}

const num = (x: number | undefined) => (x == null || !Number.isFinite(x) ? '—' : String(Number(x.toPrecision(7))));

async function readWithRetry(transport: Transport, q: () => Uint8Array, tries = 3): Promise<Reply> {
  let last: Reply = { view: null, frameLen: null };
  for (let i = 0; i < tries; i += 1) {
    last = await readView(transport, q());
    if (last.view != null) return last;
  }
  return last;
}

export async function main(argv: string[]): Promise<number> {
  const argOf = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = argOf('--port');
  const out = argOf('--out');
  const eidFam = eidToFamily();

  const opened = await openProbeSession(MODEL, port);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  // In-session block params: the SAME read the server serves, taken over THIS connection. It turns the
  // comparison into one contemporaneous measurement instead of "a snapshot from earlier vs the unit now".
  // `norm` here is the driver's own raw-byte readout (clamp01(raw / 65534)) — not a decode of our tables.
  const bpCache = new Map<number, Map<number, { norm: number | null; value: number | null; min?: number; max?: number }>>();
  async function inSession(eid: number, pid: number) {
    if (!s.driver.blockParams) return null;
    let m = bpCache.get(eid);
    if (!m) {
      try {
        const bp = await s.driver.blockParams(eid);
        m = new Map(bp.named.map((p) => [p.id, { norm: p.norm, value: p.value, min: p.min, max: p.max }]));
      } catch {
        m = new Map();
      }
      bpCache.set(eid, m);
    }
    return m.get(pid) ?? null;
  }
  const artifact: {
    at: string;
    readOnly: string;
    presetName: string;
    provenance: string;
    controls: unknown[];
    crux: unknown[];
    bogus: unknown[];
  } = {
    at: new Date().toISOString(),
    readOnly: 'view 0x1c definition reads + view 0x00 display reads only',
    presetName: '',
    provenance:
      'addressed with fm3EffectId(family,1) as the fn-0x01 block byte; replies matched with the HW-proven adaptRequest (fn + view + block-high + both param bytes)',
    controls: [],
    crux: [],
    bogus: [],
  };

  try {
    // Identity: which preset is the unit actually on? Printed, never assumed.
    const nameFrames = await s.transport.request(patchNameQuery(MODEL), { timeoutMs: 900, quietMs: 60 });
    const nf = nameFrames.find((f) => f[5] === 0x0d);
    artifact.presetName = nf
      ? Array.from(nf.slice(6, -2)).filter((b) => b >= 0x20 && b < 0x7f).map((b) => String.fromCharCode(b)).join('').trim()
      : '';
    console.log(`device: ${s.label} (model 0x${MODEL.toString(16)}) · preset ${JSON.stringify(artifact.presetName)}`);
    console.log('READ-ONLY. “unit display” is the unit’s own view-0x00 string; “record” is its view-0x1c definition.');
    console.log('our row = FM3_RANGES[family][pid]: displayMin..displayMax (scale s → cache displayMin/s..displayMax/s)\n');
    console.log('fam/pid     our row: tc      kind   display        scale  cache bounds     | record: tc      min..max            scale  def    step');

    for (const [group, rows] of [
      ['controls', PROVEN],
      ['crux', CRUX],
    ] as const) {
      console.log(`\n── ${group.toUpperCase()} ────────────────────────────────────────────────────────────────────────`);
      for (const [eid, pid, why] of rows) {
        const fam = eidFam.get(eid) ?? `eid${eid}`;
        const row = FM3_RANGES[fam]?.[pid];
        const ours = row
          ? `${num(row.displayMin)}..${num(row.displayMax)}`.padEnd(14)
          : '(no row)'.padEnd(14);
        const cache = row
          ? `${num(row.displayMin / row.scale)}..${num(row.displayMax / row.scale)}`.padEnd(16)
          : '—'.padEnd(16);
        const rec = await readWithRetry(s.transport, () => buildDefQuery(MODEL, eid, pid));
        // Read the display TWICE: a value that moves on its own is not a measurement.
        const d1 = await readWithRetry(s.transport, () => buildValueQuery(MODEL, eid, pid));
        const d2 = await readWithRetry(s.transport, () => buildValueQuery(MODEL, eid, pid));
        const disp = d1.value ?? d1.label ?? (d1.view == null ? '—' : `(${d1.view})`);
        const parsed1 = d1.value != null ? parseDisplayValue(d1.value) : null;
        const parsed2 = d2.value != null ? parseDisplayValue(d2.value) : null;
        const stable = parsed1 != null && parsed2 != null ? (parsed1 === parsed2 ? 'stable' : `MOVES ${parsed1}/${parsed2}`) : '—';
        console.log(
          `${`${fam}/${pid}`.padEnd(11)} ${ours} 0x${(row ? row.typecode : 0).toString(16).padEnd(5)} ` +
            `${String(row?.kind ?? '—').padEnd(6)} ${disp.padEnd(14)} ${num(row?.scale).padEnd(6)} ${cache} | ` +
            `${rec.view === 'definition' ? `0x${(rec.tc ?? 0).toString(16)}`.padEnd(9) : '—'.padEnd(9)} ` +
            `${`${num(rec.min)}..${num(rec.max)}`.padEnd(20)} ${num(rec.scale).padEnd(6)} ${num(rec.def).padEnd(6)} ${num(rec.step).padEnd(6)}`
        );
        const live = await inSession(eid, pid);
        const ratio =
          live?.norm != null && live.norm > 0 && parsed1 != null ? Number((parsed1 / live.norm).toPrecision(4)) : null;
        console.log(
          `            ${why}\n            unit display 1 = ${JSON.stringify(d1.value ?? null)}  display 2 = ${JSON.stringify(d2.value ?? null)}  ` +
            `(${stable})  frameLen ${d1.frameLen ?? 'none'}  parsed ${parsed1 ?? '—'}\n` +
            `            SAME SESSION: norm ${live?.norm ?? '—'} → served value ${live?.value ?? '—'} (our min..max ${num(live?.min)}..${num(live?.max)})` +
            `${ratio != null ? `  ·  unit display / norm = ${ratio}` : ''}`
        );
        const entry = {
          fam,
          eid,
          pid,
          why,
          ourRow: row
            ? {
                typecode: row.typecode,
                kind: row.kind,
                displayMin: row.displayMin,
                displayMax: row.displayMax,
                scale: row.scale,
                cacheMin: row.displayMin / row.scale,
                cacheMax: row.displayMax / row.scale,
              }
            : null,
          record: rec,
          display1: d1.value ?? null,
          display2: d2.value ?? null,
          parsed1,
          parsed2,
          stable,
          sameSession: live,
          displayOverNorm: ratio,
        };
        if (group === 'controls') artifact.controls.push(entry);
        else artifact.crux.push(entry);
      }
    }

    // ── THE FALLBACK CHECK ───────────────────────────────────────────────────────────────────────
    // If the unit answers view 0x1c (or view 0x00) for a param id that cannot exist, then a reply is
    // not by itself evidence the address names a parameter.
    console.log('\n── BOGUS PARAM IDS (must not exist in WAH) ─────────────────────────────────────────────────');
    for (const [eid, pid] of BOGUS) {
      const rec = await readWithRetry(s.transport, () => buildDefQuery(MODEL, eid, pid), 2);
      const val = await readWithRetry(s.transport, () => buildValueQuery(MODEL, eid, pid), 2);
      console.log(
        `WAH/${pid}: record ${rec.view ?? 'NO REPLY'}${rec.view === 'definition' ? ` tc=0x${(rec.tc ?? 0).toString(16)} ${num(rec.min)}..${num(rec.max)} scale ${num(rec.scale)}` : ''} · ` +
          `display ${val.view ?? 'NO REPLY'}${val.value != null ? ` ${JSON.stringify(val.value)}` : ''}`
      );
      artifact.bogus.push({ eid, pid, record: rec, display: val });
    }

    console.log('\nreminder: this probe asserts NOTHING about which side is right — it puts the unit’s');
    console.log('definition record and the unit’s display string for the SAME address on one line, and');
    console.log('prints the controls whose mapping is already settled, so a reader can see whether the two');
    console.log('device-sourced views agree with each other for the rows we dispute.');

    if (out) {
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), JSON.stringify(artifact, null, 2));
      console.log(`artifact: ${resolve(out)}`);
    }
    return 0;
  } finally {
    await s.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
