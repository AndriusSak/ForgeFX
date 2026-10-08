// ────────────────────────────────────────────────────────────────────────────────────────────────
// watch-cab-mute — the INDEPENDENT read §3.7 needs for the Cab 2 Mute/Solo write.
//
// WHY: Q2 proves the write LANDS, but it proves it on the SAME read path that read the original, so it
// cannot show the original was captured correctly. Two better witnesses: (1) the device's own UNSOLICITED
// state broadcast — when a value moves, gen-3 PUSHES a 0x74/0x75/0x76 burst, a different mechanism from the
// bulk read; (2) a human looking at the unit.
//
// WHAT IT DOES: reads CABINET_MUTE2, writes the NEXT ordinal, then listens for during the cycles for a burst that
// names that eid/pid and prints it RAW as well as decoded. Then it RESTORES the original and verifies.
// A burst that never arrives is reported as a silence, never as agreement.
//
// USAGE  npx tsx scripts/watch-cab-mute.ts [--keep]     (--keep leaves the written value in place)
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';

const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

export async function main(argv: string[]): Promise<number> {
  const keep = argv.includes('--keep');
  const opened = await openProbeSession(0x11);
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  const bursts: { frames: number[][]; decoded?: ReturnType<NonNullable<typeof session.driver.decodeEditBurst>> }[] = [];
  const pending: number[][] = [];
  const off = session.transport.onFrame((f) => {
    // keep the last burst trio together: 0x74 head, 0x75 body, 0x76 end
    if (f[5] === 0x74) pending.length = 0;
    if ([0x74, 0x75, 0x76].includes(f[5] ?? -1)) {
      pending.push(f);
      if (f[5] === 0x76 && session.driver.decodeEditBurst) {
        const trio = [...pending];
        bursts.push({ frames: trio, decoded: session.driver.decodeEditBurst(trio) });
      }
    }
  });
  try {
    const read = async (): Promise<number | undefined> => {
      try { return (await session.driver.blockParams!(62))?.enums.find((e) => e.id === 25)?.value; } catch { return undefined; }
    };
    const before = await read();
    if (before === undefined) { console.log('no reply to the Cab bulk read (is a Cab block placed?) — cannot run this.'); return 1; }
    const target = (before + 1) % 3;
    console.log(`Cab 2 Mute/Solo (eid 62, pid 25): read ${before} (0=--, 1=MUTE, 2=SOLO) → writing ${target}`);
    // THREE cycles on purpose: one change is easy for a human to miss, and a value that alternates is
    // unmistakable. Each change is announced before it happens.
    // --cycles N --hold S: a human needs time. Default is a quick alternation for the wire side; pass
    // --cycles 1 --hold 8 when someone is watching the unit's display.
    const argN = (name: string, dflt: number): number => {
      const i = argv.indexOf(name);
      const v = i >= 0 ? Number(argv[i + 1]) : NaN;
      return Number.isFinite(v) && v >= 0 ? v : dflt;
    };
    const CYCLES = Math.max(1, argN('--cycles', 3));
    const HOLD_MS = argN('--hold', 2) * 1000;
    console.log(`WATCH THE UNIT NOW — Cab 2 Mute/Solo will alternate ${before} → ${target} → ${before}${CYCLES > 1 ? `, ${CYCLES} times` : ''}, each state held ${HOLD_MS / 1000}s.`);
    bursts.length = 0;
    for (let i = 1; i <= CYCLES; i++) {
      console.log(`  cycle ${i}/${CYCLES}: writing ${target} — HOLDING for ${HOLD_MS / 1000}s, watch the unit NOW …`);
      await session.driver.setParam?.(62, 25, target, false);
      await new Promise((r) => setTimeout(r, HOLD_MS));
      console.log(`  cycle ${i}/${CYCLES}: back to ${before} — holding ${HOLD_MS / 1000}s …`);
      await session.driver.setParam?.(62, 25, before, false);
      await new Promise((r) => setTimeout(r, HOLD_MS));
    }
    const after = await read();
    console.log(`\nread-back after the write: ${after} (same bulk-read path — this is NOT the independent one)`);
    console.log(`\nUNSOLICITED bursts seen in the 3 s window: ${bursts.length}`);
    for (const b of bursts) {
      console.log(`  trio: ${b.frames.map((f) => hex(f.slice(0, 24))).join(' | ')}`);
      const d = b.decoded;
      if (!d) { console.log('    (no burst decoder for this device)'); continue; }
      for (const e of d.events) console.log(`    event: eid ${e.effectId} pid ${e.paramId} norm ${e.norm}${e.effectId === 62 && e.paramId === 25 ? '   ← THE PARAM WE WROTE' : ''}`);
      if (d.reload) console.log('    reload:true (burst could not be diffed — first sight of the block)');
      if (!d.events.length && !d.reload) console.log('    no params in this burst');
    }
    if (!bursts.length) console.log('  (the device pushed nothing — recorded as a silence, which is NOT agreement)');
    if (!keep) {
      await session.driver.setParam?.(62, 25, before, false);
      const restored = await read();
      console.log(`\nrestored: wrote ${before} back, read ${restored} ${restored === before ? '(matches — the same-path read-back)' : '(DOES NOT MATCH — fix on the unit)'}`);
    } else {
      console.log(`\n--keep: left Cab 2 Mute/Solo at ${target} on purpose.`);
    }
    return 0;
  } finally {
    off();
    await session.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
