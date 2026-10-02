import test from 'node:test';
import assert from 'node:assert/strict';
import { ElevatorMotion, riderDisplayY, riderFrameHandoffY } from '../src/motion';
import {
  CAB_HEIGHT, EYE_HEIGHT, ELEVATOR_SPEED, floorY, idleInput,
  initialElevator, initialPlayer, requestFloor, stepElevator, stepPlayer,
  type ElevatorState,
} from '../shared/simulation';

function trace(descending: boolean): { state: ElevatorState; receivedAt: number }[] {
  const state = initialElevator();
  if (descending) {
    state.y = floorY(20);
    state.currentFloor = state.targetFloor = 20;
  }
  requestFloor(state, descending ? 1 : 20);
  const events: { state: ElevatorState; receivedAt: number }[] = [];
  // Includes delayed and out-of-order packets and repeated reducer updates at
  // one server sample. The latter used to restart extrapolation each receipt.
  const delays = [22, 95, 18, 70, 45, 125, 20, 105];
  for (let tick = 0; tick <= 720; tick++) {
    if (tick) stepElevator(state, .05);
    state.sampleMicros = 1_000_000n + BigInt(tick * 50_000);
    const receivedAt = tick * 50 + delays[tick % delays.length]!;
    events.push({ state: structuredClone(state), receivedAt });
    if (tick % 9 === 0) events.push({ state: structuredClone(state), receivedAt: receivedAt + 12 });
  }
  return events.sort((a, b) => a.receivedAt - b.receivedAt);
}

for (const descending of [false, true]) {
  test(`jittered ${descending ? 'descent' : 'ascent'} never reverses and both riders remain fixed in the cab`, () => {
    const motion = new ElevatorMotion();
    const events = trace(descending);
    let index = 0;
    let packet: typeof events[number] | undefined;
    let previous: ElevatorState | undefined;
    let largestStep = 0;
    const riders = [initialPlayer(0), initialPlayer(1)];
    for (let now = 0; now <= 36_500; now += 1000 / 144) {
      while (index < events.length && events[index]!.receivedAt <= now) packet = events[index++];
      const cab = motion.update(packet?.state, packet?.receivedAt ?? 0, now);
      if (!packet) continue;
      if (previous) {
        const travel = cab.y - previous.y;
        assert.ok(descending ? travel <= 1e-9 : travel >= -1e-9, `lift reversed at ${now}: ${travel}`);
        largestStep = Math.max(largestStep, Math.abs(travel));
      }
      for (const rider of riders) {
        rider.y = packet.state.y;
        const feet = riderDisplayY(rider, packet.state, cab);
        assert.equal(feet, cab.y);
        assert.ok(Math.abs((feet + EYE_HEIGHT) - cab.y - EYE_HEIGHT) < 1e-9);
      }
      previous = cab;
    }
    assert.equal(previous!.y, floorY(descending ? 1 : 20));
    // A new snapshot must not teleport the cab more than a high-refresh frame's
    // travel, allowing for the bounded clock slew and interpolation acceleration.
    assert.ok(largestStep < ELEVATOR_SPEED / 144 + .01, `largest frame step: ${largestStep}`);
  });
}

test('same-timestamp reducer packets do not reset the elevator trajectory', () => {
  const state = { ...initialElevator(), y: 10, targetFloor: 20, phase: 'moving', velocity: ELEVATOR_SPEED, door: 0, sampleMicros: 100_000n };
  const motion = new ElevatorMotion();
  let cab = motion.update(state, 0, 0);
  for (let now = 10; now <= 200; now += 10) {
    const before = cab.y;
    cab = motion.update({ ...state, queue: [18] }, now, now);
    assert.ok(cab.y >= before);
  }
  assert.ok(cab.y > 10.25);
  assert.deepEqual(cab.queue, [18]);
});

test('a delayed arrival confirmation cannot pull the cab away from its landing', () => {
  const first = { ...initialElevator(), y: floorY(20) - .06, targetFloor: 20, phase: 'moving', velocity: .8, door: 0, sampleMicros: 1_000_000n };
  const motion = new ElevatorMotion();
  motion.update(first, 0, 0);
  const reached = motion.update(first, 0, 200);
  assert.equal(reached.y, floorY(20));
  const delayed = structuredClone(first);
  stepElevator(delayed, .05);
  // The scheduler advanced one fixed physics tick after a longer wall-clock
  // pause. Its position is confirmed behind the bounded rendered prediction.
  delayed.sampleMicros += 120_000n;
  const confirmed = motion.update(delayed, 205, 205);
  assert.equal(confirmed.y, reached.y);
});

test('moving-frame presentation preserves a capsule jump without damping controls', () => {
  const simulationCab = { ...initialElevator(), y: 10, targetFloor: 20, phase: 'moving', velocity: ELEVATOR_SPEED, door: 0 };
  const rider = { ...initialPlayer(), y: 10 };
  let maximumHeight = 0;
  for (let frame = 0; frame < 60; frame++) {
    const previousY = simulationCab.y;
    stepElevator(simulationCab, 1 / 60);
    stepPlayer(rider, { ...idleInput(rider), jumpSeq: 1, jumpHeld: true }, simulationCab, previousY, 1 / 60);
    const displayCab = { ...simulationCab, y: simulationCab.y - .3 };
    const relativeHeight = rider.y - simulationCab.y;
    maximumHeight = Math.max(maximumHeight, relativeHeight);
    assert.ok(Math.abs((riderDisplayY(rider, simulationCab, displayCab) - displayCab.y) - relativeHeight) < 1e-9);
  }
  assert.ok(maximumHeight > .6);
  assert.equal(rider.grounded, true);
});

test('roof riders use the same frame and landing players remain world anchored', () => {
  const simulationCab = { ...initialElevator(), y: 20 };
  const displayCab = { ...simulationCab, y: 19.8 };
  const roof = { ...initialPlayer(), y: 23.12, inCab: false, onRoof: true };
  assert.equal(riderDisplayY(roof, simulationCab, displayCab), displayCab.y + CAB_HEIGHT + .12);
  const landing = { ...initialPlayer(), y: 20, inCab: false };
  assert.equal(riderDisplayY(landing, simulationCab, displayCab), 20);
});

test('an outage freezes the last presented pose and reset accepts a fresh timeline', () => {
  const state = { ...initialElevator(), y: 10, targetFloor: 20, phase: 'moving', velocity: ELEVATOR_SPEED, door: 0, sampleMicros: 100_000n };
  const motion = new ElevatorMotion();
  motion.update(state, 0, 0);
  const before = motion.update(state, 0, 200);
  const frozen = motion.update(undefined, 0, 10_000);
  assert.equal(frozen.y, before.y);
  motion.reset();
  assert.equal(motion.update(initialElevator(), 10_000, 10_000).y, 0);
});

test('frame handoffs preserve rendered airborne height during pose reconciliation', () => {
  const cab = { inCab: true, onRoof: false };
  const roof = { inCab: false, onRoof: true };
  const world = { inCab: false, onRoof: false };
  const beforeSimulationY = 10;
  const afterSimulationY = 10.15;
  const displayY = 9.9;
  const oldWorldY = 11.2;
  const newWorldY = 11.25;
  for (const riding of [cab, roof]) {
    const oldRidingDisplay = oldWorldY - beforeSimulationY + displayY;
    const worldOffset = oldWorldY - newWorldY + riderFrameHandoffY(riding, world, beforeSimulationY, afterSimulationY, displayY);
    assert.ok(Math.abs(newWorldY + worldOffset - oldRidingDisplay) < 1e-9);
    const oldWorldDisplay = oldWorldY;
    const ridingOffset = oldWorldY - newWorldY + riderFrameHandoffY(world, riding, beforeSimulationY, afterSimulationY, displayY);
    const newRidingDisplay = newWorldY - afterSimulationY + displayY + ridingOffset;
    assert.ok(Math.abs(newRidingDisplay - oldWorldDisplay) < 1e-9);
  }
  assert.equal(riderFrameHandoffY(cab, roof, beforeSimulationY, afterSimulationY, displayY), 0);
  assert.equal(riderFrameHandoffY(roof, cab, beforeSimulationY, afterSimulationY, displayY), 0);
  assert.equal(riderFrameHandoffY(world, world, beforeSimulationY, afterSimulationY, displayY), 0);
});

test('leaving a moving roof keeps physical jump/fall displacement without a buffered-frame snap', () => {
  const simulationCab = { ...initialElevator(), y: 10, targetFloor: 20, phase: 'moving', velocity: ELEVATOR_SPEED, door: 0 };
  const player = { ...initialPlayer(), x: 1.79, y: simulationCab.y + CAB_HEIGHT + .12, inCab: false, onRoof: true };
  const support = { inCab: player.inCab, onRoof: player.onRoof };
  const oldY = player.y;
  const previousCabY = simulationCab.y;
  stepElevator(simulationCab, 1 / 60);
  // Render and simulation share one post-advection cab origin for this physics
  // handoff. The physical step still owns all jump/fall displacement.
  const displayCab = { ...simulationCab, y: simulationCab.y - .3 };
  const priorRenderedY = oldY + displayCab.y - simulationCab.y;
  stepPlayer(player, { ...idleInput(player), right: 1, yaw: 0, sprint: true }, simulationCab, previousCabY, 1 / 60);
  assert.equal(player.onRoof, false);
  assert.equal(player.inCab, false);
  assert.ok(player.vy > 1.5);
  const offset = riderFrameHandoffY(support, player, simulationCab.y, simulationCab.y, displayCab.y);
  const displayedY = riderDisplayY(player, simulationCab, displayCab) + offset;
  assert.ok(Math.abs((displayedY - priorRenderedY) - (player.y - oldY)) < 1e-9);
  assert.ok(Math.abs(offset + .3) < 1e-9);
});
