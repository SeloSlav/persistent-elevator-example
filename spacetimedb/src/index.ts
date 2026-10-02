import { ScheduleAt } from 'spacetimedb';
import { schema, table, t, SenderError, type Infer, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import {
  initialElevator, initialPlayer, idleInput, insideCab, nearLanding,
  stepElevator, stepPlayer, requestFloor, toggleLandingDoor as toggleDoor,
  doorwayOccupied, setDoor, TICK_DT, type InputState, type ElevatorState,
} from '../../shared/simulation';

// Two public snapshots and one private timer are the entire database schema.
const player = table({ name: 'player', public: true }, {
  identity: t.identity().primaryKey(), slot: t.u8(), online: t.bool(),
  connectionId: t.option(t.connectionId()),
  x: t.f64(), y: t.f64(), z: t.f64(), vx: t.f64(), vy: t.f64(), vz: t.f64(), yaw: t.f64(),
  grounded: t.bool(), crouch: t.bool(), inCab: t.bool(), onRoof: t.bool(), jumpActive: t.bool(),
  jumpSeq: t.u32(), seq: t.u32(), sampleMicros: t.i64(),
  inputForward: t.f64(), inputRight: t.f64(), inputYaw: t.f64(),
  inputSprint: t.bool(), inputCrouch: t.bool(), inputJumpHeld: t.bool(),
  inputJumpSeq: t.u32(), inputSeq: t.u32(), inputMicros: t.i64(),
});

const elevator = table({ name: 'elevator', public: true }, {
  id: t.u8().primaryKey(), y: t.f64(), velocity: t.f64(),
  currentFloor: t.u8(), targetFloor: t.u8(), phase: t.string(),
  door: t.f64(), queue: t.array(t.u8()), phaseTime: t.f64(),
  landingDoors: t.array(t.bool()), landingOpen: t.array(t.f64()), sampleMicros: t.i64(),
});

const tick = table({ name: 'tick' }, {
  scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(),
});

const spacetimedb = schema({ player, elevator, tick });
export default spacetimedb;
type Context = ReducerCtx<InferSchema<typeof spacetimedb>>;
type PlayerRow = Infer<typeof player.rowType>;

export const init = spacetimedb.init(ctx => {
  ctx.db.elevator.insert({ ...initialElevator(), sampleMicros: ctx.timestamp.microsSinceUnixEpoch });
  ctx.db.tick.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(50_000n) });
});

/** SpacetimeDB gives each browser an anonymous identity; no account or login reducer. */
export const join = spacetimedb.reducer(ctx => {
  if (!ctx.connectionId) throw new SenderError('Join through a browser connection.');
  const existing = ctx.db.player.identity.find(ctx.sender);
  if (existing?.online && existing.connectionId && !existing.connectionId.equals(ctx.connectionId)) {
    throw new SenderError('This anonymous seat is already open in another connection. Use a second browser session.');
  }
  const rows = [...ctx.db.player.iter()];
  if (rows.filter(row => row.online && !row.identity.equals(ctx.sender)).length >= 2) {
    throw new SenderError('Both player seats are occupied. Close one session to join.');
  }
  const now = ctx.timestamp.microsSinceUnixEpoch;
  if (existing) {
    ctx.db.player.identity.update({ ...existing, online: true, connectionId: ctx.connectionId,
      seq: 0, jumpSeq: 0, inputSeq: 0, inputJumpSeq: 0, inputForward: 0, inputRight: 0,
      inputSprint: false, inputJumpHeld: false, inputYaw: existing.yaw,
      inputCrouch: existing.crouch, inputMicros: now, sampleMicros: now });
    return;
  }
  const onlineSlots = new Set(rows.filter(row => row.online).map(row => row.slot));
  const slot = onlineSlots.has(0) ? 1 : 0;
  const previous = rows.find(row => row.slot === slot && !row.online);
  if (previous) ctx.db.player.identity.delete(previous.identity);
  const pose = previous ?? { ...initialPlayer(slot), y: ctx.db.elevator.id.find(0)!.y };
  ctx.db.player.insert({ ...pose, identity: ctx.sender, slot, online: true,
    connectionId: ctx.connectionId, seq: 0, jumpSeq: 0, sampleMicros: now,
    inputForward: 0, inputRight: 0, inputYaw: pose.yaw, inputSprint: false,
    inputCrouch: pose.crouch, inputJumpHeld: false, inputJumpSeq: 0, inputSeq: 0, inputMicros: now });
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const row = ctx.db.player.identity.find(ctx.sender);
  // A late disconnect from an earlier connection cannot evict a resumed seat.
  if (row && row.connectionId && ctx.connectionId && row.connectionId.equals(ctx.connectionId)) {
    ctx.db.player.identity.update({ ...row, online: false, connectionId: undefined,
      inputForward: 0, inputRight: 0, inputSprint: false, inputJumpHeld: false,
      inputJumpSeq: row.jumpSeq, inputMicros: ctx.timestamp.microsSinceUnixEpoch });
  }
});

const inputParams = {
  forward: t.f64(), right: t.f64(), yaw: t.f64(), sprint: t.bool(), crouch: t.bool(),
  jumpHeld: t.bool(), jumpSeq: t.u32(), seq: t.u32(),
};

export const submitInput = spacetimedb.reducer(inputParams, (ctx, input) => {
  const row = joinedPlayer(ctx);
  if (![input.forward, input.right, input.yaw].every(Number.isFinite)) throw new SenderError('Input must be finite.');
  if (input.seq <= row.inputSeq) return;
  const yaw = ((input.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  ctx.db.player.identity.update({ ...row,
    inputForward: Math.max(-1, Math.min(1, input.forward)), inputRight: Math.max(-1, Math.min(1, input.right)),
    inputYaw: yaw, inputSprint: input.sprint, inputCrouch: input.crouch, inputJumpHeld: input.jumpHeld,
    inputJumpSeq: input.jumpSeq, inputSeq: input.seq, inputMicros: ctx.timestamp.microsSinceUnixEpoch });
});

export const selectFloor = spacetimedb.reducer({ floor: t.u8() }, (ctx, { floor }) => {
  const row = joinedPlayer(ctx);
  const cab = elevatorState(ctx);
  if (!insideCab(row, cab)) throw new SenderError('Select a floor from inside the cabin.');
  if (!requestFloor(cab, floor) && (floor < 1 || floor > 20)) throw new SenderError('Choose a floor from 1 to 20.');
  ctx.db.elevator.id.update(cab);
});

export const hailFloor = spacetimedb.reducer({ floor: t.u8() }, (ctx, { floor }) => {
  const row = joinedPlayer(ctx);
  if (!nearLanding(row, floor)) throw new SenderError('Stand near this landing to call the elevator.');
  const cab = elevatorState(ctx);
  requestFloor(cab, floor);
  ctx.db.elevator.id.update(cab);
});

export const toggleLandingDoor = spacetimedb.reducer({ floor: t.u8() }, (ctx, { floor }) => {
  const row = joinedPlayer(ctx);
  const cab = elevatorState(ctx);
  if (!nearLanding(row, floor) && !(insideCab(row, cab) && cab.currentFloor === floor)) {
    throw new SenderError('Stand beside the landing door to use it.');
  }
  if (!toggleDoor(cab, floor)) throw new SenderError('The landing door is locked until the elevator arrives.');
  ctx.db.elevator.id.update(cab);
});

export const setDoorOpen = spacetimedb.reducer({ open: t.bool() }, (ctx, { open }) => {
  const row = joinedPlayer(ctx);
  const cab = elevatorState(ctx);
  if (!insideCab(row, cab)) throw new SenderError('Use the cabin door control from inside.');
  if (!setDoor(cab, open)) throw new SenderError('Doors stay closed while travelling.');
  ctx.db.elevator.id.update(cab);
});

export const respawn = spacetimedb.reducer(ctx => {
  const row = joinedPlayer(ctx);
  const cab = elevatorState(ctx);
  ctx.db.player.identity.update({ ...row, ...initialPlayer(row.slot), y: cab.y,
    jumpSeq: row.inputJumpSeq, seq: row.inputSeq, inputForward: 0, inputRight: 0,
    inputSprint: false, inputJumpHeld: false, sampleMicros: ctx.timestamp.microsSinceUnixEpoch });
});

export const simulate = spacetimedb.reducer({ onSchedule: tick }, { arg: tick.rowType }, (ctx, _arg) => {
  if (!ctx.sender.equals(ctx.identity)) throw new SenderError('Only the database scheduler may advance physics.');
  const cab = elevatorState(ctx);
  const rows = [...ctx.db.player.iter()];
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const previousY = cab.y;
  // Safety edge reopens both leaves until the capsule clears the threshold.
  if (cab.phase === 'closing' && rows.some(row => row.online && doorwayOccupied(row, cab))) {
    setDoor(cab, true);
    cab.landingDoors[cab.currentFloor - 1] = true;
  }
  stepElevator(cab, TICK_DT);
  cab.sampleMicros = now;
  ctx.db.elevator.id.update(cab);
  for (const row of rows) {
    // Lost packets never leave a character walking forever. An abandoned connection
    // releases its seat after ten seconds; a reconnect can resume the stored pose.
    const staleMicros = now - row.inputMicros;
    const input: InputState = row.online && staleMicros <= 300_000n ? {
      forward: row.inputForward, right: row.inputRight, yaw: row.inputYaw,
      sprint: row.inputSprint, crouch: row.inputCrouch, jumpHeld: row.inputJumpHeld,
      jumpSeq: row.inputJumpSeq, seq: row.inputSeq,
    } : idleInput(row);
    stepPlayer(row, input, cab, previousY, TICK_DT);
    if (row.online && staleMicros > 10_000_000n) {
      row.online = false;
      row.connectionId = undefined;
    }
    row.sampleMicros = now;
    ctx.db.player.identity.update(row);
  }
  // One fixed step per scheduled invocation, including after a host restart:
  // downtime is never replayed as a huge fall or jump through twenty floors.
});

function elevatorState(ctx: Context): ElevatorState {
  const row = ctx.db.elevator.id.find(0)!;
  // The runtime decodes array<u8> as Uint8Array, despite the inferred number[]
  // type. Normalize at the database boundary before shared FIFO push/shift.
  return { ...row, queue: Array.from(row.queue) };
}

function joinedPlayer(ctx: Context): PlayerRow {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (!row?.online || !ctx.connectionId || !row.connectionId?.equals(ctx.connectionId)) {
    throw new SenderError('Join an available player seat first.');
  }
  return row;
}
