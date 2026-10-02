import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { DbConnection } from '../src/module_bindings';
import { floorY, idleInput, landingIndex, GROUND_FLOOR, GROUND_Y, LANDING_COUNT,
  type ElevatorState, type InputState, type PlayerState } from '../shared/simulation';

const uri = process.env.SPACETIMEDB_URI ?? 'http://127.0.0.1:3001';
const database = process.env.SPACETIMEDB_DATABASE ?? 'persistent-elevator-example';
const started = performance.now();
const deadline = started + 180_000;
const clients: Guest[] = [];
const checks: { name: string; elapsedMs: number }[] = [];

type Replica = PlayerState & {
  identity: { toHexString(): string }; slot: number; online: boolean;
  inputSeq: number; sampleMicros: bigint;
};
type Snapshot = { micros: bigint; value: string };
interface Guest {
  connection: DbConnection;
  identity: string;
  token: string;
  input: InputState;
  history: Map<string, Snapshot>;
  failures: Error[];
  heartbeat?: ReturnType<typeof setInterval>;
  sending: boolean;
  closed: boolean;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitFor(name: string, predicate: () => boolean, timeout = 5_000) {
  const until = Math.min(deadline, performance.now() + timeout);
  while (performance.now() < until) {
    const failure = clients.flatMap(client => client.failures)[0];
    if (failure) throw new Error(`SDK input heartbeat failed while ${name}: ${failure.message}`);
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${name}. ${describeWorld()}`);
}

async function bounded<T>(name: string, action: Promise<T>, timeout = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not finish within ${timeout} ms.`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function rows(client: Guest): Replica[] {
  return [...client.connection.db.player.iter()];
}

function findPlayer(client: Guest, identity = client.identity): Replica | undefined {
  return rows(client).find(row => row.identity.toHexString() === identity);
}

function player(client: Guest, identity = client.identity): Replica {
  const row = findPlayer(client, identity);
  assert(row, `Expected player ${identity.slice(0, 12)} to be subscribed.`);
  return row;
}

function elevator(client: Guest): ElevatorState {
  const row = [...client.connection.db.elevator.iter()][0];
  assert(row, 'Expected the persistent elevator row to exist. Publish the module first.');
  return { ...row, queue: Array.from(row.queue) };
}

function describeWorld(): string {
  return clients.filter(client => !client.closed).map(client => {
    const row = [...client.connection.db.elevator.iter()][0];
    const pose = findPlayer(client);
    return `${client.identity.slice(0, 8)}: elevator=${row ? `${row.phase}, floor ${row.currentFloor}, target ${row.targetFloor}, y=${row.y.toFixed(2)}, queue=${row.queue.join(',')}` : 'missing'}, player=${pose ? `online=${pose.online}, xyz=${[pose.x, pose.y, pose.z].map(n => n.toFixed(2)).join(',')}, inCab=${pose.inCab}` : 'lobby'}`;
  }).join(' | ');
}

function capture(client: Guest) {
  const remember = (key: string, micros: bigint, value: unknown) => {
    client.history.set(key, { micros, value: JSON.stringify(value) });
    while (client.history.size > 800) client.history.delete(client.history.keys().next().value!);
  };
  for (const row of rows(client)) {
    remember(`player:${row.identity.toHexString()}:${row.sampleMicros}:${row.seq}`, row.sampleMicros,
      [row.slot, row.online, row.x, row.y, row.z, row.vx, row.vy, row.vz, row.yaw,
        row.grounded, row.crouch, row.inCab, row.onRoof, row.jumpSeq, row.seq]);
  }
  for (const row of client.connection.db.elevator.iter()) {
    remember(`elevator:${row.sampleMicros}`, row.sampleMicros,
      [row.y, row.velocity, row.currentFloor, row.targetFloor, row.phase, row.door,
        row.queue, row.phaseTime, row.landingDoors, row.landingOpen]);
  }
}

async function connect(token?: string): Promise<Guest> {
  let connection: DbConnection | undefined;
  const ready = new Promise<Guest>((resolve, reject) => {
    connection = DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(database)
      .withToken(token)
      .onConnect((conn, identity, guestToken) => {
        const guest: Guest = {
          connection: conn, identity: identity.toHexString(), token: guestToken,
          input: idleInput(), history: new Map(), failures: [], sending: false, closed: false,
        };
        clients.push(guest);
        const update = () => capture(guest);
        conn.db.player.onInsert(update);
        conn.db.player.onUpdate(update);
        conn.db.player.onDelete(update);
        conn.db.elevator.onInsert(update);
        conn.db.elevator.onUpdate(update);
        conn.subscriptionBuilder()
          .onApplied(() => { capture(guest); resolve(guest); })
          .onError(ctx => reject(new Error(`Subscription failed: ${String(ctx.event)}`)))
          .subscribe(['SELECT * FROM player', 'SELECT * FROM elevator']);
      })
      .onConnectError((_ctx, error) => reject(new Error(`Connection failed: ${String(error)}`)))
      .build();
  });
  try {
    return await bounded('Connect anonymous SDK client', ready);
  } catch (error) {
    connection?.disconnect();
    throw error;
  }
}

async function send(client: Guest) {
  client.input.seq++;
  await bounded('Submit input', client.connection.reducers.submitInput({ ...client.input }));
}

function startHeartbeat(client: Guest) {
  client.heartbeat = setInterval(() => {
    if (client.closed || client.sending) return;
    client.sending = true;
    void send(client).catch(error => {
      if (!client.closed) client.failures.push(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => { client.sending = false; });
  }, 100);
}

async function join(client: Guest) {
  await bounded('Join player seat', client.connection.reducers.join({}));
  await waitFor('joined player snapshot', () => findPlayer(client)?.online === true);
  const row = player(client);
  client.input = { ...idleInput(row), seq: row.inputSeq, jumpSeq: row.jumpSeq };
  await send(client);
  startHeartbeat(client);
}

function close(client: Guest) {
  if (client.closed) return;
  client.closed = true;
  clearInterval(client.heartbeat);
  client.connection.disconnect();
}

async function input(client: Guest, patch: Partial<InputState>) {
  Object.assign(client.input, patch);
  await send(client);
}

async function rejected(name: string, action: () => Promise<unknown>, message: RegExp) {
  await assert.rejects(() => bounded(name, action()), message);
  record(name);
}

function record(name: string) {
  const elapsedMs = Math.round(performance.now() - started);
  checks.push({ name, elapsedMs });
  console.log(`PASS ${name} (${(elapsedMs / 1000).toFixed(1)}s)`);
}

async function replicated(name: string, a: Guest, b: Guest) {
  await waitFor(name, () => {
    const cab = elevator(a);
    const minMicros = cab.sampleMicros - 750_000n;
    const common = (prefix: string) => [...a.history].reverse().some(([key, snapshot]) =>
      key.startsWith(prefix) && snapshot.micros >= minMicros && b.history.get(key)?.value === snapshot.value);
    return common('elevator:') && common(`player:${a.identity}:`) && common(`player:${b.identity}:`);
  });
  // Compare contemporaneous views tolerantly; matching server-stamped history above is exact.
  assert(Math.abs(elevator(a).y - elevator(b).y) < 0.4, 'Clients disagree on cab height.');
  for (const id of [a.identity, b.identity]) {
    const left = player(a, id);
    const right = player(b, id);
    assert(Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) < 0.8,
      'Clients disagree on replicated player position.');
  }
  record(name);
}

async function run() {
  console.log(`Testing real anonymous SpacetimeDB connections: ${uri} / ${database}`);
  console.log('Use a disposable local instance with both player seats free. No transform/debug reducers are used.');
  const a = await connect();
  assert.equal(rows(a).filter(row => row.online).length, 0, 'Close existing game tabs before this test.');
  await join(a);
  const b = await connect();
  await join(b);
  assert.notEqual(a.identity, b.identity, 'Two tokenless SDK clients must receive distinct guest identities.');
  await waitFor('both clients see two players', () => rows(a).filter(row => row.online).length === 2 && rows(b).filter(row => row.online).length === 2);
  record('Two anonymous guests share the instance');

  const lobby = await connect();
  await rejected('Third guest admission is rejected', () => lobby.connection.reducers.join({}), /Both player seats are occupied/i);
  assert.equal(rows(lobby).filter(row => row.online).length, 2);
  await rejected('Unjoined client cannot submit movement', () => lobby.connection.reducers.submitInput({ ...idleInput(), seq: 1 }), /Join an available player seat/i);
  await rejected('Non-finite movement is rejected', () => a.connection.reducers.submitInput({ ...a.input, seq: a.input.seq + 1, forward: Number.NaN }), /finite/i);
  await rejected('Remote landing hail is rejected', () => a.connection.reducers.hailFloor({ floor: elevator(a).currentFloor === 20 ? 1 : 20 }), /Stand near this landing/i);

  // Do not assume a fresh database or floor 1. First let an existing trip finish.
  await waitFor('existing elevator queue to settle', () => elevator(a).phase === 'idle' && elevator(a).queue.length === 0, 30_000);
  await bounded('Respawn A into current cab', a.connection.reducers.respawn({}));
  await bounded('Respawn B into current cab', b.connection.reducers.respawn({}));
  await waitFor('both guests supported by the current cab', () => player(a).inCab && player(b).inCab && player(a).grounded && player(b).grounded);
  await rejected('Out-of-range cabin floor is rejected', () => a.connection.reducers.selectFloor({ floor: 21 }), /floor from 1 to 20/i);

  const firstFloor = elevator(a).currentFloor === 2 ? 3 : 2;
  await bounded('Select first ride', a.connection.reducers.selectFloor({ floor: firstFloor }));
  await waitFor('cab begins authoritative travel', () => elevator(a).phase === 'moving' && Math.abs(elevator(a).velocity) > 0.2);
  await replicated('Moving elevator and both riders replicate identically', a, b);

  await input(a, { jumpHeld: true, jumpSeq: a.input.jumpSeq + 1 });
  await waitFor('capsule jumps in the moving frame', () => player(a).inCab && !player(a).grounded && player(a).y - elevator(a).y > 0.15);
  record('Jump inside the moving cab is authoritative');
  await input(a, { jumpHeld: false, crouch: true });
  await waitFor('crouch and input acknowledgement replicate', () => player(a).crouch && player(b, a.identity).crouch && player(a).seq > 0);
  record('Crouch and input sequence acknowledgement replicate');
  await waitFor('first ride arrives with riders supported', () => elevator(a).currentFloor === firstFloor && elevator(a).phase === 'idle' && player(a).grounded && player(b).grounded, 35_000);
  assert(Math.abs(player(a).y - floorY(firstFloor)) < 0.06);
  assert(Math.abs(player(b).y - floorY(firstFloor)) < 0.06);
  await input(a, { crouch: false });
  if (firstFloor !== 2) {
    await bounded('Select floor 2', b.connection.reducers.selectFloor({ floor: 2 }));
    await waitFor('arrival on floor 2', () => elevator(a).currentFloor === 2 && elevator(a).phase === 'idle', 10_000);
  }
  await replicated('Both guests arrive on floor 2', a, b);

  await bounded('Select floor 20', a.connection.reducers.selectFloor({ floor: 20 }));
  await bounded('Second guest presses the same floor', b.connection.reducers.selectFloor({ floor: 20 }));
  await waitFor('floor 20 is shared and queued', () => {
    const cab = elevator(b);
    return cab.queue.includes(20) || (cab.targetFloor === 20 && cab.phase === 'moving');
  });
  assert(elevator(a).queue.filter(floor => floor === 20).length <= 1, 'Duplicate clicks added duplicate stops.');
  record('Floor 20 selection and duplicate suppression are shared');
  await waitFor('arrival on floor 20', () => elevator(a).currentFloor === 20 && elevator(a).phase === 'idle', 35_000);
  await waitFor('both pills remain on the high-floor cab', () => player(a).grounded && player(b).grounded && player(a).inCab && player(b).inCab);
  assert(Math.abs(player(a).y - floorY(20)) < 0.06);
  assert(Math.abs(player(b).y - floorY(20)) < 0.06);
  await replicated('Both guests ride to floor 20', a, b);

  if (!elevator(a).landingDoors[19]) await bounded('Open docked landing gate', a.connection.reducers.toggleLandingDoor({ floor: 20 }));
  await waitFor('floor 20 gate and interior doors open', () => elevator(a).landingOpen[19]! >= 0.99 && elevator(a).door >= 0.99);
  await input(a, { forward: 1, yaw: Math.PI, crouch: false });
  await waitFor('player leaves the cab onto the platform', () => player(a).z > 3.25 && !player(a).inCab && player(a).grounded);
  await input(a, { forward: 0 });
  await sleep(250);
  assert(player(a).z < 7.8 && Math.abs(player(a).y - floorY(20)) < 0.06, 'Player fell while crossing the doorway.');
  record('Manual landing gate permits a supported platform exit');
  await rejected('Floor selection from the platform is rejected', () => a.connection.reducers.selectFloor({ floor: 1 }), /inside the cabin/i);
  await rejected('Hailing a different platform is rejected', () => a.connection.reducers.hailFloor({ floor: 1 }), /near this landing/i);

  await input(a, { jumpHeld: true, jumpSeq: a.input.jumpSeq + 1 });
  await waitFor('platform jump rises above landing', () => !player(a).inCab && !player(a).grounded && player(a).y > floorY(20) + 0.15);
  await input(a, { jumpHeld: false });
  await waitFor('platform jump lands back on the platform', () => player(a).grounded && Math.abs(player(a).y - floorY(20)) < 0.06);
  record('Platform jump and landing are authoritative');
  await input(a, { forward: 1, yaw: 0 });
  await waitFor('player reenters the cab', () => player(a).inCab && player(a).z < 0.9);
  await input(a, { forward: 0 });
  await sleep(350);
  await replicated('Platform exit, jump, and reentry replicate to the other guest', a, b);

  // Recover through the world after a real fall; never invoke respawn or submit a transform.
  await input(a, { forward: 1, yaw: Math.PI });
  await waitFor('walking to the floor 20 platform edge', () => player(a).z > 7.1 && player(a).grounded);
  await input(a, { jumpHeld: true, jumpSeq: a.input.jumpSeq + 1 });
  await waitFor('jumping beyond the floor 20 platform', () => player(a).z > 8.5 && !player(a).grounded);
  await input(a, { forward: 0, jumpHeld: false });
  await waitFor('landing on the ground plaza after the fall', () => !player(a).inCab && player(a).grounded && Math.abs(player(a).y - GROUND_Y) < 0.06, 8_000);
  assert.equal(elevator(a).currentFloor, 20, 'Falling must not teleport or reset the cabin.');
  record('Jumping off floor 20 lands on the G plaza without respawn');
  await input(a, { forward: 1, yaw: 0 });
  await waitFor('walking from the plaza to the ground call station', () => player(a).z < 3.4);
  await input(a, { forward: 0 });
  await sleep(250);
  await rejected('Ground gate stays locked while the cabin is upstairs',
    () => a.connection.reducers.toggleLandingDoor({ floor: GROUND_FLOOR }), /locked until/i);
  await bounded('Hail G from the plaza', a.connection.reducers.hailFloor({ floor: GROUND_FLOOR }));
  await waitFor('G is a queued or active real stop', () => {
    const cab = elevator(b);
    return cab.queue.includes(GROUND_FLOOR) || (cab.phase === 'moving' && cab.targetFloor === GROUND_FLOOR);
  });
  record('The fallen guest can hail G and replicate the floor-zero request');
  await waitFor('cab arrives at G with the other guest aboard', () => elevator(a).currentFloor === GROUND_FLOOR && elevator(a).phase === 'idle', 35_000);
  assert.equal(elevator(a).y, GROUND_Y);
  assert(Math.abs(player(b).y - GROUND_Y) < 0.06 && player(b).inCab, 'The remaining rider lost support on the descent to G.');
  assert.equal(elevator(a).landingDoors.length, LANDING_COUNT);
  assert.equal(elevator(a).landingOpen.length, LANDING_COUNT);
  const groundIndex = landingIndex(GROUND_FLOOR);
  assert.equal(groundIndex, 20, 'G must append its gate without moving numbered-floor indexes.');
  await bounded('Open docked G gate', a.connection.reducers.toggleLandingDoor({ floor: GROUND_FLOOR }));
  await waitFor('G gate and cabin doors open', () => elevator(a).landingOpen[groundIndex]! >= 0.99 && elevator(a).door >= 0.99);
  await input(a, { forward: 1, yaw: 0 });
  await waitFor('the fallen guest boards from the G plaza', () => player(a).inCab && player(a).z < 0.9 && player(a).grounded);
  await input(a, { forward: 0 });
  await sleep(350);
  assert(Math.abs(player(a).y - GROUND_Y) < 0.06);
  await replicated('Ground fall, hail, arrival, and boarding replicate to both guests', a, b);

  const before = { ...player(a) };
  const token = a.token;
  close(a);
  await waitFor('disconnect marks the seat offline', () => findPlayer(b, a.identity)?.online === false);
  const resumed = await connect(token);
  assert.equal(resumed.identity, a.identity, 'Reconnect changed anonymous identity.');
  await join(resumed);
  assert.equal(player(resumed).slot, before.slot, 'Reconnect changed seat.');
  assert(Math.hypot(player(resumed).x - before.x, player(resumed).y - before.y, player(resumed).z - before.z) < 0.12,
    'Reconnect lost the stored player pose.');
  assert.equal(elevator(resumed).currentFloor, GROUND_FLOOR, 'Reconnect reset the persistent elevator.');
  await replicated('Same guest token reconnects with its stored pose and slot', resumed, b);

  close(resumed);
  close(b);
  await waitFor('both player seats become offline', () => rows(lobby).every(row => !row.online));
  assert.equal(elevator(lobby).currentFloor, GROUND_FLOOR);
  await join(lobby);
  assert.equal(elevator(lobby).currentFloor, GROUND_FLOOR, 'A fresh guest reset the elevator.');
  assert.equal(rows(lobby).length, 2, 'Offline replacement grew the bounded player table.');
  record('Waiting third guest can retry without resetting the persistent world');
}

let success = false;
let failure = '';
try {
  await run();
  success = true;
  console.log(`All ${checks.length} multiplayer checks passed in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(failure);
  process.exitCode = 1;
} finally {
  for (const client of clients) close(client);
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/multiplayer.json', `${JSON.stringify({
    success, uri, database, elapsedMs: Math.round(performance.now() - started), checks, failure,
  }, null, 2)}\n`);
}
