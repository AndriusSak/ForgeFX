// Gen-3 MODIFIER READ-BACK (parity audit §3.2). The codec decodes a preset body's modifier
// assignments (source → target block+param); this suite pins that they REACH the driver DTO — the
// `PresetSummary.modifiers` field and the `presetModifiers()` method behind GET /preset/modifiers —
// with the target effectId resolved and the pre-chain slot recovered. Offline/mocked, NO hardware.
//
// The fixtures are real FM3 factory dumps: the server's own preset-convert fixture (a preset whose
// only modifier targets an UNPLACED Wah, exercising the null-resolution path) plus the codec repo's
// preset fixtures (whose modifiers target PLACED blocks and sit in non-contiguous pre-chain slots,
// exercising both the resolution and the slot-index recovery). forgefx-midi is a required sibling
// (package.json `file:../../forgefx-midi`), so the relative path is valid in any checkout.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { PROFILES } from '../../src/devices.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { decodeGen3PresetDump } from 'forgefx-midi/devices/gen3';
import type { PresetModifier } from '../../src/drivers/types.js';
import { assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
export const MODIFIER_READBACK_CASE_COUNT = 5;

const read = (rel: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
// server's own fixture
const serverFixture = (name: string) => read(`../fixtures/preset-convert/${name}`);
// codec-repo fixture (sibling checkout)
const codecFixture = (name: string) => read(`../../../../forgefx-midi/test/gen3/fm3/fixtures/${name}`);

function driver() {
  return createGen3Driver(PROFILES[MODEL]!, {
    transport: async () => {
      throw new Error('offline preset decode must not touch the transport');
    },
    emit: () => {},
    getCadence: () => cadenceFor(MODEL, 'balanced')
  });
}

export function runModifierReadbackTests(): void {
  const d = driver();

  // 1. A preset whose modifier targets a block that is NOT placed → the entry is still surfaced, but
  //    with targetEffectId null (the grid can't resolve it). Slot is recovered from the pre-chain table.
  {
    const s = d.decodePresetBytes(serverFixture('fm3-preset-5.syx'));
    assert(Array.isArray(s.modifiers) && s.modifiers.length === 1, `preset-5: expected 1 modifier, got ${JSON.stringify(s.modifiers)}`);
    const m = s.modifiers![0]!;
    assertEqual(m.origin, 'pre-chain', 'preset-5 modifier origin');
    assertEqual(m.slot, 1, 'preset-5 modifier slot');
    assertEqual(m.target, 'Wah 1', 'preset-5 modifier target');
    assertEqual(m.targetEffectId, null, 'preset-5 modifier targetEffectId (Wah not placed)');
  }

  // 2. Cross-check the driver DTO against the codec's own decode — same count + same
  //    source/target/param/origin per entry (the driver must not drop, reorder, or reword them).
  {
    const bytes = serverFixture('fm3-preset-5.syx');
    const codec = decodeGen3PresetDump(bytes).modifiers ?? [];
    const dto = d.decodePresetBytes(bytes).modifiers ?? [];
    assertEqual(dto.length, codec.length, 'preset-5 modifier count matches codec');
    codec.forEach((c, i) => {
      const m = dto[i]!;
      assertEqual(m.source, c.source, `modifier[${i}].source`);
      assertEqual(m.target, c.target, `modifier[${i}].target`);
      assertEqual(m.param, c.param, `modifier[${i}].param`);
      assertEqual(m.origin, c.origin, `modifier[${i}].origin`);
    });
  }

  // 3. Placed targets resolve to their grid effectId; the pre-chain slot recovers the table GAP
  //    (Who's Next populates slots 2/3/6, leaving 1/4/5 empty — a packed-list index would report 1/2/3).
  {
    const s = d.decodePresetBytes(codecFixture('preset-96.syx'));
    const mods = s.modifiers ?? [];
    assertEqual(mods.length, 3, 'preset-96 modifier count');
    const bySource = new Map(mods.map((m) => [m.source, m] as const));
    const lfo1 = bySource.get('LFO 1A')!;
    assertEqual(lfo1.targetEffectId, 114, 'LFO 1A targetEffectId (Filter 1)');
    assertEqual(lfo1.slot, 2, 'LFO 1A slot (gap-aware)');
    const lfo2 = bySource.get('LFO 2A')!;
    assertEqual(lfo2.targetEffectId, 102, 'LFO 2A targetEffectId (Vol/Pan 1)');
    assertEqual(lfo2.slot, 3, 'LFO 2A slot');
    // Vol/Pan 2 isn't placed → null; its slot (6) is still recovered.
    const vp2 = bySource.get('source_0')!;
    assertEqual(vp2.targetEffectId, null, 'Vol/Pan 2 targetEffectId (unplaced)');
    assertEqual(vp2.slot, 6, 'Vol/Pan 2 slot');
  }

  // 4. Two modifiers, slots 1 and 2; the placed Flanger target resolves, the unplaced Wah does not.
  {
    const s = d.decodePresetBytes(codecFixture('preset-55.syx'));
    const mods = s.modifiers ?? [];
    assertEqual(mods.length, 2, 'preset-55 modifier count');
    assertEqual(mods[0]!.slot, 1, 'preset-55 modifier[0] slot');
    assertEqual(mods[0]!.targetEffectId, null, 'preset-55 modifier[0] targetEffectId (Wah unplaced)');
    assertEqual(mods[1]!.source, 'ADSR 1', 'preset-55 modifier[1] source');
    assertEqual(mods[1]!.slot, 2, 'preset-55 modifier[1] slot');
    assertEqual(mods[1]!.targetEffectId, 82, 'preset-55 modifier[1] targetEffectId (Flanger 1)');
  }

  // 5. The read-back method behind GET /preset/modifiers exists on the driver.
  {
    assert(typeof d.presetModifiers === 'function', 'gen3 driver exposes presetModifiers()');
  }

  // Type touch: keep the imported DTO type referenced (guards against an accidental shape change).
  const _typed: PresetModifier | undefined = undefined;
  void _typed;
}
