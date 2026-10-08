// dump-global.ts — READ-ONLY diagnostic for the open GLOBAL question.
//
//   npx tsx scripts/dump-global.ts [--model fm3] [--port /dev/ttyACM0] [--max-pid 185]
//
// WHY THIS EXISTS. ForgeFX reads a block's params from the fn-0x1F bulk body by INDEXING IT WITH THE PID
// (`bulk.values[base + pid]`). That is only valid for a DENSE family where record ordinal == pid. The FM3
// GLOBAL family declares `stride 186 / recordCount 187` yet carries 173 pids up to 65522 — 91 of them
// >= 186 — so for GLOBAL the index is meaningless: pids past the block read a fabricated 0, and pids below
// it read whichever record shares that ordinal. GLOBAL values are therefore served as UNKNOWN and every
// GLOBAL control renders inert. See docs/decisions/0004-global-bulk-read-unknown.md.
//
// What would settle it: the REAL shape of the eid-1 body. That is what this prints. It WRITES NOTHING —
// every frame it sends is a read (fn-0x1F bulk poll, or the per-pid GET), so it is safe on a live unit
// with no restore step and no hazard. It answers three questions in one run:
//   1. the 0x74 head's advertised itemCount vs the assembled 0x75 record count (one channel? 186x3/x4?);
//   2. does `index == pid` hold in the low range (i.e. is the body positional at all);
//   3. where does a known high pid's value actually appear in the body — that index IS its ordinal.
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';
import { PROFILES } from '../src/devices.js';

const DEFAULT_MODEL = 0x11; // FM3
const GLOBAL_EID = 1;
/** The fn=0x1F body stores a 16-bit count where 65534 = 100% (see ADR 0006). */
const RAW_MAX = 65534;
/** Half a raw step: |body[pid]/65534 - norm| within this counts as agreement. */
const NORM_TOL = 1.5 / RAW_MAX;

interface Args {
  model: number;
  port?: string;
  maxPid: number;
  /** Pids whose OWN index in the body should be printed raw (the index==pid test). */
  at?: number[];
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { model: DEFAULT_MODEL, maxPid: 185 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--model') {
      const key = argv[++i];
      const entry = Object.entries(PROFILES).find(([, p]) => (p as { slug?: string }).slug === key);
      a.model = entry ? Number(entry[0]) : DEFAULT_MODEL;
    } else if (v === '--port') {
      a.port = argv[++i];
    } else if (v === '--max-pid') {
      a.maxPid = Number(argv[++i]);
    } else if (v === '--at') {
      a.at = (argv[++i] ?? '')
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n));
    }
  }
  return a;
}

/** Indices (up to `limit`) where the body's raw count PROPORTIONALLY matches a normalized target
 *  (|body[i]/65534 - norm| <= NORM_TOL). Empty for an undefined target. The body is a raw 16-bit count
 *  while the GET norm is a 0..1 fraction, so an exact integer `===` against the norm is meaningless —
 *  it agrees ~0% and used to look like "the body is ordinal". */
export function findIndices(body: readonly number[], norm: number | undefined, limit = 8): number[] {
  if (norm === undefined) return [];
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (Math.abs(body[i]! / RAW_MAX - norm) <= NORM_TOL) {
      out.push(i);
      if (out.length >= limit) break;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const opened = await openProbeSession(args.model, args.port);
  if (!opened.ok) {
    const f = opened.failure;
    console.error(`no device: ${f.cls}${f.port ? ` on ${f.port}` : ''}${f.errno ? ` (${f.errno})` : ''} — ${f.detail}`);
    return 3;
  }
  const s = opened.session;
  try {
    console.log(`device: ${s.label} (model 0x${args.model.toString(16)}), mode: READ-ONLY (this script never writes)`);

    // ── 1. the raw eid-1 bulk body ────────────────────────────────────────────────────────────────
    const frames = await s.transport.request(s.codec.buildBlockBulkReadPoll(GLOBAL_EID), {
      timeoutMs: 2500,
      quietMs: 120,
      match: (fs) => fs.some((f) => f[5] === 0x76)
    });
    const n75 = frames.filter((f) => f[5] === 0x75).length;
    const bulk = s.codec.assembleGen3BlockBulkRead(frames);
    const body = bulk.values;
    const nonZero = body.filter((v) => v !== 0).length;
    console.log('');
    console.log('── 1. the eid-1 (GLOBAL) fn-0x1F body ─────────────────────────────────────────────');
    console.log(`  frames seen        : ${frames.length} (0x74 heads ${frames.filter((f) => f[5] === 0x74).length}, 0x75 bodies ${n75})`);
    console.log(`  advertised itemCount: ${bulk.itemCount}   <-- from the 0x74 head`);
    console.log(`  assembled values    : ${body.length}   <-- total records actually delivered`);
    console.log(`  ratio               : ${bulk.itemCount > 0 ? (body.length / bulk.itemCount).toFixed(3) : 'n/a'} (1.0 = one channel; 3-4 = multi-channel)`);
    console.log(`  non-zero records    : ${nonZero} of ${body.length}`);
    console.log(`  first 24 values     : ${JSON.stringify(body.slice(0, 24))}`);

    // ── 2. is `index == pid` true in the low range? ───────────────────────────────────────────────
    // The GET is the only read path besides this body, so if the body were positional, the two must agree.
    const pids: number[] = [];
    for (let p = 0; p <= args.maxPid; p++) pids.push(p);
    let got = new Map<number, number>();
    try {
      const read = (await s.driver.readParams?.(GLOBAL_EID, pids)) ?? {};
      got = new Map(Object.entries(read).map(([k, v]) => [Number(k), Number(v)]));
    } catch (e) {
      console.log(`\n  per-pid GET failed: ${(e as Error)?.message ?? String(e)} — falling back to spot checks`);
    }
    let compared = 0;
    let agree = 0;
    const disagreements: string[] = [];
    for (const [pid, val] of got) {
      if (pid >= body.length) continue;
      compared++;
      // LIKE FOR LIKE: the GET is a normalized 0..1 fraction; the body is a raw 16-bit count (65534 =
      // 100%). Comparing the raw int to the norm with `===` (the old bug) agreed ~0% on EVERY run and
      // read as "the body is ordinal" — an artifact of units, not of indexing.
      const rawNorm = body[pid]! / RAW_MAX;
      if (Math.abs(rawNorm - val) <= NORM_TOL) agree++;
      else if (disagreements.length < 12)
        disagreements.push(`pid ${pid}: GET norm ${val.toFixed(4)} vs body[${pid}]/${RAW_MAX} = ${rawNorm.toFixed(4)} (raw ${body[pid]})`);
    }
    console.log('');
    console.log('── 2. does `index == pid` hold? (compared like-for-like: /65534 vs the GET norm) ──');
    console.log(`  compared            : ${compared} pids read by BOTH paths`);
    console.log(`  agreed              : ${agree}${compared ? ` (${((agree / compared) * 100).toFixed(1)}%)` : ''}`);
    if (disagreements.length) {
      console.log('  first disagreements :');
      for (const d of disagreements) console.log(`    ${d}`);
    }

    // ── 2b. CONTROL: the same comparison on a REAL block, where the per-pid GET is known to work.
    // Q2 of the probe read CABINET_MUTE2 (eid 62, pid 25) successfully on this unit, so if GET and body
    // agree there, the GET is fine and `index == pid` holds for a dense family — which isolates the
    // GLOBAL problem to whether ITS body is pid-indexed, not to the read mechanism.
    try {
      const cabPid = 25;
      const cabBulk = await s.codec.assembleGen3BlockBulkRead(
        await s.transport.request(s.codec.buildBlockBulkReadPoll(62), {
          timeoutMs: 2500,
          quietMs: 120,
          match: (fs) => fs.some((f) => f[5] === 0x76)
        })
      );
      const cabGet = (await s.driver.readParams?.(62, [cabPid])) ?? {};
      const cabRaw = cabBulk.values[cabPid];
      const cabNorm = typeof cabRaw === 'number' ? cabRaw / RAW_MAX : NaN;
      const cabGetVal = cabGet[cabPid];
      const cabAgree = typeof cabGetVal === 'number' && Number.isFinite(cabNorm) && Math.abs(cabNorm - cabGetVal) <= NORM_TOL;
      console.log('');
      console.log('── 2b. CONTROL on a real block (cab eid 62, pid 25) — GET vs bulk ─────────────────');
      console.log(`  GET  cab pid ${cabPid} : ${JSON.stringify(cabGetVal)} (normalized 0..1)`);
      console.log(`  body[${cabPid}]        : raw ${JSON.stringify(cabRaw)} = ${Number.isFinite(cabNorm) ? cabNorm.toFixed(4) : 'n/a'}  (body is ${cabBulk.values.length} records, head ${cabBulk.itemCount})`);
      console.log(`  agree               : ${cabAgree ? 'YES — the two paths agree here (like-for-like)' : 'NO — the paths disagree even on a working block'}`);
    } catch (e) {
      console.log(`\n  control read failed: ${(e as Error)?.message ?? String(e)}`);
    }

    // ── 3a. the raw record sitting at a pid's OWN index (the H1 test: is index == pid?) ─────────────
    // Read these off the device panel and compare. If body[7115] equals the value the panel shows for
    // that setting, then indexing by pid is CORRECT for GLOBAL and the P9 refusal was unnecessary.
    const atPids = (args.at && args.at.length ? args.at : [110, 111, 3598, 7115, 7116]);
    console.log('');
    console.log('── 3a. raw body record at each pid\'s own index (compare against the device panel) ──');
    for (const pid of atPids) {
      const inBody = pid < body.length;
      console.log(
        `  body[${String(pid).padEnd(6)}] = ${inBody ? String(body[pid]).padEnd(10) : '(past the end — ' + body.length + ' records)'}` +
          `${inBody ? (body[pid] === 0 ? '   <-- a real zero, or an unpopulated slot' : '') : ''}`
      );
    }

    // ── 3. high pids: does the record at the pid's OWN index match its normalized GET value? ───────
    // The pid-indexed hypothesis (index == pid), tested like-for-like: body[pid]/65534 vs the GET norm.
    // (This is NOT an ordinal search — the old framing "the index where the value appears IS its ordinal"
    // asserted a false model. A hit at the pid's own index is what confirms index == pid.)
    const highPids = [110, 111, 7115, 7116];
    let high: Record<string, number> = {};
    try {
      high = ((await s.driver.readParams?.(GLOBAL_EID, highPids)) ?? {}) as Record<string, number>;
    } catch {
      /* reported below as unavailable */
    }
    console.log('');
    console.log('── 3. high pids: does body[pid]/65534 match the pid\'s own normalized GET value? ──────');
    for (const pid of highPids) {
      const val = high[pid];
      const raw = pid < body.length ? body[pid] : undefined;
      const norm = typeof raw === 'number' ? raw / RAW_MAX : undefined;
      const matches = typeof val === 'number' && norm !== undefined && Math.abs(norm - val) <= NORM_TOL;
      console.log(
        `  pid ${String(pid).padEnd(5)} GET norm ${val === undefined ? 'n/a'.padEnd(8) : val.toFixed(4)} ` +
          `body[${pid}] raw ${raw === undefined ? '(past the end)' : String(raw).padEnd(7)} ` +
          `= ${norm === undefined ? 'n/a' : norm.toFixed(4)}  -> ${matches ? 'MATCHES (index == pid)' : 'no match'}`
      );
      if (matches) {
        const idx = findIndices(body, val);
        if (idx.length > 1) console.log(`         ^ ${idx.length} proportional matches: the value is not distinctive, so this reading is ambiguous`);
      }
    }

    console.log('');
    console.log('READ-ONLY — nothing was written, no restore needed.');
    console.log('Interpretation (like-for-like: the GET is normalized 0..1; a body record is a 16-bit count /65534):');
    console.log('  • `index == pid` agreeing near 100% means the body IS pid-indexed — the catalog\'s declared');
    console.log('    "stride" does NOT describe this body\'s length, so a pid IS its own record ordinal and a');
    console.log('    read indexes body[pid] directly (measured 2026-10-08; docs/decisions/0006-units-are-per-opcode.md).');
    console.log('  • A disagreement means that pid\'s record is not at that index on THIS body — report the pid as');
    console.log('    UNKNOWN. It is NOT evidence of an ordinal mapping: do NOT build a pid->ordinal map.');
    return 0;
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
      console.error(`dump-global failed: ${(e as Error)?.message ?? String(e)}`);
      process.exit(1);
    });
}
