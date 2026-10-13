// ────────────────────────────────────────────────────────────────────────────────
// probe-def-ranges — READ-ONLY: ask the UNIT for the DEFINITION record (view 0x1c) of every range row
// whose typecode nibble is 5, and compare it against our own generated table.
//
// WHY: `FM3_RANGES` (forgefx-midi/src/gen3/fm3/ranges.generated.ts) is generated OUTSIDE this package
// ("The generator is maintained outside this package; only this derived DATA file ships here"), and it
// carries no FM3 CaptureRig capture. Its nibble-5 rows (typecode 0x52) are served with a taper that is
// NOT log10 (fixed 2026-10-13) AND with min/max that do not match the instrument's own display
// (e.g. WAH_Q row 20..200 while the unit shows 6.06 at norm 0.6064 → implied 0..10). Seven rows were
// resolved that way by inference; this probe replaces the inference with the device's OWN numbers.
//
// The definition record states min/max/scale/def/step directly:
//   u32 id, u32 tc, f32 min, f32 max, f32 scale, f32 def, f32 step, u32 0, u32 0   (36 bytes, LE)
// and our row's `displayMin/displayMax` are defined as `cache min/max * scale`, so the comparison is
// term-by-term and cannot be satisfied by two errors cancelling.
//
// The class is DERIVED from the table at run time — never a hand-kept list (a count-shaped list rots).
// CONTROLS are included BY CONSTRUCTION: rows from the same families whose nibble is 4 (the
// frequency-cut class the taper heuristic was derived from and which the unit is known to agree with).
// A control that cannot fail is not a control, so the control rows are real rows with real values.
//
// NOTHING IS WRITTEN: view 0x1c definition reads only.
//
// USAGE  npx tsx scripts/probe-def-ranges.ts [--port /dev/ttyACM0] [--controls]
//        (the ForgeFX server must be stopped — one serial owner)
// ────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { buildDefQuery, decodeReply } from 'forgefx-midi/cache';
import { FM3_RANGES, FM3_RANGE_SECTIONS } from 'forgefx-midi/gen3/fm3';

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

/** Derive the class from the table itself: nibble-5 rows, plus nibble-4 rows as controls. */
function collect(controls: boolean): Row[] {
  const out: Row[] = [];
  for (const [fam, ids] of Object.entries(FM3_RANGES)) {
    const meta = FM3_RANGE_SECTIONS[fam];
    if (!meta) continue;
    for (const [pidStr, r] of Object.entries(ids)) {
      const nib = (r.typecode >> 4) & 0xf;
      if (nib !== NIBBLE) continue;
      out.push({
        fam,
        block: meta.sectionTag,
        pid: Number(pidStr),
        kind: r.kind,
        dmin: r.displayMin,
        dmax: r.displayMax,
        scale: r.scale,
        step: r.step,
        typecode: r.typecode,
        control: false,
      });
    }
  }
  if (controls) {
    // Controls: the FIRST nibble-4 row of each family that appears in the class, so the control sits in
    // the same section and the same code path as the row under test.
    const fams = [...new Set(out.map((r) => r.fam))];
    for (const fam of fams) {
      const ids = FM3_RANGES[fam];
      const meta = FM3_RANGE_SECTIONS[fam];
      if (!ids || !meta) continue;
      for (const [pidStr, r] of Object.entries(ids)) {
        if (((r.typecode >> 4) & 0xf) !== 4) continue;
        out.push({
          fam,
          block: meta.sectionTag,
          pid: Number(pidStr),
          kind: r.kind,
          dmin: r.displayMin,
          dmax: r.displayMax,
          scale: r.scale,
          step: r.step,
          typecode: r.typecode,
          control: true,
        });
        break;
      }
    }
  }
  return out.sort((a, b) => a.fam.localeCompare(b.fam) || a.pid - b.pid);
}

const fmt = (x: number) => (Number.isFinite(x) ? String(Number(x.toPrecision(7))) : String(x));

export async function main(argv: string[]): Promise<number> {
  const portAt = argv.indexOf('--port');
  const port = portAt >= 0 ? argv[portAt + 1] : undefined;
  const withControls = argv.includes('--controls');
  const rows = collect(withControls);

  const opened = await openProbeSession(MODEL, port);
  if (!opened.ok) {
    console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  let agree = 0;
  let differ = 0;
  let unreadable = 0;
  const diffs: string[] = [];

  try {
    console.log(`device: ${s.label} (model 0x${MODEL.toString(16)}) · READ-ONLY (view 0x1c definition)`);
    console.log(`asking for ${rows.length} rows (${rows.filter((r) => !r.control).length} nibble-5, ${rows.filter((r) => r.control).length} controls)\n`);
    console.log('fam/pid        ctl  ours(min..max xscale)     device(min..max xscale)   device step  verdict');
    console.log('-------------  ---  ------------------------  ------------------------  -----------  -------');

    for (const row of rows) {
      let def = null as null | { min: number; max: number; scale: number; step: number; tc: number; kind: string };
      for (let attempt = 0; attempt < 3 && def == null; attempt += 1) {
        const frames = await s.transport.request(buildDefQuery(MODEL, row.block, row.pid), {
          timeoutMs: 900,
          quietMs: 60,
        });
        const dec = frames.length ? decodeReply(Uint8Array.from(frames[frames.length - 1]!)) : null;
        if (dec && dec.view === 'definition') {
          def = { min: dec.min, max: dec.max, scale: dec.scale, step: dec.step, tc: dec.tc, kind: dec.kind };
        }
      }
      const label = `${row.fam}/${row.pid}`.padEnd(13);
      const ctl = row.control ? 'ctl' : '   ';
      if (!def) {
        unreadable += 1;
        console.log(`${label}  ${ctl}  ${`${fmt(row.dmin)}..${fmt(row.dmax)} x${fmt(row.scale)}`.padEnd(24)}  ${'—'.padEnd(24)}  ${'—'.padEnd(11)}  NO DEFINITION RECORD`);
        diffs.push(`${label}: no definition record (row says ${row.dmin}..${row.dmax} x${row.scale})`);
        continue;
      }
      // Our row's display range is DEFINED as cache min/max * scale, so compare in cache units on both
      // sides: our implied cache min/max are dmin/scale and dmax/scale.
      const oursMin = row.scale !== 0 ? row.dmin / row.scale : NaN;
      const oursMax = row.scale !== 0 ? row.dmax / row.scale : NaN;
      const near = (a: number, b: number) =>
        Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-6);
      const ok = near(oursMin, def.min) && near(oursMax, def.max) && near(row.scale, def.scale);
      if (ok) agree += 1;
      else {
        differ += 1;
        diffs.push(
          `${label}${row.control ? ' (CONTROL — must agree)' : ''}: ours ${fmt(row.dmin)}..${fmt(row.dmax)} x${fmt(
            row.scale
          )}  vs device ${fmt(def.min)}..${fmt(def.max)} x${fmt(def.scale)}`
        );
      }
      console.log(
        `${label}  ${ctl}  ${`${fmt(row.dmin)}..${fmt(row.dmax)} x${fmt(row.scale)}`.padEnd(24)}  ${`${fmt(def.min)}..${fmt(
          def.max
        )} x${fmt(def.scale)}`.padEnd(24)}  ${fmt(def.step).padEnd(11)}  ${ok ? 'match' : 'DIFFERS'}`
      );
    }

    console.log(`\nsummary: ${agree} match, ${differ} DIFFER, ${unreadable} unreadable`);
    if (diffs.length) {
      console.log('\n--- everything that did not match ---');
      for (const d of diffs) console.log('  ' + d);
    }
    return differ > 0 ? 1 : 0;
  } finally {
    await s.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
