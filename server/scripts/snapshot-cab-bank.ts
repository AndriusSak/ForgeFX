// Snapshot / diff the whole user cab bank's slot state (READ-ONLY). Used as the before/after guard for
// any probe that touches cab slots: if a probe changes something, the diff names it.
//   npx tsx scripts/snapshot-cab-bank.ts save  <file>     # write the snapshot
//   npx tsx scripts/snapshot-cab-bank.ts diff  <file>     # compare the device against it
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openProbeSession } from './probe-device.js';

const PAGES = [0x10, 0x11, 0x12, 0x13, 0x20];
/** Slots per page: the user banks hold 128, the scratchpad only 16 — asking past the end answers junk. */
const SLOTS_ON_PAGE: Record<number, number> = { 0x10: 128, 0x11: 128, 0x12: 128, 0x13: 128, 0x20: 16 };
/**
 * How many leading bytes of the name region are STABLE. MEASURED: the region's tail drifts on its own —
 * the same empty slots read `…00 1e 04 03 38…` in the morning and `…00 0d 26 70…` hours later — so a
 * naive full-region diff reports 600+ "changes" that are nothing but that drift, and would hide a real
 * one inside the noise. Compare the stable prefix; report the tail as volatile, never as a change.
 */
const STABLE_PREFIX = 9;
/** True for the bytes of the region that are stable enough to compare. */
const stable = (region: number[]) => region.slice(0, STABLE_PREFIX).join(',');

export async function main(argv: string[]): Promise<number> {
  const mode = argv[0];
  const file = argv[1];
  if (!file || (mode !== 'save' && mode !== 'diff')) {
    console.log('usage: npx tsx scripts/snapshot-cab-bank.ts save|diff <file>');
    return 2;
  }
  const opened = await openProbeSession(0x11, argv[2]);
  if (!opened.ok) { console.log(`no device: [${opened.failure.cls}] ${opened.failure.detail}`); return 3; }
  const { session } = opened;
  try {
    const now: Record<string, { populated: boolean | null; flag: number | null; region: number[] }> = {};
    for (const page of PAGES) {
      const rows = await session.driver.queryCabSlots!({ page, from: 0, to: SLOTS_ON_PAGE[page]! - 1 });
      for (const r of rows) now[`${page}:${r.index}`] = { populated: r.populated, flag: r.flag, region: r.nameRegion };
    }
    const keys = Object.keys(now).length;
    if (mode === 'save') {
      writeFileSync(file, JSON.stringify(now));
      const pop = Object.values(now).filter((v) => v.populated === true).length;
      console.log(`saved ${keys} slots (${pop} populated) → ${file}`);
      return 0;
    }
    const before = JSON.parse(readFileSync(file, 'utf8')) as typeof now;
    let changed = 0;
    let volatile = 0;
    for (const k of Object.keys(before)) {
      const a = before[k]!; const b = now[k];
      if (!b) { console.log(`  ${k}: GONE`); changed++; continue; }
      if (a.populated !== b.populated || stable(a.region) !== stable(b.region)) {
        console.log(`  ${k}: ${a.populated ? 'populated' : a.populated === false ? 'empty' : 'unreadable'} → ${b.populated ? 'populated' : b.populated === false ? 'empty' : 'unreadable'}  region [${a.region.join(' ')}] → [${b.region.join(' ')}]`);
        changed++;
      } else if (a.region.join(',') !== b.region.join(',')) {
        volatile++;
      }
    }
    console.log(`compared ${keys} real slots (stable prefix ${STABLE_PREFIX} bytes) — ${volatile} had only the volatile tail drift`);
    console.log(changed === 0 ? 'no change' : `${changed} SLOT(S) CHANGED`);
    return changed === 0 ? 0 : 1;
  } finally {
    await session.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
