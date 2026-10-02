# Persistent Elevator Example

![Two anonymous pill players sharing the elevator](docs/preview.jpg)

A small multiplayer game demonstrating a server-authoritative elevator with **Vite, TypeScript, Three.js, and SpacetimeDB**. Two anonymous players share one elevator, its doors, and its destination queue. Both players can walk around the moving cab, click any of its 20 floor buttons, leave onto a landing, and jump off the platform.

Players are capsules. The movement controls and tuning come from the Mammoth game; this repository has no Mammoth runtime, asset, or authentication dependencies. Jumping inside the cab is an intentional extension to Mammoth's current controls.

Three.js `WebGPURenderer` uses native WebGPU when available and its WebGL2 fallback otherwise. The HUD displays the active backend. Use `?backend=webgl` to exercise the fallback, or `?debug=1` to show collision wireframes.

## Run locally

Requirements: **Node.js 22.12 or newer**, npm, and the **SpacetimeDB 2.10.2 CLI**. The JavaScript SDK and server module also use SpacetimeDB 2.10.2. Install the CLI using the [SpacetimeDB installer](https://spacetimedb.com/install).

From this repository:

```sh
npm install
npm install --prefix spacetimedb
```

Start the database in a terminal and leave it running:

```sh
npm run db:start
```

This starts a local database on `127.0.0.1:3001`, with durable data in `.spacetime-data/`. In a second terminal:

```sh
npm run db:publish
npm run db:generate
npm run dev
```

Open [http://localhost:5174](http://localhost:5174). The default connection settings match these commands. To change them, copy `.env.example` to `.env.local`, edit `VITE_SPACETIMEDB_URI` and `VITE_SPACETIMEDB_DATABASE`, and restart Vite.

The CLI wrapper also checks the usual Windows installation directory. If your CLI is elsewhere and unavailable on `PATH`, set the `SPACETIME_BIN` environment variable to the executable's full path.

## Try two players

1. Open the game in two browser tabs. Each tab connects as an anonymous guest, with its own token stored in `sessionStorage`. If **Duplicate tab** copies the first token, the client detects the occupied identity and obtains a separate guest token.
2. Click **Enter** to capture the mouse. You start inside the cab; look at a numbered button on the back wall and click it. Embedded browsers that reject pointer lock use drag-to-look and cursor clicks instead.
3. Ride together, or leave one player on a platform and call the elevator from that landing. Both players see the same cab, queue, and gates.
4. Open the landing gate with **E** when the cab is docked, then walk out. Jump off a platform to fall to the ground plaza, or press **R** to respawn.
5. Reload a tab to reconnect with that tab's identity. Stop and restart the database using the same `.spacetime-data/` directory to inspect persistence.

The instance allows **two connected players**. A third guest remains in the lobby and can retry when a place becomes available. Closed tabs leave offline guest rows; a fresh tab may replace an offline guest, retaining its pose, to keep this small demo bounded. A tab's token lasts for its browser session, so there is no account or permanent player identity to restore later.

## Controls

| Input | Action |
| --- | --- |
| WASD | Walk |
| Left or right Shift | Sprint |
| C | Toggle crouch |
| Space | Jump; hold for the full jump height |
| Mouse | Look |
| Hold Alt + mouse | Free look while keeping movement heading |
| Left click | Capture mouse; click a floor or landing call button |
| E | Call elevator or toggle the nearby landing gate |
| V | Toggle third-person view |
| R | Respawn |
| Escape | Release mouse |

The 20 floors are numbered **1–20**, spaced 4 meters apart. Floor 1 and the cab start at height 0. Each landing is a small platform in front of the shaft; the ground plaza is at height −4. The landing gates open only when the cab is docked, and close when it leaves. The interior doors close before travel and open at arrival.

## The multiplayer implementation

There are three database tables: players, the shared elevator, and the scheduled simulation tick. Clients send movement input and interaction requests through reducers. They never submit authoritative positions or advance the elevator themselves.

`shared/simulation.ts` contains the pure movement, collision, elevator, and rider-support rules used by both server simulation and client prediction. The server persists state; clients predict their own movement and render replicated players and elevator motion smoothly. A server restart skips the elapsed outage instead of simulating a large backlog of physics steps.

This is a deliberately small, trusted anonymous demo. SpacetimeDB supplies connection identities without an account login. The module bounds inputs, limits player slots, and guards its scheduled tick; it does not demonstrate account authentication, access permissions, or a production anti-cheat system.

Read [the architecture notes](docs/architecture.md) for the data flow, persistence behavior, and moving-platform rules.

Read [the validation record](docs/validation.md) for the checks performed and visual inspection inputs.

## Development checks

```sh
npm test
npm run build
npm run test:multiplayer
```

`npm test` exercises the shared simulation. `npm run build` checks TypeScript and creates the Vite production build. The multiplayer check requires the local database to be running with the module published, and exercises real SDK connections. Run it against a disposable local demo instance with both player slots free.

After changing the server schema or reducer signatures, run `npm run db:generate` and `npm run db:publish`. Generated TypeScript bindings live in `src/module_bindings/`.

## License

[MIT](LICENSE), copyright SeloSlav.
