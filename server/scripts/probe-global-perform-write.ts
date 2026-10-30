// probe-global-perform-write.ts — does a GLOBAL write land on the PERFORM PAGE inside the eid-1 body?
//
//   npx tsx scripts/probe-global-perform-write.ts            # PLAN ONLY — reads, prints, writes nothing
//   npx tsx scripts/probe-global-perform-write.ts --go       # write, verify against the body, then RESTORE
//
// WHY. The Global Performance page is decoded read-only (globalPerform.ts) at body offset 8305 on this unit.
// Whether the page's id records are WRITABLE over the same pid-addressed path that carries the brightness
// parameter (pid 7115) has never been tested. This probe answers exactly that, on the one slot that is
// unassigned (so a failure cannot break a control the owner relies on), and restores it.
//
// SAFETY. Reads first (fn-0x1F bulk poll). The write is a single SET on an UNASSIGNED slot; the restore
// writes the original ids back and re-reads the BODY — a path independent of the write. No store/save is
// performed: this changes the live edit state only, exactly like touching a knob.
import { openProbeSession } from './probe-device.js';
import { findGlobalPerformPage, globalPerformSlotRecords, encodeLabel16 } from 'forgefx-midi/devices/gen3';

const GLOBAL_EID = 1;

async function readBody(s: Awaited<ReturnType<typeof openProbeSession>> extends { ok: true; session: infer T } ? T : never): Promise<number[]> {
  const frames = await s.transport.request(s.codec.buildBlockBulkReadPoll(GLOBAL_EID), {
    timeoutMs: 2500,
    quietMs: 120,
    match: (fs) => fs.some((f) => f[5] === 0x76)
  });
  return s.codec.assembleGen3BlockBulkRead(frames).values;
}

const show = (p: ReturnType<typeof findGlobalPerformPage>) =>
  p
    ? p.slots.map((s, i) => `${i}: ${s.effectId || '-'}/${s.paramId} ${s.effectLabel || ''} ${s.paramLabel || ''}`).join('\n   ')
    : '(no page)';

async function main(): Promise<number> {
  const go = process.argv.includes('--go');
  const opened = await openProbeSession(0x11);
  if (!opened.ok) {
    console.error(`no device: ${opened.failure.cls} — ${opened.failure.detail}`);
    return 3;
  }
  const s = opened.session;
  try {
    const body = await readBody(s);
    const page = findGlobalPerformPage(body);
    if (!page) {
      console.error('the GLOBAL body does not decode a perform page — nothing to test.');
      return 2;
    }
    const slot = page.slots.findIndex((x) => x.effectId === 0);
    if (slot < 0) {
      console.error('every global perform slot is assigned — refusing to test on a slot the owner uses.');
      return 2;
    }
    const rec = globalPerformSlotRecords(page, slot)!;
    const target = { effectId: 58, paramId: 11 }; // Amp / Master Vol — the pair the page already uses in slot 7
    console.log(`device: ${s.label}   page at body offset ${page.at}`);
    console.log(`\ncurrent page:\n   ${show(page)}\n`);
    console.log('── plan ───────────────────────────────────────────────────────────────────────────');
    console.log(`  slot      : ${slot} (unassigned)`);
    console.log(`  records   : eid @ ${rec.effectId}, pid @ ${rec.paramId}`);
    console.log(`  would set : eid ${target.effectId}, pid ${target.paramId} (AMP / Master Vol)`);
    console.log(`  restore   : eid 0, pid 0 (its current state)`);
    if (!go) {
      console.log('\nPLAN ONLY — nothing was written. Re-run with --go.');
      return 4;
    }

    console.log('\n── writing ────────────────────────────────────────────────────────────────────────');
    await s.driver.setParam?.(GLOBAL_EID, rec.effectId, target.effectId, false);
    await new Promise((r) => setTimeout(r, 400));
    await s.driver.setParam?.(GLOBAL_EID, rec.paramId, target.paramId, false);
    await new Promise((r) => setTimeout(r, 400));
    // labels are 16-bit characters; write the shown text so the page is self-describing (the unit's own
    // records carry NUL-terminated text, so the padding is left alone)
    const eff = encodeLabel16('AMP');
    const par = encodeLabel16('Master Vol');
    for (let i = 0; i < eff.length; i++) if (eff[i]) await s.driver.setParam?.(GLOBAL_EID, rec.effectLabel + i, eff[i]!, false);
    for (let i = 0; i < par.length; i++) if (par[i]) await s.driver.setParam?.(GLOBAL_EID, rec.paramLabel + i, par[i]!, false);
    await new Promise((r) => setTimeout(r, 800));
    const afterRaw = await readBody(s);
    const after = findGlobalPerformPage(afterRaw);
    const got = after?.slots[slot];
    console.log(`  raw records: eid[${rec.effectId}]=${afterRaw[rec.effectId]} pid[${rec.paramId}]=${afterRaw[rec.paramId]}`);
    console.log(`  id table   : ${JSON.stringify(afterRaw.slice(page.at, page.at + 20))}`);
    console.log(`  after write: ${got ? `${got.effectId}/${got.paramId} "${got.effectLabel}" "${got.paramLabel}"` : 'page unreadable'}`);
    const landed = !!got && got.effectId === target.effectId && got.paramId === target.paramId;
    console.log(`  verdict    : ${landed ? 'the ids LANDED in the body' : 'the body did NOT take the ids'}`);

    console.log('\n── restoring ──────────────────────────────────────────────────────────────────────');
    await s.driver.setParam?.(GLOBAL_EID, rec.effectId, 0, false);
    await new Promise((r) => setTimeout(r, 400));
    await s.driver.setParam?.(GLOBAL_EID, rec.paramId, 0, false);
    for (let i = 0; i < 16; i++) {
      await s.driver.setParam?.(GLOBAL_EID, rec.effectLabel + i, 0, false);
      await s.driver.setParam?.(GLOBAL_EID, rec.paramLabel + i, 0, false);
    }
    await new Promise((r) => setTimeout(r, 800));
    const restored = findGlobalPerformPage(await readBody(s))?.slots[slot];
    const ok = !!restored && restored.effectId === 0 && restored.paramId === 0;
    console.log(`  after restore: ${restored ? `${restored.effectId}/${restored.paramId}` : 'page unreadable'}`);
    console.log(`  ${ok ? 'RESTORE VERIFIED (read back from the body).' : 'RESTORE NOT PROVEN — clear the slot by hand in FM3-Edit.'}`);
    return ok && landed ? 0 : 2;
  } finally {
    await s.close?.();
  }
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
