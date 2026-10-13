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
import { runCabModelVsPageTests, CAB_MODEL_VS_PAGE_CASE_COUNT } from './drivers/cab-model-vs-page.test.js';
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
import { runCabIrUploadTests, CAB_IR_UPLOAD_CASE_COUNT } from './drivers/cab-ir-upload.test.js';
import { runCabSlotStateDriverTests, CAB_SLOT_STATE_DRIVER_CASE_COUNT } from './drivers/cab-slot-state.test.js';
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
import { runPresetGridByNumberTests, PRESET_GRID_BY_NUMBER_CASE_COUNT } from './api/preset-grid-by-number.test.js';
import { runLayoutParamCoverageTests, LAYOUT_PARAM_COVERAGE_CASE_COUNT } from './drivers/layout-param-coverage.test.js';
import { runGlobalBulkReadTests, GLOBAL_BULK_READ_CASE_COUNT } from './drivers/global-bulk-read.test.js';
import { runRouteParityTests, ROUTE_PARITY_CASE_COUNT } from './api/route-parity.test.js';
import { runDeviceProbeRunbookTests, DEVICE_PROBE_RUNBOOK_CASE_COUNT } from './drivers/device-probe-runbook.test.js';
import { runEditBurstUnresolvedTests, EDIT_BURST_UNRESOLVED_CASE_COUNT } from './drivers/edit-burst-unresolved.test.js';
import { runGetPathTests, GET_PATH_CASE_COUNT } from './drivers/get-path.test.js';
import { runSetParamUnitsTests, SETPARAM_UNITS_CASE_COUNT } from './drivers/setparam-units.test.js';
import { runEditBurstStrideTests, EDIT_BURST_STRIDE_CASE_COUNT } from './drivers/edit-burst-stride.test.js';
import { runPerformPageTests, runPerformPagePatchTests, PERFORM_PAGE_CASE_COUNT, PERFORM_PAGE_PATCH_ASSERTION_COUNT } from './drivers/perform-page.test.js';
import { runPerformSlotWriteTests, PERFORM_SLOT_WRITE_CASE_COUNT } from './drivers/perform-slot-write.test.js';
import { runPerPresetSwitchDriverTests, PER_PRESET_SWITCH_DRIVER_CASE_COUNT } from './drivers/per-preset-switches.test.js';
import { runCabLibraryTests, CAB_LIBRARY_CASE_COUNT } from './api/cab-library.test.js';
import { runGateContractTests, GATE_CONTRACT_CASE_COUNT } from './api/gate-contract.test.js';
import { runCabinetWireStrideTests, CABINET_WIRE_STRIDE_CASE_COUNT } from './drivers/cabinet-wire-stride.test.js';
import { runRangeTaperClassTests, RANGE_TAPER_CLASS_CASE_COUNT } from './drivers/range-taper-class.test.js';
import { runDeviceProfileMergeGuardTests, DEVICE_PROFILE_MERGE_GUARD_CASE_COUNT } from './drivers/device-profile-merge-guard.test.js';
import { runMeasuredOverlayWinsTests, MEASURED_OVERLAY_WINS_CASE_COUNT } from './drivers/measured-overlay-wins.test.js';
import { runStatusChannelUnknownTests, STATUS_CHANNEL_UNKNOWN_CASE_COUNT } from './drivers/status-channel-unknown.test.js';
import { runChannelSliceStrideTests, CHANNEL_SLICE_STRIDE_CASE_COUNT } from './drivers/channel-slice-stride.test.js';

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
  { name: `drivers/cab-ir-upload (${CAB_IR_UPLOAD_CASE_COUNT} verbatim replay / refusal cases, measured container geometry)`, run: runCabIrUploadTests },
  { name: `drivers/cab-slot-state (${CAB_SLOT_STATE_DRIVER_CASE_COUNT} per-slot state read-back cases)`, run: runCabSlotStateDriverTests },
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
  { name: `api/param-default (${PARAM_DEFAULT_CASE_COUNT} cases, omitted continuous → 400 (fail closed), mocked FM3)`, run: runParamDefaultTests },
  { name: `drivers/layout-param-coverage (${LAYOUT_PARAM_COVERAGE_CASE_COUNT} guards, every FM3 layout knob/dropdown served in its owning family)`, run: runLayoutParamCoverageTests },
  { name: `drivers/global-bulk-read (${GLOBAL_BULK_READ_CASE_COUNT} cases, a pid-indexed body resolves its own record; a genuinely out-of-range pid stays null)`, run: runGlobalBulkReadTests },
  { name: `api/route-parity (${ROUTE_PARITY_CASE_COUNT} cases, app↔runtime route-table drift guard + bad-param 400s)`, run: runRouteParityTests },
  { name: `drivers/device-probe-runbook (${DEVICE_PROBE_RUNBOOK_CASE_COUNT} cases, one-command device probe: read-only default, --writes restore, no-device non-zero, mocked)`, run: runDeviceProbeRunbookTests },
  { name: `drivers/edit-burst-unresolved (${EDIT_BURST_UNRESOLVED_CASE_COUNT} cases, a pid-indexed GLOBAL edit emits its real norm; cabState/meters never zero-fill)`, run: runEditBurstUnresolvedTests },
  { name: `drivers/get-path (${GET_PATH_CASE_COUNT} cases, the dead per-pid GET never hands a caller a denormal 0.0000)`, run: runGetPathTests },
  { name: `drivers/setparam-units (${SETPARAM_UNITS_CASE_COUNT} cases, units are per-opcode: the driver converts nothing; value bytes decoded from the sent frame)`, run: runSetParamUnitsTests },
  { name: `drivers/edit-burst-stride (${EDIT_BURST_STRIDE_CASE_COUNT} cases, the edit poll diffs by body extent, not catalogue stride; a pid past the body stays skipped)`, run: runEditBurstStrideTests },
  { name: `drivers/perform-page (${PERFORM_PAGE_CASE_COUNT} cases, per-preset performance page read-back from a real FM3 dump; unassigned slots stay unassigned)`, run: runPerformPageTests },
  { name: `drivers/perform-page-patch (${PERFORM_PAGE_PATCH_ASSERTION_COUNT} assertions, a patch that would RELOCATE the page is refused and writes nothing — review 2026-10-09 finding 2)`, run: runPerformPagePatchTests },
  { name: `drivers/perform-slot-write (${PERFORM_SLOT_WRITE_CASE_COUNT} cases, per-preset performance page WRITE side: read-back verdict, truncation, stale-label hazard, dry-run refusal, read-only 403)`, run: runPerformSlotWriteTests },
  { name: `drivers/per-preset-switches (${PER_PRESET_SWITCH_DRIVER_CASE_COUNT} cases, S3.8 switch block: real-fixture marker offset, per-row confidence, per-FIELD-bounded write + read-back)`, run: runPerPresetSwitchDriverTests },
  { name: `api/cab-library (${CAB_LIBRARY_CASE_COUNT} cases, §2.7 server-side cab-IR byte store: round-trip/dedup/corrupt/skips/cap + read-only routes on both surfaces)`, run: runCabLibraryTests },
  { name: `api/gate-contract (${GATE_CONTRACT_CASE_COUNT} cases, ?dryRun=true contract for EVERY device-write route on BOTH tables: zero frames, gate verdict matches NOT_DRY_RUNNABLE, percent-encoded spelling parity)`, run: runGateContractTests },
  { name: `drivers/cabinet-wire-stride (${CABINET_WIRE_STRIDE_CASE_COUNT} cases, a cache rebuild must not change the device-true fn=0x1F channel-block stride; the captured Cab body decodes to the unit's values)`, run: runCabinetWireStrideTests },
  { name: `drivers/range-taper-class (${RANGE_TAPER_CLASS_CASE_COUNT} assertions, a typecode-nibble 5 row must NOT decode as log10: the unit reads Cab Drive 5.00 at mid-scale where a log map gives 0.316; nibble 4 stays log)`, run: runRangeTaperClassTests },
  { name: `drivers/device-profile-merge-guard (${DEVICE_PROFILE_MERGE_GUARD_CASE_COUNT} cases, a truncated cache enum/roster list loses to the static one; a complete cache list still wins)`, run: runDeviceProfileMergeGuardTests },
  { name: `drivers/measured-overlay-wins (${MEASURED_OVERLAY_WINS_CASE_COUNT} cases, the MEASURED range overlay beats a device-cache row built from the same wrong record; the cache still wins for a non-overlay row; the served value is the unit's own 10×norm reading)`, run: runMeasuredOverlayWinsTests },
  { name: `drivers/status-channel-unknown (${STATUS_CHANNEL_UNKNOWN_CASE_COUNT} cases, an unreadable/partial fn-0x13 dump yields an UNKNOWN active channel, never a substituted channel A)`, run: runStatusChannelUnknownTests },
  { name: `drivers/channel-slice-stride (${CHANNEL_SLICE_STRIDE_CASE_COUNT} cases, the fn=0x1F channel-block stride must describe the BODY: a stale/absent table row is overridden by itemCount/4, a dividing row survives, and the three corrected rows really ship)`, run: runChannelSliceStrideTests },
  { name: `drivers/cab-model-vs-page (${CAB_MODEL_VS_PAGE_CASE_COUNT} cases, a cab publishes the model on the page CABINET_MODE selects — DynaCab pid 85 vs Legacy pid 4 — and setType writes THAT param, never the page flag)`, run: runCabModelVsPageTests },
  { name: `api/preset-grid-by-number (${PRESET_GRID_BY_NUMBER_CASE_COUNT} cases, /presets/:n/grid answers the ADDRESSED SLOT on both surfaces, 400 on a bad slot, 501 without a slot grid — never the live edit buffer)`, run: runPresetGridByNumberTests }
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
