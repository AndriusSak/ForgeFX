# ForgeFX

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-72a4f2?logo=ko-fi&logoColor=white)](https://ko-fi.com/R5R6223HMO)

An open, cross-platform development platform / SDK for **Fractal Audio** devices — starting
with the **FM3**. ForgeFX speaks the device's own protocol over USB and exposes it as a clean,
named **HTTP API**, so any client — a web editor, a Raspberry Pi on stage, a Python script, a
hardware controller — can read and edit the amp by name instead of by raw wire bytes.

The headline feature: ForgeFX decodes the **full preset live from the device** — the real
routing grid, block placement, and cabling — not just a flat list of effects.

> **Status:** community **beta**. The gen-3 preset/grid codec, device client, and HTTP API run
> on **Node 20** (Fastify + the [`forgefx-midi`](#credits--thanks) codec) and are hardware-verified
> on **FM3 firmware 13.0**, including a serial write round-trip on a live preset. Looking for field
> testers — see [DISCLAIMER.md](./DISCLAIMER.md).

> ⚠️ **Independent, third-party project — not affiliated with or endorsed by Fractal Audio
> Systems. Use at your own risk.** Always back up your presets. See [DISCLAIMER.md](./DISCLAIMER.md).

## What it does

- 🎛 **Live routing grid.** Pull the current preset straight off the device and decode the real
  4×12 grid: every block's position, the cables between them, parallel branches, and merges.
- 🔤 **Named API.** Browse the block/parameter catalog and edit by name — `GET /preset/blocks/:eid/params`,
  `PUT /preset/blocks/:eid/params/:paramId` — never raw addresses in the happy path.
- 🔌 **Device auto-detect.** `GET /device/detect` identifies the attached unit (FM3/FM9/Axe-Fx/…)
  from its handshake, so clients know what's connected and whether a live codec exists for it.
- 🎚 **Cab IR & DynaCab picker data**, real EQ band layouts, per-block channels, multiple instances.
- 📡 **Live telemetry.** Tuner, tempo, scene, and state pushes over Server-Sent Events (`GET /events`).
- 💾 **Backup / restore.** Download any preset as `.syx`, restore from file.
- 🥧 **Runs anywhere.** Windows, Linux, macOS, and a Raspberry Pi strapped to the unit for live use.

## Quickstart

Requires **Node 20+**.

```sh
cd server
npm install
npm run dev        # http://localhost:5056   (tsx watch; hot-reload)
# or: npm run build && npm start
```

```sh
curl localhost:5056/device/detect          # which Fractal unit is attached
curl localhost:5056/preset/grid            # the real routing grid, decoded live
curl localhost:5056/blocks/amp/params      # named parameter catalog for the Amp block
```

> The API **owns the serial port** — stop any FM3-Edit bridge / other editor first
> (`fuser -v /dev/ttyACM0` shows who holds it). It auto-detects the stable
> `/dev/serial/by-id/...` path so it survives the device hopping between `ttyACM0`/`ttyACM1`.

## Docker (recommended for deployment)

```sh
docker compose up -d --build
docker compose logs -f
```

The image is multi-arch (amd64 + arm64), so it builds natively on a Pi. The FM3 is passed
through in [`docker-compose.yml`](./docker-compose.yml): the host's stable `by-id` symlink is
mapped to a fixed path inside the container so the device name stays put across re-enumeration.

## The API

Resource-oriented and named. The shape:

| Area | Endpoint | Description |
|------|----------|-------------|
| System | `GET /healthz` · `GET /device` | health · model + firmware |
| System | `GET /device/detect` | **auto-detect** the connected unit (FM3/FM9/Axe-Fx/…) |
| System | `GET /diag` | ports, resolved transport, traffic counters, `openError` — why an open failed |
| Definitions | `GET /device/cache` · `…/sources` · `POST …/build` · `…/cancel` · `…/import` | firmware-true block/type tables (below) |
| Catalog | `GET /blocks` · `GET /blocks/{slug}/params` · `…/types` | block families, params, model lists |
| Preset | `GET /preset` · `GET /preset/grid` | preset info · **decoded routing grid** |
| Preset | `GET /preset/blocks` · `POST /preset/select` | placed blocks (pos/routing/bypass/channel) · switch preset |
| Parameters | `GET /preset/blocks/{eid}/params` | live, named parameter values (per placed instance) |
| Parameters | `PUT /preset/blocks/{eid}/params/{paramId}` | set a parameter |
| Parameters | `POST /preset/blocks/{eid}/bypass` · `…/channel` · `…/type` | bypass · channel A–D · model |
| Cab | `GET /cab/irs` · `GET /preset/blocks/{eid}/cab` | IR names per bank · live cab state (picker) |
| Cab | `GET /cab/slots` · `POST /cab/ir/upload` · `POST /cab/slots/clear` | per-slot state · IR upload · clear a slot |
| Cab | `GET /cab/library` · `GET /cab/library/{id}/bytes` | IRs Axis uploaded (the only cab bytes the server holds) |
| Performance | `GET /preset/perform` · `PUT /preset/perform/{slot}` | the preset's ten Performance controls |
| Performance | `GET /global/perform` · `PUT /global/perform/{slot}` | the **GLOBAL** Performance page — stored in the unit's global settings, so it follows every preset; writes answer with a read-back of the eid-1 body |
| Telemetry | `POST /tuner` · `GET\|POST /tempo` · `GET\|POST /scene` | tuner page · tempo · scene |
| Stream | `GET /events` | live tuner/tempo/scene/state pushes (SSE) |
| Backup | `GET /presets/{n}/backup` · `POST /presets/restore` | `.syx` download / upload |

## Layouts & virtual effects

On top of the flat parameter list, ForgeFX serves **device-authentic editor layouts** and exposes
the device's **non-audio editor sections** through the very same endpoints — so a client can render
a faithful editor without hardcoding labels or screens.

- 🗂 **Editor layouts.** `GET /preset/blocks/:eid/params` now also returns a `layout` — the block
  family's device-authentic pages/tabs with control labels and column positions:
  `{ editorName?, pages: [{ name, controls: [{ label, paramName, paramId, col? }] }] }`. It's
  optional metadata; the `named`/`enums` arrays stay the source of truth for live values.
- 🧩 **Virtual effects.** The Setup/global, Controllers, Modifier, and Foot Controller (FC) sections
  ride the same `(effectId, paramId)` path as audio blocks, so they're read/written through the
  same endpoints — addressed by a reserved effect id: **GLOBAL/Setup = `1`, Controllers = `2`,
  Modifier = `3`, FC = `199`.** "Setup" is just the block editor pointed at effect id `1`.

```sh
curl localhost:5056/preset/blocks/1/params              # Setup (GLOBAL) params + the Setup pages
curl -X PUT localhost:5056/preset/blocks/1/params/4 \   # set a GLOBAL param (same write path)
  -H 'content-type: application/json' -d '{ "value": 0.5, "continuous": true }'
```

Layouts and the virtual-effect map are per device (FM3/FM9/Axe-Fx III each via their `DeviceProfile`);
the gen-3 units share the virtual effect ids. Full detail in [docs/LAYOUTS.md](docs/LAYOUTS.md).

## Device support

The handshake (`F0 00 01 74 7F 00 cs F7`) identifies a model byte; a live codec decides whether
anything happens after that. `VERIFIED` = driven against real hardware. `SHARED` = same gen-3 codec
and capability set as the FM3, but never plugged into this engine. `EARLY` = partial code, no
verification. `—` = identified, then reported unsupported.

| Device | Model | Codec | Grid | Status & capability notes |
|---|---|---|---|---|
| **FM3** | `0x11` | `fm3` | 4×12 | **VERIFIED** (fw 13.0). Per-block preset-body decode, live FC switch state (the unit never pushes panel edits, so the registry polls), self-describe walk, full taper capture, writes. |
| **FM9** | `0x12` | `fm9` | 6×14 | SHARED. Dump, convert, self-describe walk, full capture, panel edits pushed by the unit. No per-block body decode, no live FC read — those are FM3-only. |
| **Axe-Fx III** | `0x10` | `axe3` | 6×14 | SHARED, as FM9. Also the one unit that commonly arrives over USB-MIDI rather than a serial node. |
| **VP4** | `0x14` | `vp4` | 4 slots | EARLY. Gen-3 codec on a linear 4-slot surface: reads work, writes gated beta. |
| **AM4** | `0x15` | `am4` | 4 slots | PARTIAL. Own codec. Never walked for definitions (import only); FC/gen-3 profiles do not apply. |
| **Axe-Fx II XL+** | `0x07` | `axe2` | 4×12 | EARLY. Gen-2 codec (own writes, Q8.02 values); unverified. |
| Axe-Fx Standard / Ultra | `0x00` / `0x01` | — | — | Not supported. |
| Axe-Fx II / II XL, FX8, FX8 II, AX8 | `0x03` / `0x06` / `0x05` / `0x0a` / `0x08` | — | — | Not supported. |

Capability flags are per driver, not per model guess: `blockParamDecode`, `fullCapture`,
`deviceEditPush`/`deviceEditWatch`, `fcLiveRead`, `selfDescribe`, `cacheImport` — see
`Gen3Driver`'s constructor in `server/src/drivers/gen3.ts`. Family background and how to add a
device: [docs/devices.md](docs/devices.md).

## Device definitions: firmware-true type lists

Fractal's own editor writes a definitions cache when it connects
(`effectDefinitions_11_13p0.cache` under `~/Library/Application Support/Fractal Audio/FM3-Edit/` on
macOS). ForgeFX reads that file — or walks the unit itself — and overlays the result on the shipped
catalog, so the type and sub-type dropdowns match the firmware instead of the wiki (which mixes III
and FM3 lists):

- `GET /device/cache` — whether a profile exists, its firmware, and the walk's progress
- `GET /device/cache/sources` — caches the editor has already written, so one can be imported
- `POST /device/cache/build` `{ mode?: "read-only" | "full", force?: true }` — walk the unit;
  `full` adds the knob-taper sweep, `force` re-runs an existing profile
- `POST /device/cache/cancel` · `DELETE /device/cache` · `POST /device/cache/import { path }`

The walk streams `cacheBuild` events (phase, done/total, and queries / no-replies / mean reply time),
so a link that is up but not answering is visible immediately rather than looking like a slow walk;
40 consecutive unanswered queries abort it.

On firmware 13.0 the FM3 moved amp 331→336, drive 86→87, chorus 18→27, renamed three reverbs at the
same count, and grew `DISTORT_TUBETYPE` to 26 and the fuzz diode lists to 22. Those tables are
generated into `forgefx-midi` (`FM3_TYPE_TABLES_FW13`, `FM3_ENUM_ROWS_FW13`) by
`server/scripts/gen-fw13-types.ts`, which takes the editor cache as its input.

## Architecture

| Path | What |
|------|------|
| `server/` | Node (Fastify) HTTP API + device client. `src/index.ts` is the entry; `src/app.ts` defines the routes; per-device drivers live under `src/drivers/`. |
| `../forgefx-midi` | the [`forgefx-midi`](#credits--thanks) codec (SysEx framing, value codecs, gen-3 preset → grid decoder) — a sibling checkout linked via `file:` and pinned in `stack.lock.json` for tag builds. |
| `definitions/` | committed JSON data packs (block families → params, rosters, enum labels, cab IR names), loaded at runtime. |
| `server/scripts/` | maintenance scripts: `gen-fw13-types.ts` regenerates the FM3 tables from an editor cache, `probe-fw13-cache.ts` / `what-else-differs.ts` / `diff-type-tables.ts` / `fc-enum-diff.ts` audit what a cache would change. |

A web frontend, **[Axis](https://github.com/AndriusSak/Axis)**, lives in a separate repo and
consumes this API — and ships a desktop app that bundles ForgeFX into one installer.

## Documentation

- [Preset & routing-grid codec](docs/preset-grid-codec.md) — how a live preset is decoded.
- [Write protocol](docs/write-protocol.md) — param/bypass/channel/grid frames + safety.
- [Layouts & virtual effects](docs/LAYOUTS.md) — editor layouts on the param response + Setup/Controllers/Modifier/FC.
- [Devices & families](docs/devices.md) — multi-device design (gen-3 today; FM9/III next).
- [Definition packs](docs/definitions.md) — the block/parameter catalog format.
- [Contributing](CONTRIBUTING.md).

## Credits & thanks

The gen-3 preset/grid format was a wall until these open projects lit the way — huge thanks:

- **[fractal-midi](https://www.npmjs.com/package/fractal-midi)** (Apache-2.0) — the codec engine
  ForgeFX is built on: SysEx framing, value model, and the gen-3 preset/grid decoder.
- **[mcp-midi-control](https://github.com/TheAndrewStaker/mcp-midi-control)** (Apache-2.0) — its
  gen-3 codec documented the dump framing, the compressed patch body, and the grid layout.
- **[Fractal Audio Wiki](https://wiki.fractalaudio.com)** — real-world model-name reference
  (which amp/pedal each Fractal model is based on), used as factual data with attribution.

See [`NOTICE`](./NOTICE) for attribution details.

## Support

ForgeFX is free and open source. If it's useful to you, you can support development on Ko-fi:

[![Support me on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/R5R6223HMO)

## License

MIT — see [`LICENSE`](./LICENSE). ForgeFX is an independent project and is **not affiliated with
or endorsed by Fractal Audio Systems**. "Axe-Fx", "FM3", and "FM9" are trademarks of Fractal
Audio Systems, used for identification only. See [DISCLAIMER.md](./DISCLAIMER.md).

This repository is a fork of [sKuhLight/ForgeFX](https://github.com/sKuhLight/ForgeFX); upstream
remains the origin of the project.
