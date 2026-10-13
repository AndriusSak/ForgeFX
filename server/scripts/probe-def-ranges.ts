// ────────────────────────────────────────────────────────────────────────────────
// probe-def-ranges — READ-ONLY: ask the UNIT for the DEFINITION record (view 0x1c) of every range row
// whose typecode nibble is 5, and compare it against our own generated table.
//
// WHY: `FM3_RANGES` (forgefx-midi/src/gen3/fm3/ranges.generated.ts) is generated OUTSIDE this package
// ("The generator is maintained outside this package; only this derived DATA file ships here") and carries
// no FM3 CaptureRig capture. Its nibble-5 rows (typecode 0x52) are served with a taper that is NOT log10
// (fixed 2026-10-13) and with bounds the instrument's own display has never corroborated.
//
// ─── THE ADDRESSING BUG THIS FILE USED TO HAVE (found by review 2026-10-13, fixed here) ───────────────
// The first version sent the family's CACHE SECTION TAG as the `block` byte — CABINET=11, DELAY=13,
// WAH=20, straight out of `FM3_RANGE_SECTIONS` — and concluded, from replies that were identical
// index-for-index, that view 0x1c is not a per-(family,param) range at all. **That conclusion was an
// artefact of the query.** `cache/assign.ts` says it outright: in the live self-describe walk "the
// 'section' is the fn-0x01 block id, which bears no relation to the cache section tag". The fn-0x01 block
// byte is the EFFECT ID (Cab 62, Delay 70, Wah 94, …), which is also how the taper audit addresses view
// 0x00 — and that audit matches the unit on 235/251 params. Section tags 11/13/20 are unassigned effect
// ids, so the device answered them from one shared fallback table: identical records, garbage at block 0,
// and no reaction to anything, including the owner changing the unit's selected block. Addressed by
// EFFECT ID the replies vary per block. Never address fn-0x01 with a cache section tag.
//
// ─── WHAT IS COMPARED (and what is NOT) ───────────────────────────────────────────────────────────────
// Our row's `displayMin/displayMax` are DEFINED as `cache min/max * scale`, so our cache-side bounds are
// `displayMin / scale` and `displayMax / scale`, and the comparison is made there. Our row's `scale` is NOT
// demanded to equal the wire's scale field: a review measured that `FM3_RANGES.scale` is taken from the
// cache record's `def` slot (`assign.ts`: `scale: f32clean(r.def)`) while `liveWalk.ts` documents the
// wire's offset-16 `scale` as a different field — requiring equality there would fail every row for a
// reason about field identity, not about the device. BOTH scales are printed so the question stays
// visible instead of being assumed away.
//
// The class is DERIVED from the table at run time — never a hand-kept list. CONTROLS are the same
// families' nibble-4 rows (the frequency-cut class the taper heuristic was derived from and which the unit
// is measured to agree with); a control that cannot fail is not a control, so they are real rows.
//
// NOTHING IS WRITTEN: view 0x1c definition reads only.
//
// USAGE  npx tsx scripts/probe-def-ranges.ts [--port /dev/ttyACM0] [--controls] [--out <path.json>]
//        (the ForgeFX server must be stopped — one serial owner)
// ────────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { buildDefQuery, decodeReply } from 'forgefx-midi/cache';
import { FM3_RANGES, FM3_RANGE_SECTIONS, fm3EffectId } from 'forgefx-midi/gen3/fm3';

const MODEL = 0x11;
const NIBBLE = 5;

interface Row {
  fam: string;
  block: number;
  pid: number;
  kind: string;
  dmin: number;
  dmax: number;
  scale: number;
  step: number;
  typecode: number;
  control: boolean;
}

const fmt = (x: number) => (Number.isFinite(x) ? String(Number(x.toPrecision(7))) : String(x));
const near = (a: number, b: number) =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-6);

/** Derive the class from the table itself: nibble-5 rows, plus each family's first nibble-4 row as control. */
function collect(wantControls: boolean): Row[] {
  const out: Row[] = [];
  const mk = (
    r: Readonly<{ kind: string; displayMin: number; displayMax: number; scale: number; step: number; typecode: number }>,
    fam: string,
    pid: number,
    control: boolean
  ): Row | null => {
    const block = fm3EffectId(fam, 1);
    if (block == null) return null; // this family has no wire effect id
    return {
      fam,
      block,
      pid,
      kind: r.kind,
      dmin: r.displayMin,
      dmax: r.displayMax,
      scale: r.scale,
      step: r.step,
      typecode: r.typecode,
      control,
    };
  };
  for (const [fam, ids] of Object.entries(FM3_RANGES)) {
    if (!FM3_RANGE_SECTIONS[fam]) continue;
    for (const [pidStr, r] of Object.entries(ids)) {
      if (((r.typecode >> 4) & 0xf) !== NIBBLE) continue;
      const row = mk(r, fam, Number(pidStr), false);
      if (row) out.push(row);
    }
  }
  if (wantControls) {
    for (const fam of [...new Set(out.map((r) => r.fam))]) {
      const ids = FM3_RANGES[fam];
      if (!ids) continue;
      for (const [pidStr, r] of Object.entries(ids)) {
        if (((r.typecode >> 4) & 0xf) !== 4) continue;
        const row = mk(r, fam, Number(pidStr), true);
        if (row) out.push(row);
        break;
      }
    }
  }
  return out.sort((a, b) => a.fam.localeCompare(b.fam) || a.pid - b.pid);
}

export async function main(argv: string[]): Promise<number> {
  const argOf = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = argOf('--port');
  const out = argOf('--out');
  const rows = collect(argv.includes('--controls'));
  if (!rows.length) {
    console.log('no rows — the table has no nibble-5 rows, or none of their families has a wire effect id');
    return 2;
  }

  const opened = await openProbeSession(MODEL, port);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  let agree = 0;
  let differ = 0;
  let unreadable = 0;
  let tcAgree = 0;
  const artifact: { at: string; addressSpace: string; readOnly: string; rows: unknown[] } = {
    at: new Date().toISOString(),
    addressSpace: 'block byte = fn-0x01 EFFECT ID (fm3EffectId(family,1)) — NOT the cache section tag',
    readOnly: 'view 0x1c definition reads only',
    rows: [],
  };

  try {
    console.log(`device: ${s.label} (model 0x${MODEL.toString(16)}) · READ-ONLY (view 0x1c)`);
    console.log(
      `asking for ${rows.length} rows (${rows.filter((r) => !r.control).length} nibble-5, ${rows.filter((r) => r.control).length} controls), addressed by EFFECT ID\n`
    );
    console.log('fam/pid        ctl  eid  ours:cache min..max   device tc    device min..max        verdict');
    console.log('-------------  ---  ---  ---------------------  -----------  ---------------------  --------------------');

    for (const row of rows) {
      let def: { tc: number; min: number; max: number; scale: number; step: number } | null = null;
      for (let attempt = 0; attempt < 3 && def == null; attempt += 1) {
        const frames = await s.transport.request(buildDefQuery(MODEL, row.block, row.pid), {
          timeoutMs: 900,
          quietMs: 60,
        });
        const dec = frames.length ? decodeReply(Uint8Array.from(frames[frames.length - 1]!)) : null;
        if (dec && dec.view === 'definition') {
          def = { tc: dec.tc, min: dec.min, max: dec.max, scale: dec.scale, step: dec.step };
        }
      }
      const label = `${row.fam}/${row.pid}`.padEnd(13);
      const ctl = row.control ? 'ctl' : '   ';
      const oursMin = row.scale !== 0 ? row.dmin / row.scale : NaN;
      const oursMax = row.scale !== 0 ? row.dmax / row.scale : NaN;
      const mine = `${fmt(oursMin)}..${fmt(oursMax)}`;
      if (!def) {
        unreadable += 1;
        console.log(`${label}  ${ctl}  ${String(row.block).padStart(3)}  ${mine.padEnd(21)}  ${'—'.padEnd(11)}  ${'—'.padEnd(21)}  NO DEFINITION RECORD`);
        artifact.rows.push({ ...row, device: null });
        continue;
      }
      if (def.tc === row.typecode) tcAgree += 1;
      const bounds = near(oursMin, def.min) && near(oursMax, def.max);
      if (bounds) agree += 1;
      else differ += 1;
      const scaleNote = row.scale !== def.scale ? `   [our scale ${fmt(row.scale)} vs wire ${fmt(def.scale)}]` : '';
      console.log(
        `${label}  ${ctl}  ${String(row.block).padStart(3)}  ${mine.padEnd(21)}  0x${def.tc
          .toString(16)
          .padEnd(9)}  ${`${fmt(def.min)}..${fmt(def.max)}`.padEnd(21)}  ${
          bounds ? 'bounds MATCH' : 'bounds DIFFER'
        }${scaleNote}`
      );
      artifact.rows.push({ ...row, oursCacheMin: oursMin, oursCacheMax: oursMax, device: def, boundsMatch: bounds });
    }

    console.log(`\nsummary: ${agree} bounds MATCH, ${differ} bounds DIFFER, ${unreadable} unreadable`);
    console.log(
      `typecodes: ${tcAgree}/${rows.length} rows agree with our table's typecode — a typecode that disagrees means the two sides are not describing the same parameter`
    );
    console.log(
      `controls: ${rows.filter((r) => r.control).map((r) => `${r.fam}/${r.pid}`).join(', ') || '(none — pass --controls)'}`
    );
    if (out) {
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), JSON.stringify(artifact, null, 2));
      console.log(`artifact: ${resolve(out)}`);
    }
    return differ > 0 ? 1 : 0;
  } finally {
    await s.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
