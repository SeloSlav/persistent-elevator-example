# Validation record

Verified on 2 October 2026 using Node 24.3.0, SpacetimeDB 2.10.2, Three.js 0.185.0, and Vite 8.3.2 on Windows.

## Multiplayer and controls

- All 33 unit tests passed: 10 shared-physics tests, eight Mammoth look-controller tests, nine motion/presentation tests, and six native pointer-capture lifecycle tests.
- All 19 real SDK multiplayer checks passed in 34.5 seconds against a separate local test database. Two anonymous guests rode to floors 2 and 20, shared identical server snapshots, jumped and crouched, opened a landing gate, exited/jumped/reentered, and reconnected with stored poses. Third-player admission, invalid input, and remote interaction checks also passed. The active game database was left running.
- The pure production Mammoth controller was copied and compared with its original. Tests cover repeated full turns in both directions, immediate camera rotation, exact sensitivity, pitch limits, post-flick coast, Alt head/body separation, and recentering. Movement uses the same body heading and forward/right basis. The server wraps yaw rather than clamping turns.
- Left-click while captured and E both refresh the same center ray and operate the aimed physical floor, call, and door controls. The acquisition click captures the mouse separately. A geometry audit passed 800 ray checks across all 20 labels, button faces and bezels from standing/crouched positions, through both picking paths.
- The embedded preview rejected native pointer capture. Its visible failure state stayed paused and offered a desktop-browser link/URL copy; continuous native mouse input was therefore not exercised in that preview. Capture tests cover delayed grants after Escape, asynchronous release, stale rejected requests, and synchronous failure. The game has no viewport-limited mouse fallback or third-person orbit.
- Production client typecheck/build passed. CI runs the module typecheck, unit tests, and client build. The live SDK integration test requires a running isolated database.

The previous persistence check restarted the database with its existing data directory. Floor 20 (76 meters), doors/queue, and both offline poses matched the saved rows exactly by player slot. This update changes client controls, presentation, and geometry; the authoritative schema and simulation remain the same.

## Motion contract

`ElevatorMotion` uses server sample timestamps, a 100 ms interpolation buffer, bounded monotone cubic interpolation, and at most 100 ms extrapolation. Same-timestamp reducer metadata does not restart the movement timeline. Jittered and out-of-order ascent/descent tests run at 144 render frames per second and assert that the cab never reverses within a journey. Late arrival confirmations cannot pull it away from its landing.

Standing players and their first-person cameras use the rendered cab's exact moving frame on every render, including frames between physics ticks. Airborne riders retain simulated jump height relative to that frame. Tests verify both riders, upward/downward travel, jumps, roof support, outages, and world/cab frame handoffs. A real `stepPlayer` roof-exit regression verifies that the presentation delay does not add a vertical snap while physical jump/fall displacement continues. An inspection-camera capture during ascent held its camera/cab delta at exactly 2.150000 meters; that is inspection evidence, not a captured native gameplay session.

## Visual contract and evidence

The cab has readable 20-floor controls, pill characters, separate sliding cabin and manual landing gates, and a platform at each floor. Geometry and texture fields are deterministic (surface seed 20420). There is no image postprocessing; the final image is also the no-post baseline. Physics slab/door dimensions remain aligned with rendering.

Captures use a 1280 by 720 CSS viewport, FOV 62 degrees, and near/far 0.1/160 meters. `inspect=1` subscribes as a read-only spectator without taking a player slot. Fixed views:

- `?inspect=1&view=panel`: camera (-.55, cabY+1.55, .25), yaw zero.
- `?inspect=1&view=doors`: camera (0, cabY+1.55, -.8), yaw pi.
- `?inspect=1&view=cab`: camera (1.25, cabY+2.15, 1.35), looking at (0, cabY+1.4, -.7).
- `?inspect=1&view=far`: camera (35,44,78), looking at (0,36,0).
- Add `debug=1` for collision wireframes and CPU/draw/triangle/frame metrics; `shadows=0` isolates the shadow contribution. `surface=height` and `surface=roughness` expose the material fields. `backend=webgl` forces the WebGL2 fallback.

Inspected the panel, cab at an oblique angle, open doorway/pockets, tower, shadow-disabled baseline, and material diagnostics. Native WebGPU and forced WebGL2 rendered the upgraded geometry/materials without logged warnings or errors in the inspected views. These are selected fixed-view checks, not an exhaustive hardware compatibility guarantee.

The rebuilt cab uses framed wall bays, formed handrails, machined button bezels, fitted control/sign hardware, a recessed diffuser/vent ceiling, and actual sliding-door cavities. The inner pocket cover occupies z [1.800,1.816], decorated leaf faces [1.819,1.897], and outer cover [1.906,1.930] meters: positive 3/9 mm clearances. Closed landing leaves have another 35.5 mm clearance. The floor finish owns its top surface; seams, window trim, and hazard strips no longer duplicate coplanar faces. Numerals sit 10 mm above their button faces. Metal/concrete/rubber relief is scaled to 1.5/4/3 mm to reduce texture shimmer.

The loaded scene construction audit found 116,506 triangles and finite vertex data. Static decoration is batched by material and repeated bevels use smaller segment budgets. A warmed WebGPU cab view showed about 2.1 ms CPU work, 192 draw calls and 95,331 visible triangles. A WebGL2 panel view showed about 4.1 ms CPU work, 181 draw calls and 90,829 visible triangles. These are local CPU observations; GPU time and total GPU memory were not measured. Shadows use a 2048-square local directional map and a 1024-square cab spot map with small biases. The renderer owns reflection, shadow and depth/output resources; the application allocates no postprocessing targets.

Preview: [rebuilt cabin](preview.jpg). Detailed local captures and the machine-readable integration result are in the ignored `artifacts/` directory. The client prediction and short presentation buffer remain deliberately minimal for this multiplayer example.
