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

/** Indices (up to `limit`) where `value` appears in `body`. Empty for an undefined/zero-abundant value. */
export function findIndices(body: readonly number[], value: number | undefined, limit = 8): number[] {
  if (value === undefined) return [];
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === value) {
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
      if (body[pid] === val) agree++;
      else if (disagreements.length < 12) disagreements.push(`pid ${pid}: GET ${val} vs body[${pid}] ${body[pid]}`);
    }
    console.log('');
    console.log('── 2. does `index == pid` hold? (the assumption the old code made) ────────────────');
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
      console.log('');
      console.log('── 2b. CONTROL on a real block (cab eid 62, pid 25) — GET vs bulk ─────────────────');
      console.log(`  GET  cab pid ${cabPid} : ${JSON.stringify(cabGet[cabPid])}`);
      console.log(`  body[${cabPid}]        : ${JSON.stringify(cabBulk.values[cabPid])}  (body is ${cabBulk.values.length} records, head ${cabBulk.itemCount})`);
      console.log(`  agree               : ${cabGet[cabPid] === cabBulk.values[cabPid] ? 'YES — the two paths agree here' : 'NO — the paths disagree even on a working block'}`);
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

    // ── 3. high pids: the record index where each value appears IS its ordinal ──────────────────
    const highPids = [110, 111, 7115, 7116];
    let high: Record<string, number> = {};
    try {
      high = ((await s.driver.readParams?.(GLOBAL_EID, highPids)) ?? {}) as Record<string, number>;
    } catch {
      /* reported below as unavailable */
    }
    console.log('');
    console.log('── 3. high pids: the record index where each value appears IS its ordinal ──────────');
    for (const pid of highPids) {
      const val = high[pid];
      const idx = findIndices(body, val);
      console.log(
        `  pid ${String(pid).padEnd(5)} GET ${val === undefined ? 'n/a' : String(val).padEnd(8)} ` +
          `-> body indices ${idx.length ? idx.join(', ') : '(no match — value absent, zero, or not distinctive)'}`
      );
      if (idx.length > 1) console.log(`         ^ ${idx.length} matches: the value is not distinctive, so this reading is ambiguous`);
    }

    console.log('');
    console.log('READ-ONLY — nothing was written, no restore needed.');
    console.log('Interpretation: if `index == pid` agrees near 100% the body IS positional (contradicting the');
    console.log('catalog) — re-check the stride. If it agrees only for a prefix, the body is ordinal-based and');
    console.log('the pairs above are the pid->ordinal map to feed the generator.');
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
