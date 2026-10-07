// ForgeFX server test runner — mocked-transport unit tests, NO hardware required.
// Same style as forgefx-midi's test/run-all.ts: each suite exports a run*Tests() that throws on
// failure; the runner prints PASS/FAIL per suite and exits non-zero when anything failed.
//
// Run: npm test   (tsx test/run-all.ts)
import './helpers/env.js'; // MUST stay the first import: isolates ~/.forgefx-conn before transport/connection.ts loads
import { runDetectionTests, DETECTION_CASE_COUNT } from './drivers/detection.test.js';
import { runGen2Tests, GEN2_CASE_COUNT } from './drivers/gen2.test.js';
import { runGen1Tests, GEN1_CASE_COUNT } from './drivers/gen1.test.js';
import { runAm4Tests, AM4_CASE_COUNT } from './drivers/am4.test.js';
import { runAm4EditWatchTests, AM4_EDITWATCH_CASE_COUNT } from './drivers/am4-editwatch.test.js';
import { runVp4Tests, VP4_CASE_COUNT } from './drivers/vp4.test.js';
import { runModelByteTests, MODELBYTE_CASE_COUNT } from './drivers/modelbyte.test.js';
import { runDefinitionCompletenessTests, DEFINITION_COMPLETENESS_CASE_COUNT } from './drivers/definition-completeness.test.js';
import { runTablesTests, TABLES_CASE_COUNT } from './drivers/tables.test.js';
import { runLayoutsTests, LAYOUTS_CASE_COUNT } from './drivers/layouts.test.js';
import { runKnobCoverageTests, KNOB_COVERAGE_CASE_COUNT } from './drivers/knob-coverage.test.js';
import { runCabLayoutVariantTests, CAB_LAYOUT_VARIANT_CASE_COUNT } from './drivers/cab-layout-variant.test.js';
import { runCabMuteCacheRowTests, CAB_MUTE_CACHE_ROW_CASE_COUNT } from './drivers/cab-mute-cache-row.test.js';
import { runCabBtnPseudoParamTests, CAB_BTN_PSEUDO_PARAM_CASE_COUNT } from './drivers/cab-btn-pseudo-param.test.js';
import { runBlockReadFailureTests, BLOCK_READ_FAILURE_CASE_COUNT } from './drivers/block-read-failure.test.js';
import { runWriteRejectionTests, WRITE_REJECTION_CASE_COUNT } from './drivers/write-rejection.test.js';
import { runWriteWindowTests, WRITE_WINDOW_CASE_COUNT } from './drivers/write-window.test.js';
import { runSilentWriteTests, SILENT_WRITE_CASE_COUNT } from './drivers/silent-write.test.js';
import { runEnumCoverageTests, ENUM_COVERAGE_CASE_COUNT } from './drivers/enum-coverage.test.js';
import { runUnitSetParityTests, UNIT_SET_PARITY_CASE_COUNT } from './drivers/unit-set-parity.test.js';
import { runBrowserGlobalsTests, BROWSER_GLOBALS_CASE_COUNT } from './drivers/browser-globals.test.js';
import { runGen3WritePathTests, GEN3_WRITE_PATH_CASE_COUNT } from './drivers/gen3-write-path.test.js';
import { runTelemetryTests, TELEMETRY_CASE_COUNT } from './drivers/telemetry.test.js';
import { runW2ReflectionTests, W2_REFLECTION_CASE_COUNT } from './drivers/w2-reflection.test.js';
import { runFm3SweepTests, FM3_SWEEP_CASE_COUNT } from './drivers/fm3-sweep.test.js';
import { runModifierReadbackTests, MODIFIER_READBACK_CASE_COUNT } from './drivers/modifier-readback.test.js';
import { runCapsTests, CAPS_CASE_COUNT } from './api/caps.test.js';
import { runTelemetryConfigTests, TELEMETRY_CONFIG_CASE_COUNT } from './api/telemetryConfig.test.js';
import { runRemoteTests, REMOTE_CASE_COUNT } from './api/remote.test.js';
import { runLocalTests, LOCAL_CASE_COUNT } from './api/local.test.js';
import { runSyncPlanTests, SYNCPLAN_CASE_COUNT } from './api/syncplan.test.js';
import { runRouterParityTests, ROUTER_PARITY_CASE_COUNT } from './api/router.test.js';
import { runDeviceCacheTests, DEVICE_CACHE_CASE_COUNT } from './api/device-cache.test.js';
import { runEditorCacheImportTests, EDITOR_CACHE_IMPORT_CASE_COUNT } from './api/editor-cache-import.test.js';
import { runCloudProfilesTests, CLOUD_PROFILES_CASE_COUNT } from './api/cloud-profiles.test.js';
import { runPresetConvertTests, PRESET_CONVERT_CASE_COUNT } from './api/preset-convert.test.js';
import { runPresetConvertExportTests, PRESET_CONVERT_EXPORT_CASE_COUNT } from './api/preset-convert-export.test.js';
import { runWriteSafetyTests, WRITE_SAFETY_CASE_COUNT } from './api/write-safety.test.js';
import { runParamDefaultTests, PARAM_DEFAULT_CASE_COUNT } from './api/param-default.test.js';
import { runLayoutParamCoverageTests, LAYOUT_PARAM_COVERAGE_CASE_COUNT } from './drivers/layout-param-coverage.test.js';
import { runRouteParityTests, ROUTE_PARITY_CASE_COUNT } from './api/route-parity.test.js';
import { runDeviceProbeRunbookTests, DEVICE_PROBE_RUNBOOK_CASE_COUNT } from './drivers/device-probe-runbook.test.js';

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [
  { name: `drivers/detection (${DETECTION_CASE_COUNT} cases, mocked Conn/Transport)`, run: runDetectionTests },
  { name: `drivers/gen2 (${GEN2_CASE_COUNT} cases, Axe-Fx II write frames + caps)`, run: runGen2Tests },
  { name: `drivers/gen1 (${GEN1_CASE_COUNT} cases, Axe-Fx gen-1 dump grid + caps)`, run: runGen1Tests },
  { name: `drivers/am4 (${AM4_CASE_COUNT} cases, None-selector + decode enrichment)`, run: runAm4Tests },
  { name: `drivers/am4-editwatch (${AM4_EDITWATCH_CASE_COUNT} transition-gated edit-watch cases, scripted MockTransport)`, run: runAm4EditWatchTests },
  { name: `drivers/vp4 (${VP4_CASE_COUNT} cases, VP4 gated writes + structure read + caps)`, run: runVp4Tests },
  { name: `drivers/modelbyte (${MODELBYTE_CASE_COUNT} cases, wrong-model-byte guard)`, run: runModelByteTests },
  { name: `drivers/definition-completeness (${DEFINITION_COMPLETENESS_CASE_COUNT} cases, blockParams unit/taper passthrough)`, run: runDefinitionCompletenessTests },
  { name: `drivers/tables (${TABLES_CASE_COUNT} identity checks, paramId cross-contamination guard)`, run: runTablesTests },
  { name: `drivers/layouts (${LAYOUTS_CASE_COUNT} editor-layout v2 variant-selection + passthrough)`, run: runLayoutsTests },
  { name: `drivers/knob-coverage (${KNOB_COVERAGE_CASE_COUNT} real-FM3 knob/unit coverage guards)`, run: runKnobCoverageTests },
  { name: `drivers/cab-layout-variant (${CAB_LAYOUT_VARIANT_CASE_COUNT} Cab page follows the cab MODE, not the preamp type)`, run: runCabLayoutVariantTests },
  { name: `drivers/cab-mute-cache-row (${CAB_MUTE_CACHE_ROW_CASE_COUNT} a degenerate cached range must not delete a layout-referenced param)`, run: runCabMuteCacheRowTests },
  { name: `drivers/cab-btn-pseudo-param (${CAB_BTN_PSEUDO_PARAM_CASE_COUNT} cases, server-side _BTN_ pseudo-param layout rewrite)`, run: runCabBtnPseudoParamTests },
  { name: `drivers/block-read-failure (${BLOCK_READ_FAILURE_CASE_COUNT} torn/short bulk read must not be served as complete)`, run: runBlockReadFailureTests },
  { name: `drivers/write-rejection (${WRITE_REJECTION_CASE_COUNT} 0x64 attribution cases)`, run: runWriteRejectionTests },
  { name: `drivers/write-window (${WRITE_WINDOW_CASE_COUNT} late-0x64 window cases, real transport timing)`, run: runWriteWindowTests },
  { name: `drivers/silent-write (${SILENT_WRITE_CASE_COUNT} silent-ignore semantics: no reply ⇒ {ok:true}, indistinguishable from accept)`, run: runSilentWriteTests },
  { name: `drivers/enum-coverage (${ENUM_COVERAGE_CASE_COUNT} real-gen3 enum/range completeness guards)`, run: runEnumCoverageTests },
  { name: `drivers/unit-set-parity (${UNIT_SET_PARITY_CASE_COUNT} one unit allowlist for knob gate + III float/enum classifier)`, run: runUnitSetParityTests },
  { name: `drivers/browser-globals (${BROWSER_GLOBALS_CASE_COUNT} drivers build with no Node process global)`, run: runBrowserGlobalsTests },
  { name: `drivers/gen3-write-path (${GEN3_WRITE_PATH_CASE_COUNT} FM3 write rejection/norm/watch/grid-bound cases)`, run: runGen3WritePathTests },
  { name: `drivers/telemetry (${TELEMETRY_CASE_COUNT} cadence/traffic/echo-guard/yield cases)`, run: runTelemetryTests },
  { name: `drivers/w2-reflection (${W2_REFLECTION_CASE_COUNT} slow-link/scene-state/blockState/scene cases)`, run: runW2ReflectionTests },
  { name: `drivers/fm3-sweep (${FM3_SWEEP_CASE_COUNT} no-block-open round-robin edit reflection cases)`, run: runFm3SweepTests },
  { name: `drivers/modifier-readback (${MODIFIER_READBACK_CASE_COUNT} decoded modifier → DTO + slot/resolution cases, real FM3 dumps)`, run: runModifierReadbackTests },
  { name: `api/caps (${CAPS_CASE_COUNT} device capability matrices)`, run: runCapsTests },
  { name: `api/telemetryConfig (${TELEMETRY_CONFIG_CASE_COUNT} GET/PUT mode + event + parity)`, run: runTelemetryConfigTests },
  { name: `api/remote (${REMOTE_CASE_COUNT} whitelist decisions)`, run: runRemoteTests },
  { name: `api/local (${LOCAL_CASE_COUNT} local-folder cases, temp root)`, run: runLocalTests },
  { name: `api/syncplan (${SYNCPLAN_CASE_COUNT} free-tier reconcile plans, pure)`, run: runSyncPlanTests },
  { name: `api/router (${ROUTER_PARITY_CASE_COUNT} app↔runtime-router parity twins, mocked FM3)`, run: runRouterParityTests },
  { name: `api/device-cache (${DEVICE_CACHE_CASE_COUNT} cases, on-connect self-describe build, mocked FM3/AM4)`, run: runDeviceCacheTests },
  { name: `api/editor-cache-import (${EDITOR_CACHE_IMPORT_CASE_COUNT} cases, .cache byte-source import + disk discovery, mocked FM3/AM4)`, run: runEditorCacheImportTests },
  { name: `api/cloud-profiles (${CLOUD_PROFILES_CASE_COUNT} cases, shared profile check/pull/publish, mocked cloud)`, run: runCloudProfilesTests },
  { name: `api/preset-convert (${PRESET_CONVERT_CASE_COUNT} cases, cross-device convert offline/connected/501/caps, mocked)`, run: runPresetConvertTests },
  { name: `api/preset-convert-export (${PRESET_CONVERT_EXPORT_CASE_COUNT} cases, FM3→FM3 author round-trip + guards, mocked)`, run: runPresetConvertExportTests },
  { name: `api/write-safety (${WRITE_SAFETY_CASE_COUNT} cases, ?dryRun=true + --writes false, mocked FM3)`, run: runWriteSafetyTests },
  { name: `api/param-default (${PARAM_DEFAULT_CASE_COUNT} cases, omitted continuous → discrete frame, mocked FM3)`, run: runParamDefaultTests },
  { name: `drivers/layout-param-coverage (${LAYOUT_PARAM_COVERAGE_CASE_COUNT} guards, every FM3 layout knob/dropdown served in its owning family)`, run: runLayoutParamCoverageTests },
  { name: `api/route-parity (${ROUTE_PARITY_CASE_COUNT} cases, app↔runtime route-table drift guard + bad-param 400s)`, run: runRouteParityTests },
  { name: `drivers/device-probe-runbook (${DEVICE_PROBE_RUNBOOK_CASE_COUNT} cases, one-command device probe: read-only default, --writes restore, no-device non-zero, mocked)`, run: runDeviceProbeRunbookTests }
];

let failures = 0;

for (const { name, run } of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

if (failures > 0) {
  console.error(`\n${failures} test suite(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${tests.length} test suite(s) passed.`);
process.exit(0); // detection tests may leave a just-cleared timer microtask behind — exit explicitly
