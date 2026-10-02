import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialElevator, initialPlayer, idleInput, stepElevator, stepPlayer,
  requestFloor, toggleLandingDoor, doorwayOccupied, floorY, TICK_DT,
  CAB_HEIGHT, PLAYER_HEIGHT, PLAYER_RADIUS, CAB_HALF,
  type ElevatorState, type PlayerState, type InputState,
} from '../shared/simulation';

function tick(elevator: ElevatorState, players: PlayerState[], inputs?: InputState[]): void {
  const previousY = elevator.y;
  stepElevator(elevator, TICK_DT);
  players.forEach((player, i) => stepPlayer(player, inputs?.[i] ?? idleInput(player), elevator, previousY, TICK_DT));
}

test('all 20 floors are valid; requests are unique and served FIFO', () => {
  const elevator = initialElevator();
  assert.equal(requestFloor(elevator, 0), false);
  assert.equal(requestFloor(elevator, 21), false);
  for (let floor = 2; floor <= 20; floor++) assert.equal(requestFloor(elevator, floor), true);
  assert.equal(requestFloor(elevator, 20), false);
  const arrivals: number[] = [];
  for (let i = 0; i < 4_000 && arrivals.length < 19; i++) {
    const previous = elevator.currentFloor;
    stepElevator(elevator, TICK_DT);
    if (elevator.currentFloor !== previous) arrivals.push(elevator.currentFloor);
  }
  assert.deepEqual(arrivals, Array.from({ length: 19 }, (_, i) => i + 2));
  assert.equal(elevator.y, floorY(20));
});

test('two riders stay on the moving cabin, including a jump while ascending', () => {
  const elevator = initialElevator();
  const riders = [initialPlayer(0), initialPlayer(1)];
  requestFloor(elevator, 20);
  for (let i = 0; i < 110; i++) tick(elevator, riders);
  assert.ok(elevator.velocity > 0.5);
  assert.equal(riders[0]!.y, elevator.y);
  assert.equal(riders[1]!.y, elevator.y);
  const jump = { ...idleInput(riders[0]), jumpSeq: 1, jumpHeld: true, seq: 1 };
  tick(elevator, riders, [jump, idleInput(riders[1])]);
  assert.ok(riders[0]!.y > elevator.y);
  assert.ok(riders[0]!.inCab);
  for (let i = 0; i < 20; i++) tick(elevator, riders, [jump, idleInput(riders[1])]);
  assert.equal(riders[0]!.y, elevator.y);
  assert.equal(riders[0]!.grounded, true);
  assert.equal(riders[1]!.y, elevator.y);
});

test('a descending cabin also carries jumping riders without falling through its floor', () => {
  const elevator = { ...initialElevator(), y: floorY(20), currentFloor: 20, targetFloor: 20 };
  const player = { ...initialPlayer(), y: elevator.y };
  requestFloor(elevator, 1);
  for (let i = 0; i < 100; i++) tick(elevator, [player]);
  assert.ok(elevator.velocity < -0.5);
  const jump = { ...idleInput(player), jumpSeq: 1, jumpHeld: true, seq: 1 };
  tick(elevator, [player], [jump]);
  assert.ok(player.y > elevator.y);
  for (let i = 0; i < 25; i++) tick(elevator, [player], [jump]);
  assert.ok(Math.abs(player.y - elevator.y) < 0.00001);
  assert.equal(player.grounded, true);
});

test('landing gates lock without a docked cabin and require manual opening for exit', () => {
  const elevator = { ...initialElevator(), y: floorY(5), currentFloor: 5, targetFloor: 5 };
  const player = { ...initialPlayer(), x: 0, y: elevator.y, z: 1.2 };
  const walk = { ...idleInput(player), forward: 1, seq: 1 };
  assert.equal(toggleLandingDoor(elevator, 6), false);
  for (let i = 0; i < 20; i++) tick(elevator, [player], [walk]);
  assert.ok(player.z <= CAB_HALF - PLAYER_RADIUS + 0.00001);
  assert.equal(toggleLandingDoor(elevator, 5), true);
  for (let i = 0; i < 20; i++) tick(elevator, [player], [walk]);
  assert.ok(player.z > CAB_HALF + 0.5);
  assert.equal(player.inCab, false);
  assert.equal(player.y, floorY(5));
  requestFloor(elevator, 10);
  const landingY = player.y;
  for (let i = 0; i < 100; i++) tick(elevator, [player]);
  assert.ok(elevator.y > landingY + 1);
  assert.equal(player.y, landingY);
  assert.equal(elevator.landingDoors[4], false);
  assert.equal(elevator.landingOpen[4], 0);
});

test('closed walls and cabin ceiling contain the player capsule', () => {
  const elevator = initialElevator();
  const player = initialPlayer();
  const right = { ...idleInput(player), right: 1, yaw: 0, sprint: true };
  for (let i = 0; i < 50; i++) tick(elevator, [player], [right]);
  assert.ok(player.x <= CAB_HALF - PLAYER_RADIUS + 0.00001);
  player.vy = 30;
  player.grounded = false;
  const held = { ...idleInput(player), jumpHeld: true };
  tick(elevator, [player], [held]);
  assert.ok(player.y + PLAYER_HEIGHT <= elevator.y + CAB_HEIGHT + 0.00001);
});

test('the safety edge detects either rider at the door threshold', () => {
  const elevator = initialElevator();
  const player = { ...initialPlayer(), x: 0, z: CAB_HALF };
  assert.equal(doorwayOccupied(player, elevator), true);
  player.x = 1.5;
  assert.equal(doorwayOccupied(player, elevator), false);
  elevator.phase = 'moving';
  player.x = 0;
  assert.equal(doorwayOccupied(player, elevator), false);
});

test('a jump off a landing falls onto the plaza rather than attaching to the cabin', () => {
  const elevator = initialElevator();
  const player = { ...initialPlayer(), x: 0, y: floorY(6), z: 7.4, inCab: false };
  const jump = { ...idleInput(player), forward: 1, jumpSeq: 1, jumpHeld: true, seq: 1 };
  for (let i = 0; i < 10; i++) tick(elevator, [player], [jump]);
  assert.ok(player.z > 7.8);
  assert.equal(player.inCab, false);
  for (let i = 0; i < 100; i++) tick(elevator, [player]);
  assert.equal(player.y, -4);
  assert.equal(player.grounded, true);
});

test('falling beyond the plaza respawns inside the current cabin', () => {
  const elevator = { ...initialElevator(), y: floorY(10), currentFloor: 10, targetFloor: 10 };
  const player = { ...initialPlayer(), x: 22, z: 22, y: floorY(20), grounded: false, inCab: false };
  let respawned = false;
  for (let i = 0; i < 100; i++) {
    tick(elevator, [player]);
    if (player.inCab) { respawned = true; break; }
  }
  assert.ok(respawned);
  assert.equal(player.y, elevator.y);
  assert.equal(player.grounded, true);
});

test('walking off the moving roof inherits upward velocity', () => {
  const elevator = { ...initialElevator(), y: 10, currentFloor: 3, targetFloor: 20, phase: 'moving', velocity: 3.15, door: 0 };
  const player = { ...initialPlayer(), x: 1.79, y: 10 + CAB_HEIGHT + 0.12, z: 0, inCab: false, onRoof: true };
  tick(elevator, [player], [{ ...idleInput(player), right: 1, yaw: 0, sprint: true }]);
  assert.equal(player.onRoof, false);
  assert.equal(player.inCab, false);
  assert.ok(player.vy > 1.5);
});

test('released Space cuts the rise while held Space reaches a higher apex', () => {
  const elevator = initialElevator();
  const held = initialPlayer();
  const released = initialPlayer();
  let heldApex = 0;
  let releasedApex = 0;
  for (let i = 0; i < 20; i++) {
    tick(elevator, [held, released], [
      { ...idleInput(held), jumpSeq: 1, jumpHeld: true },
      { ...idleInput(released), jumpSeq: 1, jumpHeld: false },
    ]);
    heldApex = Math.max(heldApex, held.y);
    releasedApex = Math.max(releasedApex, released.y);
  }
  assert.ok(heldApex > releasedApex + 0.25);
});
