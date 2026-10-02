# Validation record

Verified on 2 October 2026 using Node 24.3.0, SpacetimeDB 2.10.2, Three.js 0.185.0, and Vite 8.3.2 on Windows.

## Multiplayer and persistence

- All 10 shared-physics tests passed.
- All 19 real SDK multiplayer checks passed in 34.4 seconds. Two anonymous guests rode to floors 2 and 20, shared state at identical server timestamps, jumped and crouched, opened a landing gate, exited/jumped/reentered, and reconnected with stored poses. Third-player admission, invalid input, and remote interaction checks were exercised.
- Restarted the database with the same data directory. The elevator at floor 20 (76 meters), its doors/queue, and both offline player poses matched the saved rows exactly, comparing players by slot rather than SQL row order.
- Browser clicking a physical floor-19 button updated the queue in both browser clients. Both arrived at floor 19.
- Server typecheck, module build, binding generation, and production client build passed. CI runs typechecks, unit tests, and the production build; the live SDK test requires a running isolated database.

## Visual contract and evidence

The cab has readable 20-floor controls, two distinct pill characters, two door layers, and a compact platform at each landing. Physics and rendered slabs share their dimensions. Riders use the rendered cab's moving vertical frame; support tests do not capture players from another floor. The scene uses no randomness or image postprocessing; final rendering is also the no-post baseline.

Browser captures used a 1280 by 720 CSS viewport at DPR 1.5, FOV 62 degrees, near/far 0.05/220 meters. Fixed camera inputs are available through `?view=panel` (initial first-person heading toward the controls), and `?inspect=1&view=far` (camera 35,44,78 looking at 0,36,0). `?inspect=1&debug=1` displays the landing/cab physics volumes from the exterior design camera. Remove `inspect=1` to play.

Inspected cabin controls, a two-player third-person view, the complete 20-floor tower, collision wireframes, manual gate movement, and a physical-button ride. Native WebGPU and the explicit `?backend=webgl` WebGL2 fallback both rendered correctly. The embedded browser rejected pointer lock; the caught rejection activates drag-to-look. Normal browser pointer lock remains the primary control mode.

After warm-up, the native WebGPU cabin view showed approximately 1.2–2.0 ms of CPU work per frame, 103 draw calls and 5,151 triangles. The exterior collision view showed 213 draw calls and 7,045 triangles. These are CPU observations, not a GPU frame-time guarantee. No application-owned postprocessing render targets are allocated; the renderer owns its output/depth targets. GPU time and total GPU memory were not measured.

The scene is deliberately smaller and more open than Mammoth. It uses generated geometry and no Mammoth assets, a 4-meter floor spacing, and acceleration/deceleration around a 3.15 m/s elevator speed cap. Cab jumping is enabled. Client prediction is a small bounded-extrapolation/reconciliation implementation; it is intended for this local example rather than a full competitive-game network stack.

Preview: [two players in the cab](preview.jpg). Local detailed captures and machine-readable integration/restart results are in the ignored `artifacts/` directory.
