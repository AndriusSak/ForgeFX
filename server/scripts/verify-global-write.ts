// verify-global-write.ts — answers the last open hardware question: does a GLOBAL write actually land?
//
//   npx tsx scripts/verify-global-write.ts                 # PLAN ONLY — prints what it would do, writes nothing
//   npx tsx scripts/verify-global-write.ts --go            # performs the write test
//   npx tsx scripts/verify-global-write.ts --go --to 40    # target display % (default 40)
//
// WHY. GLOBAL writes were marked unverified because the only evidence available was a per-pid GET read-back,
// and that GET is broken on this firmware (it returns a canned template that decodes to a denormal ≈ 0.0000
// — the same garbage that once "restored" a 0 over the user's real brightness and turned their footswitch
// LED rings off). Today's dump proved the fn-0x1F bulk body IS pid-indexed and tracks the panel
// (body[7115] = 65534 at 100%, 45874 at 70%). So the body is an INDEPENDENT read path, and this test uses
// it as the oracle instead of the broken GET.
//
// SAFETY. This writes one brightness parameter. The plan is printed first and nothing happens without --go.
// It reads the original raw via the BODY, writes, re-reads via the BODY, then restores the original raw and
// re-reads to confirm — and it reports honestly if the restore cannot be shown to have taken.
// LOOK AT THE UNIT: the mini-displays and footswitch LED rings should visibly change and then return.
//
// CONVENTION (P14, 2026-10-08): the driver's continuous write takes the client's normalized 0..1 value and,
// for GLOBAL, converts it to DISPLAY units (0..100) on the wire — measured: setParam(1, 7115, 70) → 70%,
// setParam(1, 7115, 0.70) → 0.7%. So this script, like every other caller, sends `norm` (--to 40 → 0.40);
// it prints both the norm it sent and the display % that should result. Sending 40 directly would now be a
// norm of 40 → clamped/converted to 4000 on the wire, which is the bug this convention avoids.
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';

const GLOBAL_EID = 1;
const BRIGHTNESS_PID = 7115;
const RAW_MAX = 65534; // measured: 65534 == 100%

async function readRawBody(s: Awaited<ReturnType<typeof openProbeSession>> extends { ok: true; session: infer T } ? T : never): Promise<number[]> {
  const frames = await s.transport.request(s.codec.buildBlockBulkReadPoll(GLOBAL_EID), {
    timeoutMs: 2500,
    quietMs: 120,
    match: (fs) => fs.some((f) => f[5] === 0x76)
  });
  return s.codec.assembleGen3BlockBulkRead(frames).values;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const go = argv.includes('--go');
  const setOnly = argv.includes('--set-only');
  const toIdx = argv.indexOf('--to');
  const toPct = toIdx >= 0 ? Number(argv[toIdx + 1]) : 40;
  if (!Number.isFinite(toPct) || toPct < 0 || toPct > 100) {
    console.error('--to must be a percentage 0..100');
    return 2;
  }

  const opened = await openProbeSession(0x11);
  if (!opened.ok) {
    console.error(`no device: ${opened.failure.cls} — ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  try {
    const before = (await readRawBody(s))[BRIGHTNESS_PID];
    const pct = (r: number | undefined) => (r === undefined ? 'n/a' : `${((r / RAW_MAX) * 100).toFixed(1)}%`);
    console.log(`device: ${s.label}   read path: fn-0x1F bulk body index ${BRIGHTNESS_PID} (the oracle)`);
    console.log('');
    console.log('── plan ───────────────────────────────────────────────────────────────────────────');
    console.log(`  parameter : GLOBAL_FS_BRIGHTNESS (eid ${GLOBAL_EID}, pid ${BRIGHTNESS_PID}) — "Mini Display/Ring Brightness"`);
    console.log(`  original  : raw ${before}  (${pct(before)})`);
    console.log(`  would send: norm ${(toPct / 100).toFixed(4)}  (display ${toPct}% -> raw ~${Math.round((toPct / 100) * RAW_MAX)})`);
    console.log(`  would restore: norm ${(before / RAW_MAX).toFixed(4)}  (raw ${before}, ${pct(before)})`);
    console.log(`  LOOK AT THE UNIT: the mini-displays and LED rings should visibly change, then return.`);
    if (!go) {
      console.log('');
      console.log('PLAN ONLY — nothing was written. Re-run with --go to perform it.');
      return 4;
    }

    console.log('');
    console.log('── writing ────────────────────────────────────────────────────────────────────────');
    // CONVENTION (P14): send the client's normalized 0..1 value. The driver converts it to DISPLAY units
    // for GLOBAL (measured 2026-10-08: setParam(1,7115,70) → 70%, 0.70 → 0.7%), so 40% is sent as 0.40.
    const sendNorm = toPct / 100;
    console.log(`  sending    : norm ${sendNorm.toFixed(4)}  (expected display ${toPct}%)`);
    await s.driver.setParam?.(GLOBAL_EID, BRIGHTNESS_PID, sendNorm);
    await new Promise((r) => setTimeout(r, 400));
    const after = (await readRawBody(s))[BRIGHTNESS_PID];
    console.log(`  after write : raw ${after}  (${pct(after)})  <- read from the BODY, not the GET`);
    const landed = after !== undefined && Math.abs(after - Math.round((toPct / 100) * RAW_MAX)) <= Math.max(200, RAW_MAX * 0.02);
    console.log(`  verdict     : ${landed ? 'the write LANDED (body tracks the requested value)' : 'the body did NOT move to the requested value — examine before trusting GLOBAL writes'}`);

    if (setOnly) {
      console.log('');
      console.log(`SET-ONLY: left the parameter at ${toPct}% (raw ${after}) — no restore was performed, by request.`);
      return landed ? 0 : 2;
    }

    console.log('');
    console.log('── restoring ──────────────────────────────────────────────────────────────────────');
    if (before === undefined) {
      console.log('  original raw was unreadable — NOT restoring anything (nothing to restore to). Fix by hand if needed.');
      return 2;
    }
    // Restore in NORM too (before is the raw 16-bit body value; norm = raw/65534; the driver converts).
    await s.driver.setParam?.(GLOBAL_EID, BRIGHTNESS_PID, before / RAW_MAX);
    await new Promise((r) => setTimeout(r, 400));
    const restored = (await readRawBody(s))[BRIGHTNESS_PID];
    console.log(`  after restore: raw ${restored}  (${pct(restored)})   original was ${before} (${pct(before)})`);
    const ok = restored !== undefined && Math.abs(restored - before) <= Math.max(200, RAW_MAX * 0.02);
    console.log(`  ${ok ? 'RESTORE VERIFIED via an independent path (the body).' : 'RESTORE NOT PROVEN — check the unit and set the brightness by hand if it looks wrong.'}`);
    return ok ? 0 : 2;
  } finally {
    try {
      await s.close();
    } catch {
      /* best effort */
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then((rc) => process.exit(rc))
    .catch((e) => {
      console.error(`verify-global-write failed: ${(e as Error)?.message ?? String(e)}`);
      process.exit(1);
    });
}
