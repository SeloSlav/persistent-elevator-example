/** Shared by the authoritative reducer and browser prediction. No rendering or SDK imports. */
export const FLOORS = 20;
export const FLOOR_HEIGHT = 4;
export const CAB_HALF = 1.8;
export const CAB_HEIGHT = 3;
export const DOOR_HALF_WIDTH = 0.85;
export const PLATFORM_HALF_WIDTH = 3.8;
export const PLATFORM_FRONT = 7.8;
export const PLAYER_RADIUS = 0.22;
export const PLAYER_HEIGHT = 1.78;
export const CROUCH_HEIGHT = 1.2;
export const EYE_HEIGHT = 1.55;
export const CROUCH_EYE_HEIGHT = 1;
export const WALK_SPEED = 5;
export const SPRINT_SPEED = 7.5;
export const CROUCH_SPEED = 2.8;
export const GRAVITY = 21.5;
export const JUMP_SPEED = 5.7;
export const ELEVATOR_SPEED = 3.15;
export const TICK_DT = 0.05;
const ELEVATOR_ACCEL = 1.4;
const DOOR_SPEED = 2.35;
const LANDING_DOOR_SPEED = 4.5;
const ARRIVAL_HOLD = 2;
const EPSILON = 0.00001;

export interface InputState {
  forward: number;
  right: number;
  yaw: number;
  sprint: boolean;
  crouch: boolean;
  jumpHeld: boolean;
  jumpSeq: number;
  seq: number;
}

export interface ElevatorState {
  id: number;
  y: number;
  velocity: number;
  currentFloor: number;
  targetFloor: number;
  phase: string;
  door: number;
  queue: number[];
  phaseTime: number;
  landingDoors: boolean[];
  landingOpen: number[];
  sampleMicros: bigint;
}

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  vx: number;
  /** Relative to the cabin while inCab; world velocity otherwise. */
  vy: number;
  vz: number;
  yaw: number;
  grounded: boolean;
  crouch: boolean;
  inCab: boolean;
  onRoof: boolean;
  jumpActive: boolean;
  jumpSeq: number;
  seq: number;
}

export function floorY(floor: number): number {
  return (floor - 1) * FLOOR_HEIGHT;
}

export function validFloor(floor: number): boolean {
  return Number.isInteger(floor) && floor >= 1 && floor <= FLOORS;
}

export function initialElevator(): ElevatorState {
  return {
    id: 0, y: 0, velocity: 0, currentFloor: 1, targetFloor: 1,
    phase: 'idle', door: 1, queue: [], phaseTime: ARRIVAL_HOLD,
    landingDoors: Array.from({ length: FLOORS }, () => false),
    landingOpen: Array.from({ length: FLOORS }, () => 0), sampleMicros: 0n,
  };
}

export function initialPlayer(slot = 0): PlayerState {
  return {
    x: slot === 0 ? -0.55 : 0.55, y: 0, z: 0.25,
    vx: 0, vy: 0, vz: 0, yaw: Math.PI,
    grounded: true, crouch: false, inCab: true, onRoof: false, jumpActive: false, jumpSeq: 0, seq: 0,
  };
}

export function idleInput(player?: PlayerState): InputState {
  return { forward: 0, right: 0, yaw: player?.yaw ?? Math.PI,
    sprint: false, crouch: player?.crouch ?? false, jumpHeld: false,
    jumpSeq: player?.jumpSeq ?? 0, seq: player?.seq ?? 0 };
}

export function docked(elevator: ElevatorState, floor = elevator.currentFloor): boolean {
  return validFloor(floor) && elevator.phase !== 'moving' &&
    Math.abs(elevator.y - floorY(floor)) < 0.025;
}

/** FIFO requests are shared by both players; duplicate buttons never add another stop. */
export function requestFloor(elevator: ElevatorState, floor: number): boolean {
  if (!validFloor(floor)) return false;
  if (docked(elevator, floor)) {
    elevator.phase = 'opening';
    elevator.phaseTime = ARRIVAL_HOLD;
    return true;
  }
  if ((elevator.phase === 'moving' && elevator.targetFloor === floor) ||
      elevator.queue.includes(floor)) return false;
  elevator.queue.push(floor);
  return true;
}

export function setDoor(elevator: ElevatorState, open: boolean): boolean {
  if (!docked(elevator)) return false;
  elevator.phase = open ? 'opening' : 'closing';
  elevator.phaseTime = open ? ARRIVAL_HOLD : 0;
  return true;
}

/** Exterior swing doors are manual, and can only be unlocked by the docked cabin. */
export function toggleLandingDoor(elevator: ElevatorState, floor: number): boolean {
  if (!docked(elevator, floor)) return false;
  elevator.landingDoors[floor - 1] = !elevator.landingDoors[floor - 1];
  elevator.phaseTime = ARRIVAL_HOLD;
  if (elevator.landingDoors[floor - 1]) elevator.phase = 'opening';
  return true;
}

export function doorwayOccupied(player: PlayerState, elevator: ElevatorState): boolean {
  return docked(elevator) && Math.abs(player.x) < DOOR_HALF_WIDTH + PLAYER_RADIUS &&
    Math.abs(player.z - CAB_HALF) < PLAYER_RADIUS + 0.12 &&
    player.y < elevator.y + 2.6 && player.y + (player.crouch ? CROUCH_HEIGHT : PLAYER_HEIGHT) > elevator.y;
}

export function stepElevator(elevator: ElevatorState, dt: number): void {
  const h = Math.max(0, Math.min(dt, TICK_DT));
  const oldY = elevator.y;
  if (elevator.phase === 'closing' || elevator.phase === 'moving') {
    elevator.landingDoors.fill(false);
  }
  for (let i = 0; i < FLOORS; i++) {
    const target = elevator.landingDoors[i] && docked(elevator, i + 1) ? 1 : 0;
    elevator.landingOpen[i] = approach(elevator.landingOpen[i]!, target, LANDING_DOOR_SPEED * h);
  }
  if (elevator.phase === 'idle') {
    elevator.phaseTime = Math.max(0, elevator.phaseTime - h);
    if (elevator.queue.length && elevator.phaseTime <= 0) elevator.phase = 'closing';
  } else if (elevator.phase === 'closing') {
    elevator.door = approach(elevator.door, 0, DOOR_SPEED * h);
    if (elevator.door === 0 && elevator.landingOpen.every(open => open === 0)) {
      const next = elevator.queue.shift();
      if (next !== undefined) {
        elevator.targetFloor = next;
        elevator.phase = 'moving';
      } else {
        elevator.phase = 'idle';
      }
    }
  } else if (elevator.phase === 'moving') {
    const remaining = floorY(elevator.targetFloor) - elevator.y;
    const direction = Math.sign(remaining);
    const targetSpeed = Math.min(ELEVATOR_SPEED, Math.sqrt(2 * ELEVATOR_ACCEL * Math.abs(remaining)));
    elevator.velocity = approach(elevator.velocity, direction * targetSpeed, ELEVATOR_ACCEL * h);
    const travel = elevator.velocity * h;
    if (Math.abs(remaining) <= Math.abs(travel) + 0.003) {
      elevator.y = floorY(elevator.targetFloor);
      elevator.currentFloor = elevator.targetFloor;
      elevator.velocity = 0;
      elevator.phase = 'opening';
      elevator.phaseTime = ARRIVAL_HOLD;
    } else {
      elevator.y += travel;
    }
  } else if (elevator.phase === 'opening') {
    elevator.door = approach(elevator.door, 1, DOOR_SPEED * h);
    if (elevator.door === 1) elevator.phase = 'idle';
  }
  // Exact displacement gives riders the same moving frame on server and client.
  elevator.velocity = h > 0 ? (elevator.y - oldY) / h : elevator.velocity;
}

export function insideCab(player: PlayerState, elevator: ElevatorState): boolean {
  return Math.abs(player.x) <= CAB_HALF && player.z >= -CAB_HALF && player.z <= CAB_HALF &&
    player.y >= elevator.y - 0.08 && player.y < elevator.y + CAB_HEIGHT - 0.05;
}

export function nearLanding(player: PlayerState, floor: number): boolean {
  return validFloor(floor) && Math.abs(player.y - floorY(floor)) <= 1.25 &&
    Math.abs(player.x) < 2.3 && player.z >= CAB_HALF - 0.5 && player.z <= CAB_HALF + 3;
}

/** Server-authoritative feet position; input is intent only, never a submitted transform. */
export function stepPlayer(
  player: PlayerState, input: InputState, elevator: ElevatorState, previousElevatorY: number, dt: number,
): void {
  const h = Math.max(0, Math.min(dt, TICK_DT));
  if (h === 0) return;
  player.yaw = Number.isFinite(input.yaw) ? input.yaw : player.yaw;
  // Do not let standing up put the capsule through the ceiling.
  player.crouch = input.crouch || (player.inCab && player.y + PLAYER_HEIGHT > elevator.y + CAB_HEIGHT);
  const magnitude = Math.max(1, Math.hypot(input.forward, input.right));
  const forward = Math.max(-1, Math.min(1, input.forward)) / magnitude;
  const right = Math.max(-1, Math.min(1, input.right)) / magnitude;
  const speed = player.crouch ? CROUCH_SPEED : input.sprint ? SPRINT_SPEED : WALK_SPEED;
  const damping = Math.exp(-(player.grounded ? 19 : 7.8) * h);
  const desiredX = (-Math.sin(player.yaw) * forward + Math.cos(player.yaw) * right) * speed;
  const desiredZ = (-Math.cos(player.yaw) * forward - Math.sin(player.yaw) * right) * speed;
  player.vx = desiredX + (player.vx - desiredX) * damping;
  player.vz = desiredZ + (player.vz - desiredZ) * damping;
  if (!forward && !right && player.grounded) {
    const drag = Math.exp(-10 * h);
    player.vx *= drag;
    player.vz *= drag;
    if (Math.hypot(player.vx, player.vz) < 0.01) player.vx = player.vz = 0;
  }
  if (input.jumpSeq > player.jumpSeq) {
    player.jumpSeq = input.jumpSeq;
    if (player.grounded) {
      player.vy = JUMP_SPEED + (player.onRoof ? elevator.velocity : 0);
      player.grounded = false;
      player.onRoof = false;
      player.jumpActive = true;
    }
  }
  player.seq = input.seq;
  const steps = Math.max(1, Math.round(h * 200));
  const sh = h / steps;
  const cabDy = (elevator.y - previousElevatorY) / steps;
  for (let i = 0; i < steps; i++) {
    const cabY = previousElevatorY + cabDy * (i + 1);
    if (player.inCab || player.onRoof) player.y += cabDy;
    const oldX = player.x;
    const oldY = player.y;
    const oldZ = player.z;
    player.vy -= GRAVITY * sh;
    if (player.jumpActive && player.vy > 0.02 && !input.jumpHeld) player.vy *= 0.91;
    player.x += player.vx * sh;
    player.z += player.vz * sh;
    player.y += player.vy * sh;
    player.grounded = false;
    const height = player.crouch ? CROUCH_HEIGHT : PLAYER_HEIGHT;
    const intersectsCab = player.y < cabY + CAB_HEIGHT && player.y + height > cabY;
    if (intersectsCab) {
      // Thin AABB walls work from both sides, including a fall alongside the shaft.
      collideBox(player, oldX, oldZ, -CAB_HALF - 0.12, -CAB_HALF, -CAB_HALF, CAB_HALF);
      collideBox(player, oldX, oldZ, CAB_HALF, CAB_HALF + 0.12, -CAB_HALF, CAB_HALF);
      collideBox(player, oldX, oldZ, -CAB_HALF, CAB_HALF, -CAB_HALF - 0.12, -CAB_HALF);
      collideBox(player, oldX, oldZ, -CAB_HALF, -DOOR_HALF_WIDTH, CAB_HALF, CAB_HALF + 0.12);
      collideBox(player, oldX, oldZ, DOOR_HALF_WIDTH, CAB_HALF, CAB_HALF, CAB_HALF + 0.12);
      const floor = Math.round(cabY / FLOOR_HEIGHT) + 1;
      const passable = validFloor(floor) && Math.abs(cabY - floorY(floor)) < 0.025 &&
        elevator.phase !== 'moving' && elevator.door >= 0.88 && elevator.landingOpen[floor - 1]! >= 0.88;
      if (!passable) collideBox(player, oldX, oldZ, -DOOR_HALF_WIDTH, DOOR_HALF_WIDTH, CAB_HALF, CAB_HALF + 0.12);
      if (player.inCab && player.y + height > cabY + CAB_HEIGHT) {
        player.y = cabY + CAB_HEIGHT - height;
        player.vy = Math.min(0, player.vy);
        player.jumpActive = false;
      }
    }
    // Closed exterior gates stay locked even while the cabin is elsewhere.
    for (let floor = 1; floor <= FLOORS; floor++) {
      const y = floorY(floor);
      if (player.y < y + 2.65 && player.y + height > y && elevator.landingOpen[floor - 1]! < 0.88) {
        collideBox(player, oldX, oldZ, -DOOR_HALF_WIDTH, DOOR_HALF_WIDTH, CAB_HALF + 0.12, CAB_HALF + 0.2);
      }
      if (Math.abs(player.x) <= PLATFORM_HALF_WIDTH && player.z >= CAB_HALF && player.z <= PLATFORM_FRONT) {
        land(player, oldY, y);
        hitUnderside(player, oldY, height, y - 0.22);
      }
    }
    if (Math.abs(player.x) <= 18 && Math.abs(player.z) <= 18) land(player, oldY, -4);
    const overCab = Math.abs(player.x) <= CAB_HALF && Math.abs(player.z) <= CAB_HALF;
    if (overCab) {
      if (player.inCab) land(player, oldY, cabY);
      if (!player.inCab && land(player, oldY, cabY + CAB_HEIGHT + 0.12)) player.onRoof = true;
      if (!player.inCab) hitUnderside(player, oldY, height, cabY - 0.12);
    }
    const nowInCab = overCab && player.y >= cabY - 0.04 && player.y + height <= cabY + CAB_HEIGHT + 0.005;
    if (player.inCab && !nowInCab) {
      player.inCab = false;
      // A jump or fall out of a moving frame inherits its vertical momentum.
      if (!player.grounded) player.vy += elevator.velocity;
    } else if (!player.inCab && nowInCab) {
      player.inCab = true;
      if (!player.grounded) player.vy -= elevator.velocity;
    }
    if (player.onRoof && (!overCab || !player.grounded)) {
      player.onRoof = false;
      if (!player.grounded) player.vy += elevator.velocity;
    }
  }
  if (player.y < -12 || ![player.x, player.y, player.z].every(Number.isFinite)) {
    const jumpSeq = player.jumpSeq;
    const seq = player.seq;
    Object.assign(player, initialPlayer(player.x < 0 ? 0 : 1), { y: elevator.y, jumpSeq, seq });
  }
}

function approach(value: number, target: number, amount: number): number {
  return value < target ? Math.min(value + amount, target) : Math.max(value - amount, target);
}

function land(player: PlayerState, oldY: number, top: number): boolean {
  if (player.vy <= 0 && oldY >= top - 0.03 && player.y <= top + EPSILON) {
    player.y = top;
    player.vy = 0;
    player.grounded = true;
    player.jumpActive = false;
    return true;
  }
  return false;
}

function hitUnderside(player: PlayerState, oldY: number, height: number, bottom: number): void {
  if (player.vy > 0 && oldY + height <= bottom && player.y + height >= bottom) {
    player.y = bottom - height;
    player.vy = 0;
    player.jumpActive = false;
  }
}

function collideBox(player: PlayerState, oldX: number, oldZ: number, minX: number, maxX: number, minZ: number, maxZ: number): void {
  const r = PLAYER_RADIUS;
  if (player.x + r <= minX || player.x - r >= maxX || player.z + r <= minZ || player.z - r >= maxZ) return;
  if (oldX + r <= minX) { player.x = minX - r; player.vx = 0; }
  else if (oldX - r >= maxX) { player.x = maxX + r; player.vx = 0; }
  else if (oldZ + r <= minZ) { player.z = minZ - r; player.vz = 0; }
  else if (oldZ - r >= maxZ) { player.z = maxZ + r; player.vz = 0; }
  else {
    const distances = [Math.abs(player.x - (minX - r)), Math.abs(player.x - (maxX + r)),
      Math.abs(player.z - (minZ - r)), Math.abs(player.z - (maxZ + r))];
    const face = distances.indexOf(Math.min(...distances));
    if (face === 0 || face === 1) { player.x = face === 0 ? minX - r : maxX + r; player.vx = 0; }
    else { player.z = face === 2 ? minZ - r : maxZ + r; player.vz = 0; }
  }
}
