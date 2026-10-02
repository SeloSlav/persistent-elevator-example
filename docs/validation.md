# Validation record

Verified on 2 October 2026 using Node 24.3.0, SpacetimeDB 2.10.2, Three.js 0.185.0, and Vite 8.3.2 on Windows.

## Ground stop, multiplayer and preservation

- All 40 unit tests passed: 14 authoritative/shared-physics tests, three floor-indicator tests, eight Mammoth look-controller tests, nine motion tests, and six native capture lifecycle tests.
- All 23 real SDK multiplayer checks passed in 71.4 seconds on a separate local database. Existing two-player rides, shared requests, jumping/crouching, gate/platform movement, admission/input checks and reconnects still pass.
- The new live recovery sequence jumps from floor 20, lands on the plaza without respawning, walks to G, verifies its gate stays locked while the cab is upstairs, hails floor zero, receives the descending cab, opens the docked gate, boards, replicates to the other guest, and reconnects at G. No transform/debug reducer is used.
- Republishing the test module produced no table-schema migration. Its saved cab stayed at y=12/floor 4, with the same empty queue and open floor 4 gate; the old twenty-entry arrays gained exactly one ground entry at index 20. Unit and independent audit checks also preserve existing poses, door values, numbered-floor indexes and queue `[0,12]`.
- The active module upgrade also preserved the original cab at y=36/floor 10, its empty queue and open floor-10 gate. No server restart or database reset was needed.
- Client/server typechecks and production build passed. CI runs the module typecheck, unit tests, and build. SDK integration requires a running isolated database.

G is floor 0 at y=−4; floors 1–20 retain their original y=0–76 positions. Ground-array normalization appends rather than shifting numbered gate indexes. The previous persistence/restart check retained elevator and offline poses; this upgrade does not reset the database.

## Motion and controls

Mammoth's pure production first-person look controller remains unchanged: native pointer lock, unrestricted yaw, immediate camera rotation, exact sensitivity/pitch/coast, and Alt head/body separation/recenter. Click and E use the same aimed physical controls. The embedded preview can reject native capture; the failure state stays paused and offers a desktop-browser link. Native capture lifecycle and repeated turns are covered by tests, not asserted from that embedded preview.

Server-timestamped motion still uses a 100 ms interpolation buffer, monotone cubic interpolation and at most 100 ms extrapolation. Standing riders/cameras stay in the rendered cab frame; airborne riders retain jump height. Jittered 144 Hz ascent/descent, duplicate timestamps, late arrivals, outages and roof/world handoffs remain covered.

The new indicator derives its floor from rendered height rather than the last docked stop, switches at landing midpoints and clamps G–20. Up/down arrows derive from phase/destination. The shared helper drives both physical displays and HUD. Tests cover every stop in both directions and boundaries. An isolated SDK-driven visual ride logged G→20→G while the authoritative docked floor remained the departure floor during movement. Passing floors update displays without flashing their physical destination buttons.

## Compact station and visual contract

The control station is a recessed 450×1250 mm stainless-steel faceplate beside the doorway, with two columns of 53 mm buttons,70 mm bezels, starred G, door controls and countersunk hardware. A compact station display and doorway-header display share the same reading. The rear wall has a complete handrail instead of the oversized panel. Numbered/call/gate controls preserve their gameplay actions.

An independent construction/picking audit passed 1,344 rays across all 21 controls, standing/crouched positions at floor 1 and G, labels, off-label faces and bezels, through both full-scene and semantic picking paths. G's call yields floor 0; its gate uses index 20 while floor 20 uses index 19. Door animation retains 3/9 mm pocket clearances.

The plaza is split around the cab footprint. Its ground insert hides while the cabin occupies G, leaving one visible walking surface rather than coincident plaza/cab planes. Downward geometry rays confirm that invariant at cab y=−4,−3.9,−3.86 and 0; the outside plaza remains y=−4. The insert restores the empty shaft's ground surface after departure.

Geometry/texture fields remain deterministic (seed 20420). The scene has no postprocessing; final rendering is the no-post baseline. Metal/concrete/rubber relief remains measured at 1.5/4/3 mm. Reflection/shadow/output targets belong to the renderer; there are no application postprocessing targets. GPU time and total GPU memory are not measured.

A warmed native WebGPU cab view with both players visible measured about 3.2 ms CPU work, 211 draw calls and 108,541 visible triangles. This is a local CPU observation, not measured GPU time.

The compact panel, cab and ground entrance were inspected in native WebGPU; the panel also rendered in forced WebGL2. The inspected views logged no warnings or errors.

Inspection uses the browser's normal viewport, FOV 62 and near/far 0.1/160 m. Read-only `inspect=1` does not consume a player slot. Bookmarks:

- `?inspect=1&view=panel`: camera(.78,cabY+1.65,.70), looking at(1.326,cabY+1.52,1.765).
- `?inspect=1&view=cab`: camera(−1.2,cabY+2.05,−1.3), looking at(.2,cabY+1.45,1.4).
- `?inspect=1&view=doors`: camera(0,cabY+1.55,−.8), yaw pi.
- `?inspect=1&view=ground`: camera(5,−1.3,7), looking at(0,−2.5,1.8).
- `?inspect=1&view=far`: camera(35,44,78), looking at(0,36,0).

Add `debug=1` for geometry/CPU metrics, `backend=webgl` for WebGL 2, `shadows=0` for shadow isolation, and `surface=height|roughness` for material fields. Screenshots: [cabin](preview.jpg), [compact station](panel.jpg). Detailed local captures and live SDK results are in ignored `artifacts/`.
