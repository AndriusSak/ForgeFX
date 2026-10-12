// ────────────────────────────────────────────────────────────────────────────────────────────────
// probe-1b-modes — READ-ONLY. The 0x1b CONTENT field: does selector byte 11 (at4) index a table, and does
// the hole record depend on byte 10 (at3)? The arm was PRE-REGISTERED offline in
// review-2026-10-12/ANALYSIS-1B-CONTENT.md (d) — its 9 frames and the per-hypothesis expectations are copied
// here verbatim, so the run cannot be read after the fact.
//
// WHAT THE OFFLINE ANALYSIS ESTABLISHED FIRST (MEASURED, corpus of 2708 replies over 30 taps):
//   • the reply echoes the query's 5 address bytes: 2708/2708, zero mismatches;
//   • content bytes 6, 7 and 8 are ZERO in 2708/2708;
//   • address byte 7 (at0) nonzero ⇒ content all-zero, 113/113 (a mode byte, new);
//   • with at0 = at2 = at4 = 0 the content is reproducible per (at1, at3): 380 pairs, 0 exceptions;
//   • at2 and at4 are MODE bytes — their own magnitude is ignored (15/15 each) but zero/nonzero moves the
//     read to a different PAGE; the at4 page is sentinel-dominated with c5 = 03 for a real eid and 02 for a
//     hole eid; the scene moves ONLY the hole record (8/8), everything else is scene-invariant (24/24).
//
// THREE CANDIDATE READINGS, from that report, each with the rows it forbids:
//   R1 OPAQUE HANDLE + KIND BYTE: c0..c4 is an address-keyed handle, the constant 1b 14 4c 7a 0a is the
//      default/empty object's handle, c5 is a kind code. Forbids: a plain read of a populated eid returning
//      the sentinel.
//   R2 PACKED BITMASK: (c0, c1, low 2 bits of c2) is an attribute mask. Forbids: the sentinel appearing at
//      all — a mask reading has no default object.
//   R3 HASH OF THE ADDRESS: content = H(at1, at3), hole addresses collapsing to one value. Forbids: the hole
//      record being independent of at3 (already refuted for hole addresses, so R3 survives only as a
//      special case).
//
// PRE-COMMITTED RESOLUTION (written before the run; the tool prints it, then applies it):
//   • Q4/Q5 return the sentinel 1b 14 4c 7a 0a .. ⇒ R2 REFUTED, R1/R3 survive.
//   • Q8 != Q1 ⇒ the hole record is address-keyed ⇒ R3 survives, R1 weakened. Q8 == Q1 ⇒ the hole record's
//     at3-independence is confirmed and the "global default record" reading is favoured.
//   • Q6 != Q5 or Q7 != Q5 ⇒ at4 is an INDEX, not a mode, and ALL THREE readings are refuted (the surviving
//     description would be "at4 indexes a table").
//   • Q10 (sub 0x99) must be SILENT with Q1/Q2 answered — the positive control.
//
// ALSO: the standing read runs first, so this run DATES the hole record's regime instead of assuming it.
//
// NOTHING IS WRITTEN. Nine read-shaped frames plus one control, one connection, a frame tap by default.
//
// USAGE  npx tsx scripts/probe-1b-modes.ts [--port /dev/ttyACM0] [--tap <path>]
// Exit 0 read · 2 a control failed · 3 no device.
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { fractalChecksum } from 'forgefx-midi/shared';
import { standingRead, standingLine, subQuery } from './standing-read.js';

const MODEL = 0x11;
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

/** The nine frames of the pre-registered arm, plus the negative control. at0=0 unless stated. */
const ARM: { id: string; addr: [number, number, number, number, number]; why: string }[] = [
  { id: 'Q1', addr: [0x00, 0x24, 0x00, 0x00, 0x00], why: 'hole eid, plain' },
  { id: 'Q2', addr: [0x00, 0x2a, 0x00, 0x00, 0x00], why: 'populated eid (OUTPUT 1), plain' },
  { id: 'Q3', addr: [0x00, 0x46, 0x00, 0x00, 0x00], why: 'populated eid (DELAY 1), plain — the scene-invariance anchor' },
  { id: 'Q4', addr: [0x00, 0x24, 0x00, 0x00, 0x01], why: 'hole eid, at4 = 1' },
  { id: 'Q5', addr: [0x00, 0x2a, 0x00, 0x00, 0x01], why: 'populated eid, at4 = 1' },
  { id: 'Q6', addr: [0x00, 0x2a, 0x00, 0x00, 0x02], why: 'NEW: does at4 VALUE matter (2 vs 1)?' },
  { id: 'Q7', addr: [0x00, 0x2a, 0x00, 0x00, 0x0f], why: 'NEW: at4 = 15' },
  { id: 'Q8', addr: [0x00, 0x24, 0x01, 0x00, 0x00], why: 'hole eid, at3 = 1 — hole at3-dependence' },
  { id: 'Q9', addr: [0x00, 0x2a, 0x01, 0x00, 0x00], why: 'NEW: populated eid, at3 = 1' }
];

export async function main(argv: string[]): Promise<number> {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  if (arg('--tap')) process.env.FORGEFX_TAP = arg('--tap')!;
  const opened = await openProbeSession(MODEL, arg('--port'));
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  const problems: string[] = [];
  try {
    console.log('══ probe-1b-modes — READ-ONLY, the pre-registered 0x1b arm ══');
    console.log(`tap: ${process.env.FORGEFX_TAP ?? '(none set)'}`);
    console.log('\nPRE-COMMITTED (from ANALYSIS-1B-CONTENT.md (d), written before any of these frames was sent):');
    console.log('  Q1/Q2/Q3 plain content · Q4/Q5 sentinel tag 2 (hole) / 3 (real eid) · Q6 == Q7 == Q5 (at4 value ignored)');
    console.log('  Q8: R1/R2 predict == Q1 (hole is at3-independent), R3 predicts != Q1');
    console.log('  resolution: Q4/Q5 sentinel ⇒ R2 refuted · Q6/Q7 != Q5 ⇒ at4 is an INDEX, all three refuted · Q10 silent required');

    const sr = await standingRead(session, { note: 'R15 1b-modes arm — regime context' });
    console.log(`\n${standingLine(sr)}`);
    console.log(`regime assumed by the arm (scene 0, hole 00 00 00 00 00 02): ${sr.hole?.content === '00 00 00 00 00 02 00 00 00' ? 'MATCHES' : `DOES NOT MATCH — the arm's predictions were written for the other regime and must be read with care (hole = ${sr.hole?.content})`}`);
    if (sr.verdict !== 'read (controls green)') problems.push('standing read controls not green');

    const content = async (addr: readonly number[]): Promise<string | null> => {
      const heard = await session.transport.request(subQuery(0x1b, addr), { timeoutMs: 900, quietMs: 30 });
      const f = heard.find((x) => x[5] === 0x01 && x[6] === 0x1b && x.length > 10 && x.length <= 100);
      return f ? hex(f.slice(7, -1).slice(5, 14)) : null;
    };

    console.log('\n  frame  address (at0..at4)      content (payload[5..13])                 why');
    const got: Record<string, string> = {};
    for (const q of ARM) {
      const c = await content(q.addr);
      got[q.id] = c ?? '<no reply>';
      console.log(`  ${q.id.padEnd(5)}  ${hex(q.addr).padEnd(21)}  ${(c ?? '<no reply>').padEnd(38)}  ${q.why}`);
      if (!c) problems.push(`${q.id} got no reply`);
      // the corpus invariants, asserted live so a surprise is loud rather than absorbed
      if (c) {
        const b = c.split(' ');
        if (b[6] !== '00' || b[7] !== '00' || b[8] !== '00') console.log(`      !! c6/c7/c8 are not zero here (corpus says 2708/2708 zero)`);
      }
    }
    const neg = (await session.transport.request(subQuery(0x99, [0x00, 0x24, 0, 0, 0]), { timeoutMs: 900, quietMs: 60 }))
      .filter((f) => f[5] === 0x01 && f[6] === 0x99);
    console.log(`  ${'Q10'.padEnd(5)}  ${(hex([0x00, 0x24, 0, 0, 0]) + '').padEnd(21)}  ${(neg.length ? 'ANSWERED (unexpected)' : 'SILENT').padEnd(38)}  negative control`);
    if (neg.length) problems.push('negative control sub 0x99 answered');

    // ── apply the pre-committed resolution ──
    console.log('\n── resolution, against the pre-committed table ──');
    const SENT = (c: string): boolean => c.startsWith('1b 14 4c 7a 0a');
    const eq = (a: string, b: string): boolean => a.split(' ').join(' ') === b.split(' ').join(' ');
    const sentQ4 = SENT(got.Q4!), sentQ5 = SENT(got.Q5!);
    console.log(`  Q4 sentinel: ${sentQ4} · Q5 sentinel: ${sentQ5} ⇒ ${sentQ4 && sentQ5 ? 'R2 REFUTED (a mask has no default object); R1/R3 survive' : 'R2 NOT refuted by these rows — the page is not the sentinel page here'}`);
    const q6q5 = eq(got.Q6!, got.Q5!), q7q5 = eq(got.Q7!, got.Q5!);
    console.log(`  Q6 == Q5: ${q6q5} · Q7 == Q5: ${q7q5} ⇒ ${q6q5 && q7q5 ? "at4's VALUE is ignored (a mode, as the corpus said)" : 'at4 looks like an INDEX — the only surviving description would be "at4 indexes a table", and R1/R2/R3 are all refuted'}`);
    const q8q1 = eq(got.Q8!, got.Q1!);
    console.log(`  Q8 == Q1: ${q8q1} ⇒ ${q8q1 ? "the hole record IS at3-independent — the 'global default record' reading is favoured (R1 weakened, R3's hole-independence confirmed)" : 'the hole record is address-keyed (R3 survives, R1 weakened)'}`);
    console.log(`  Q2 (populated, plain) = ${got.Q2} · Q3 (delay, plain) = ${got.Q3} · Q9 (populated, at3=1) = ${got.Q9}`);

    console.log(`\nVERDICT: ${problems.length === 0 ? 'arm completed read-only; the four pre-committed branches above are decided by these rows' : 'CONTROLS NOT GREEN'}`);
    for (const p of problems) console.log(`  • ${p}`);
    return problems.length === 0 ? 0 : 2;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
