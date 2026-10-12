// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-global-pidindex — READ-ONLY. Arm G from review-2026-10-12/ANALYSIS-GLOBAL-READ-PATH.md (d):
// cross-check the GLOBAL value the SERVER serves against an INDEPENDENT wire path.
//
// WHY. Axis serves a GLOBAL/Setup pid as `body[base + pid]` of the eid-1 `fn=0x1F` bulk body
// (ForgeFX/server/src/drivers/gen3.ts:970-972 — `const v = bulk.values[base + pid]`). That assumption is
// POSITIONAL. ADR-0003's blanket "GLOBAL is unreadable, serve UNKNOWN" was superseded by ADR-0004 and P13
// (ForgeFX 0ad0d86) restored the reads on the strength of the 2026-10-07 panel measurement — so the live
// risk is not a missing value but a SILENTLY WRONG one if the body is not pid-indexed. An independent
// opcode that reads the same pid by ADDRESS would settle it; `fn=0x01 sub=0x1a` is that candidate (a
// per-pid range read, shipped at gen3.ts:1090-1116, but never exercised on GLOBAL).
//
// THE ARM (pre-committed in the analysis report, verbatim):
//   * eid 62 / pid 25 — a REAL block pid — is the POSITIVE CONTROL. If the two paths disagree there, the
//     instrument is broken and nothing else it says counts.
//   * GLOBAL pids 110, 111, 7115, 7116, 3602 (the pids the 2026-10-07 measurement used, plus a distinctive
//     high one) are read BOTH ways.
//   * VERDICT, pre-committed: control agrees ⇒ the instrument is valid · all GLOBAL pids agree ⇒ the
//     positional read is CONFIRMED by an independent opcode · GLOBAL pids OMITTED by 0x1a ⇒ 0x1a does not
//     address GLOBAL and the positional assumption stays UNPROVEN (not refuted) · any DISAGREE ⇒ the
//     positional read is REFUTED for those pids and the server must serve null for them.
//
// NOTHING IS WRITTEN — reads only, so no restore and no write-back from this path (a write-back from the
// GLOBAL path is exactly what darkened the owner's rings on 2026-10-07).
//
// USAGE  npx tsx scripts/probe-global-pidindex.ts [--port /dev/ttyACM0] [--tap <path>]
// Exit 0 read · 2 the positive control failed (instrument invalid) · 3 no device.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { standingRead, standingLine } from './standing-read.js';

const MODEL = 0x11;
const GLOBAL_EID = 1;
const GLOBAL_PIDS = [110, 111, 7115, 7116, 3602];
const CONTROL = { eid: 62, pid: 25 }; // a real block — the positive control for the instrument itself
/** 65534 is full scale for a 0..100 display param on this unit (measured 2026-10-07), so a raw body value
 *  maps to normalized v/65534. Agreement is judged on the RAW byte against the normalized read, scaled. */
const FULL_SCALE = 65534;

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;
  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  try {
    console.log('══ probe-global-pidindex — READ-ONLY cross-check of the positional GLOBAL read ══');
    console.log(`tap: ${process.env.FORGEFX_TAP ?? '(none set)'}`);
    console.log('pre-committed: control (eid 62 pid 25) must agree, else the instrument is invalid');
    console.log('  all GLOBAL agree ⇒ positional CONFIRMED · GLOBAL omitted by 0x1a ⇒ UNPROVEN · any disagree ⇒ positional REFUTED for those pids');
    const sr = await standingRead(session, { note: 'R15 arm G — global pid index' });
    console.log(`\n${standingLine(sr)}`);

    const bodyOf = async (eid: number): Promise<Record<number, number>> => {
      const r = await session.driver.rawBlock?.(eid);
      return r?.values ?? {};
    };
    const rangeOf = async (eid: number, pids: number[]): Promise<Record<number, number>> => {
      try { return (await session.driver.readRange?.(eid, pids)) ?? {}; } catch (e) { console.log(`  range read threw for eid ${eid}: ${(e as Error).message}`); return {}; }
    };
    const paramsOf = async (eid: number): Promise<number | null> => {
      try { return (await session.driver.readParams?.(eid, [CONTROL.pid]))[CONTROL.pid] ?? null; } catch { return null; }
    };

    console.log('\n── positive control (a real block: eid 62 / pid 25) ──');
    const cBody = await bodyOf(CONTROL.eid);
    const cRange = await rangeOf(CONTROL.eid, [CONTROL.pid]);
    const cPar = await paramsOf(CONTROL.eid);
    const cRaw = cBody[CONTROL.pid];
    const cNorm = cRange[CONTROL.pid];
    const cScaled = typeof cNorm === 'number' ? Math.round(cNorm * FULL_SCALE) : null;
    const cTol = cScaled === null || cRaw === undefined ? null : Math.abs(cScaled - cRaw);
    console.log(`  body[pid ${CONTROL.pid}] = ${cRaw === undefined ? '<absent>' : cRaw}`);
    console.log(`  0x1a read        = ${cNorm === undefined ? '<omitted>' : `${cNorm} (×65534 = ${cScaled})`}`);
    console.log(`  sub 0x1a readParams = ${cPar === undefined ? '<omitted>' : cPar}`);
    const controlOk = cRaw !== undefined && cScaled !== null && cTol !== null && cTol <= 2;
    console.log(`  CONTROL ${controlOk ? 'AGREES ✔ — the instrument is valid' : 'DOES NOT AGREE ✘ — the instrument is invalid; stop here'}`);
    if (!controlOk) {
      console.log('\nVERDICT: instrument invalid — a difference here is a difference in how the two paths SCALE, not evidence about GLOBAL. Nothing about GLOBAL can be concluded from this run.');
      return 2;
    }

    console.log('\n── GLOBAL (eid 1) both ways ──');
    const gBody = await bodyOf(GLOBAL_EID);
    const gRange = await rangeOf(GLOBAL_EID, GLOBAL_PIDS);
    const gPar = await paramsOf(GLOBAL_EID);
    console.log(`  body carries ${Object.keys(gBody).length} record(s) · the GLOBAL catalogue has 173 rows with 91 pids >= the 186 stride`);
    let agree = 0, omitted = 0, disagree = 0;
    for (const pid of GLOBAL_PIDS) {
      const raw = gBody[pid];
      const norm = gRange[pid];
      const scaled = typeof norm === 'number' ? Math.round(norm * FULL_SCALE) : null;
      const delta = raw !== undefined && scaled !== null ? Math.abs(scaled - raw) : null;
      let verdict: string;
      if (raw === undefined && scaled === null) { verdict = 'BOTH ABSENT'; }
      else if (scaled === null) { verdict = '0x1a OMITTED it'; omitted++; }
      else if (raw === undefined) { verdict = 'body lacks it, 0x1a has it'; omitted++; }
      else if (delta !== null && delta <= 2) { verdict = 'AGREE'; agree++; }
      else { verdict = `DISAGREE (Δ ${delta})`; disagree++; }
      console.log(`  pid ${String(pid).padStart(5)}  body=${raw === undefined ? '<absent>' : String(raw).padStart(5)}  0x1a=${scaled === null ? '<omitted>' : String(scaled).padStart(5)}  → ${verdict}`);
    }
    console.log(`\n  agree ${agree} · omitted ${omitted} · disagree ${disagree}`);
    const verdict = disagree > 0
      ? `positional read REFUTED for ${disagree} pid(s) — those must be served null`
      : omitted === GLOBAL_PIDS.length
        ? '0x1a does not address GLOBAL — the positional assumption stays UNPROVEN (not refuted)'
        : agree === GLOBAL_PIDS.length
          ? 'positional read CONFIRMED by an independent opcode for every probed pid'
          : 'mixed — read the per-pid lines above';
    console.log(`\nVERDICT: ${verdict}`);
    return 0;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
