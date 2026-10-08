// probe-units.ts — what UNIT does a write opcode actually take? (measured, not assumed)
//
//   npx tsx scripts/probe-units.ts          # PLAN ONLY (writes nothing)
//   npx tsx scripts/probe-units.ts --go     # perform it, with restores verified through the body
//
// WHY. ADR 0006 says "discrete takes percent 0..100" — but that rests on pid 7115, whose display range IS
// 0..100, where percent, display value and a wire ordinal all coincide. This probe uses a float whose range
// is NOT 0..100 (GLOBAL/110 = Ring Intensity Bright, display 25..100), where the hypotheses diverge:
//
//   write the integer 50 on the discrete opcode, then read the raw 16-bit record in the body:
//     raw ≈ 21845  ⇒ the wire number IS the display value (50 in a 25..100 range → (50-25)/75 of scale)
//     raw ≈ 32767  ⇒ the wire number is a 0..100 PERCENT (50% → display 62.5 → (62.5-25)/75)
//     raw ≈ 40959  ⇒ the wire number is NORMALIZED 0..1 (0.50 atomically → display 62.5 ... see notes)
//   (21845 vs 32767 is the discriminating pair; anything else means a third model.)
//
// RESTORE IS UNAMBIGUOUS HERE: the current raw is 65534 = the top of the range, and 100 is the top of the
// range under EVERY hypothesis — so writing 100 restores max no matter which mapping is in force.
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';

const EID_GLOBAL = 1;
const PID = 110; // GLOBAL_FC_RING_BRIGHT_LEVEL — display 25..100, currently at max
const DISPLAY_MIN = 25;
const DISPLAY_MAX = 100;
const RAW_MAX = 65534;
const WRITE_DISPLAY = 50; // the integer we put on the discrete opcode
const RESTORE_DISPLAY = 100;

async function body(s: any): Promise<number[]> {
  const frames = await s.transport.request(s.codec.buildBlockBulkReadPoll(EID_GLOBAL), {
    timeoutMs: 2500,
    quietMs: 120,
    match: (fs: any[]) => fs.some((f) => f[5] === 0x76)
  });
  return s.codec.assembleGen3BlockBulkRead(frames).values;
}
const pct = (r: number) => `${((r / RAW_MAX) * 100).toFixed(1)}%`;
const displayAt = (raw: number) => DISPLAY_MIN + (raw / RAW_MAX) * (DISPLAY_MAX - DISPLAY_MIN);

async function main(): Promise<number> {
  const go = process.argv.includes('--go');
  const opened = await openProbeSession(0x11);
  if (!opened.ok) { console.error(`no device: ${opened.failure.cls} — ${opened.failure.detail}`); return 3; }
  const s: any = opened.session;
  try {
    const before = (await body(s))[PID];
    console.log(`device: ${s.label}`);
    console.log(`\n── plan ─────────────────────────────────────────────────────────────────────────`);
    console.log(`  parameter : GLOBAL/110 (Ring Intensity — Bright), display range ${DISPLAY_MIN}..${DISPLAY_MAX}`);
    console.log(`  current   : raw ${before}  (${pct(before)}) → display ≈ ${displayAt(before).toFixed(1)}`);
    console.log(`  would write: ${WRITE_DISPLAY} on the DISCRETE opcode (continuous=false)`);
    console.log(`    raw ≈ 21845 ⇒ the wire number is the DISPLAY value`);
    console.log(`    raw ≈ 32767 ⇒ the wire number is a 0..100 PERCENT`);
    console.log(`  would restore: ${RESTORE_DISPLAY} (the range max = the current raw under any mapping)`);
    if (!go) { console.log('\nPLAN ONLY — nothing written. Re-run with --go.'); return 4; }

    console.log(`\n── writing ──────────────────────────────────────────────────────────────────────`);
    await s.driver.setParam?.(EID_GLOBAL, PID, WRITE_DISPLAY, false);
    await new Promise((r) => setTimeout(r, 700));
    const after = (await body(s))[PID];
    const near = (t: number) => Math.abs(after - t) < 900;
    const model = near(21845) ? 'DISPLAY VALUE on the wire'
      : near(32767) ? '0..100 PERCENT on the wire'
      : near(40959) ? 'NORMALIZED 0..1 on the wire'
      : `UNMODELLED (display would read ≈ ${displayAt(after).toFixed(1)})`;
    console.log(`  wrote ${WRITE_DISPLAY} → raw ${after}  (${pct(after)}) → display ≈ ${displayAt(after).toFixed(1)}`);
    console.log(`  VERDICT: ${model}`);

    console.log(`\n── restoring ────────────────────────────────────────────────────────────────────`);
    await s.driver.setParam?.(EID_GLOBAL, PID, RESTORE_DISPLAY, false);
    await new Promise((r) => setTimeout(r, 700));
    const restored = (await body(s))[PID];
    const ok = Math.abs(restored - before) < 900;
    console.log(`  wrote ${RESTORE_DISPLAY} → raw ${restored}  (${pct(restored)})   original ${before} (${pct(before)})`);
    console.log(`  ${ok ? 'RESTORE VERIFIED via the body.' : 'RESTORE NOT PROVEN — check the unit and set it by hand.'}`);
    return ok ? 0 : 2;
  } finally { try { await s.close(); } catch { /* best effort */ } }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((rc) => process.exit(rc)).catch((e) => { console.error(String(e)); process.exit(1); });
}
