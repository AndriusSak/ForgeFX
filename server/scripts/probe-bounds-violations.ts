// ────────────────────────────────────────────────────────────────────────────────
// probe-bounds-violations — READ-ONLY: the GENERAL form of the typecode-0x52 bug, swept over the table.
//
// WHY. The 0x52 defect was found by accident and cost three rounds: our generated bounds for a class of
// rows were not the unit's display mapping, so the app served 129.15 where the unit showed 6.06. The
// detector that settles that class did NOT need the taper question at all — it was this:
//
//     a row whose unit display falls OUTSIDE its declared [displayMin, displayMax] is WRONG,
//     whatever the taper is. No monotone map onto a range can produce a value outside it.
//
// That test needs no knowledge of the encoding, no `def` field and no round-trip through our own
// decode: just the unit's own view-0x00 display string and the bounds we ship. This probe applies it to
// EVERY float param of EVERY block the unit will answer, and reports three classes separately:
//
//   OUTSIDE-BOUNDS  device display < our min or > our max  -> our bounds are provably wrong (taper-agnostic)
//   SHAPE           inside the bounds but the served value differs beyond the display's own precision
//                   -> the taper/taper-shape is wrong, or the raw we read is not the one displayed
//   match           everything else, with a separate count for matches that only pass because the
//                   display is coarse
//
// It also reports, per row, the ratio `unit display / norm` when the row's minimum is 0 — for a
// zero-floor linear row that ratio IS the implied maximum, which is how the 0x52 class was cracked.
//
// NOTHING IS WRITTEN: view 0x00 display reads + the driver's own bulk read, both read-only.
//
// USAGE  npx tsx scripts/probe-bounds-violations.ts [--port /dev/ttyACM0] [--out <path.json>]
//        [--max-eids N]   (default 48 — every effect id the unit will answer, one bulk read each)
//        (the ForgeFX server must be stopped — one serial owner)
// ────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { patchNameQuery } from './standing-read.js';
import { adaptRequest } from '../src/services/deviceCache.js';
import type { Transport } from '../src/transport/types.js';
import { buildValueQuery, decodeReply, parseDisplayValue } from 'forgefx-midi/cache';
import { FM3_EFFECT_ID_TABLE } from 'forgefx-midi/gen3/fm3';

const MODEL = 0x11;

/** Every effect id the codec knows, in a stable order (ascending), ALL instances included. */
function effectIds(): number[] {
  const ids: number[] = [];
  for (const e of FM3_EFFECT_ID_TABLE) {
    if (e.firstId == null) continue; // GLOBAL/PRESET system data, MOD sub-records: no wire effectId
    for (let k = 0; k < Math.max(1, e.instances); k += 1) ids.push(e.firstId + k);
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Half the last printed digit of the unit's own string — the quantisation the unit builds in. */
function toleranceFromDisplay(disp: string, ours: number): { tol: number; ulp: number } {
  const m = /-?\d+(?:\.(\d+))?/.exec(disp);
  const decimals = m && m[1] ? m[1].length : 0;
  const ulp = Math.pow(10, -decimals);
  return { tol: Math.max(ulp / 2, Math.abs(ours) * 1e-6), ulp };
}

async function unitDisplay(transport: Transport, eid: number, pid: number): Promise<string | null> {
  const frame = await adaptRequest(transport, buildValueQuery(MODEL, eid, pid));
  if (!frame) return null;
  const dec = decodeReply(frame);
  return dec && dec.view === 'value' ? dec.value : null;
}

interface Row {
  eid: number;
  family: string;
  pid: number;
  name: string;
  min: number;
  max: number;
  norm: number | null;
  served: number | null;
  display: string | null;
  parsed: number | null;
  tol: number | null;
  klass: 'match' | 'match (coarse display)' | 'SHAPE' | 'OUTSIDE-BOUNDS' | 'UNREADABLE' | 'UNPARSED';
  ratio: number | null;
}

export async function main(argv: string[]): Promise<number> {
  const argOf = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = argOf('--port');
  const out = argOf('--out');
  const maxEids = Number(argOf('--max-eids') ?? 48);

  const opened = await openProbeSession(MODEL, port);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  const rows: Row[] = [];
  const artifact = {
    at: new Date().toISOString(),
    presetName: '',
    readOnly: 'view 0x00 display reads + the driver bulk read only',
    rule: 'unit display outside our declared [min,max] => the bounds are wrong (taper-independent)',
    rows: [] as Row[],
  };

  try {
    const nf = (await s.transport.request(patchNameQuery(MODEL), { timeoutMs: 900, quietMs: 60 })).find((f) => f[5] === 0x0d);
    artifact.presetName = nf
      ? Array.from(nf.slice(6, -2)).filter((b) => b >= 0x20 && b < 0x7f).map((b) => String.fromCharCode(b)).join('').trim()
      : '';
    console.log(`device: ${s.label} · preset ${JSON.stringify(artifact.presetName)} · READ-ONLY`);

    const ids = effectIds().slice(0, maxEids);
    console.log(`sweeping up to ${ids.length} effect ids …\n`);
    console.log('eid  fam       pid  name                 declared           served        unit display     tol       ratio  verdict');

    for (const eid of ids) {
      let named: { id: number; name?: string; value: number | null; norm: number | null; min?: number; max?: number }[] = [];
      let fam = '';
      try {
        const bp = await s.driver.blockParams(eid);
        named = bp.named;
        fam = bp.block;
      } catch {
        continue; // no roster for this id on this unit
      }
      if (!named.length) continue;
      for (const p of named) {
        if (p.min == null || p.max == null || !Number.isFinite(p.min) || !Number.isFinite(p.max)) continue;
        if (p.min === p.max) continue;
        const disp = await unitDisplay(s.transport, eid, p.id);
        const parsed = disp != null ? parseDisplayValue(disp) : null;
        let klass: Row['klass'];
        let tol: number | null = null;
        let ratio: number | null = null;
        if (disp == null) klass = 'UNREADABLE';
        else if (parsed == null) klass = 'UNPARSED';
        else {
          const t = toleranceFromDisplay(disp, p.value ?? 0);
          tol = t.tol;
          const lo = Math.min(p.min, p.max) - t.tol;
          const hi = Math.max(p.min, p.max) + t.tol;
          if (parsed < lo || parsed > hi) klass = 'OUTSIDE-BOUNDS';
          else if (p.value != null && Math.abs(p.value - parsed) > t.tol) klass = 'SHAPE';
          else klass = p.value != null && Math.abs(p.value - parsed) > t.ulp / 4 ? 'match (coarse display)' : 'match';
          if (p.norm != null && p.norm > 0) ratio = Number((parsed / p.norm).toPrecision(4));
        }
        const row: Row = {
          eid,
          family: fam,
          pid: p.id,
          name: p.name ?? '',
          min: p.min,
          max: p.max,
          norm: p.norm ?? null,
          served: p.value ?? null,
          display: disp,
          parsed,
          tol,
          klass,
          ratio,
        };
        rows.push(row);
        if (klass !== 'match' && klass !== 'match (coarse display)') {
          console.log(
            `${String(eid).padStart(3)}  ${String(fam).padEnd(9)} ${String(p.id).padStart(3)}  ${(p.name ?? '').slice(0, 19).padEnd(19)}  ` +
              `${`${p.min}..${p.max}`.padEnd(17)}  ${String(p.value).padEnd(12)}  ${String(disp ?? '—').padEnd(15)}  ${String(tol).padEnd(8)}  ${String(ratio ?? '—').padEnd(6)}  ${klass}`
          );
        }
      }
    }

    const count = (k: Row['klass']) => rows.filter((r) => r.klass === k).length;
    const violations = rows.filter((r) => r.klass === 'OUTSIDE-BOUNDS');
    const shapes = rows.filter((r) => r.klass === 'SHAPE');
    console.log(
      `\nsummary: ${rows.length} rows checked — ${count('match')} match, ${count('match (coarse display)')} match(coarse), ` +
        `${violations.length} OUTSIDE-BOUNDS, ${shapes.length} SHAPE, ${count('UNREADABLE')} unreadable, ${count('UNPARSED')} unparsed`
    );
    if (violations.length) {
      console.log('\n--- OUTSIDE OUR DECLARED BOUNDS (our bounds are wrong; no taper can explain these) ---');
      const byFamily = new Map<string, number>();
      for (const v of violations) byFamily.set(v.family, (byFamily.get(v.family) ?? 0) + 1);
      for (const [f, n] of [...byFamily.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${f}: ${n} row(s)`);
    }
    if (shapes.length) {
      console.log('\n--- INSIDE THE BOUNDS BUT THE SERVED VALUE DIFFERS BEYOND THE DISPLAY’S PRECISION ---');
      for (const v of shapes.slice(0, 40))
        console.log(`    ${v.family}/${v.pid} ${v.name}: ours ${v.served} vs unit ${v.parsed} (declared ${v.min}..${v.max})`);
    }

    artifact.rows = rows;
    if (out) {
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), JSON.stringify({ ...artifact, summary: { checked: rows.length, violations: violations.length, shapes: shapes.length } }, null, 2));
      console.log(`artifact: ${resolve(out)}`);
    }
    return violations.length || shapes.length ? 1 : 0;
  } finally {
    await s.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
