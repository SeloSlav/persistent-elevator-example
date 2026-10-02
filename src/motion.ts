import {
  CAB_HEIGHT, FLOOR_HEIGHT, initialElevator, stepElevator,
  type ElevatorState, type PlayerState,
} from '../shared/simulation';

type Sample = { time: number; state: ElevatorState };

/**
 * Presents the shared cabin on one continuous server timeline. Packet receipt
 * time must not be the origin of each new trajectory: that makes an ascending
 * cabin step backwards every time a slightly late snapshot arrives.
 *
 * Physics still runs against its own current/predicted authoritative state.
 * This small buffer belongs only to rendering, including the rider's camera.
 */
export class ElevatorMotion {
  private samples: Sample[] = [];
  private sourceOrigin?: bigint;
  private clockOffset = 0;
  private bestClockOffset = Infinity;
  private lastReceipt = -1;
  private playhead = -Infinity;
  private previousNow?: number;
  private presented?: ElevatorState;

  constructor(private readonly delayMs = 100, private readonly extrapolationMs = 100) {}

  update(snapshot: ElevatorState | undefined, receivedAt: number, now: number): ElevatorState {
    const dt = Math.max(0, now - (this.previousNow ?? now));
    this.previousNow = now;
    if (snapshot && receivedAt !== this.lastReceipt) {
      this.lastReceipt = receivedAt;
      this.receive(snapshot, receivedAt);
    }
    if (!this.samples.length) return initialElevator();
    if (!snapshot && this.presented) return clone(this.presented);

    // A lower measured latency may move the clock forwards, but cannot move it
    // backwards. Slew it slowly so discovering a better clock estimate is not a
    // sudden burst of elevator movement.
    this.clockOffset = Math.max(this.bestClockOffset, this.clockOffset - dt * .04);
    this.playhead = Math.max(this.playhead, now - this.clockOffset - this.delayMs);

    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    let state: ElevatorState;
    if (this.playhead <= first.time) state = clone(first.state);
    else if (this.playhead >= last.time) {
      state = clone(last.state);
      let remaining = snapshot ? Math.min(this.extrapolationMs, this.playhead - last.time) / 1000 : 0;
      while (remaining > .000001) {
        const h = Math.min(1 / 60, remaining);
        stepElevator(state, h);
        remaining -= h;
      }
    } else {
      let upper = 1;
      while (this.samples[upper]!.time < this.playhead) upper++;
      const a = this.samples[upper - 1]!;
      const b = this.samples[upper]!;
      const span = b.time - a.time;
      const t = (this.playhead - a.time) / span;
      state = clone(a.state);
      state.y = monotoneHermite(a.state.y, b.state.y, a.state.velocity, b.state.velocity, span / 1000, t);
      state.door = lerp(a.state.door, b.state.door, t);
      state.landingOpen = a.state.landingOpen.map((value, i) => lerp(value, b.state.landingOpen[i] ?? value, t));
    }

    const old = this.presented;
    if (old && old.targetFloor === state.targetFloor && (old.phase === 'moving' || state.phase === 'moving')) {
      const targetY = (state.targetFloor - 1) * FLOOR_HEIGHT;
      const direction = Math.sign(targetY - old.y) || Math.sign(targetY - state.y);
      // If jitter exhausts the interpolation buffer, a late packet may be behind
      // the last bounded extrapolation. Hold until it catches up rather than
      // reversing the lift. A later journey is allowed to travel the other way.
      if (direction > 0) state.y = Math.max(old.y, state.y);
      else if (direction < 0) state.y = Math.min(old.y, state.y);
    }
    // Queue changes are instant feedback. Motion/door phases stay on the same
    // buffered timeline as geometry.
    state.queue = [...last.state.queue];
    this.presented = state;
    while (this.samples.length > 2 && this.samples[1]!.time < this.playhead - 200) this.samples.shift();
    return state;
  }

  reset(): void {
    this.samples = [];
    this.sourceOrigin = undefined;
    this.clockOffset = 0;
    this.bestClockOffset = Infinity;
    this.lastReceipt = -1;
    this.playhead = -Infinity;
    this.previousNow = undefined;
    this.presented = undefined;
  }

  private receive(snapshot: ElevatorState, receivedAt: number): void {
    this.sourceOrigin ??= snapshot.sampleMicros;
    const time = Number(snapshot.sampleMicros - this.sourceOrigin) / 1000;
    const last = this.samples[this.samples.length - 1];
    if (last && time < last.time) return;
    if (last && time === last.time) {
      // Reducers can change queue/doors without advancing the simulation sample.
      // Keep their new metadata without resetting the presentation clock.
      last.state = clone(snapshot);
      return;
    }
    const observedOffset = receivedAt - time;
    this.bestClockOffset = Math.min(this.bestClockOffset, observedOffset);
    if (!last) this.clockOffset = this.bestClockOffset;
    this.samples.push({ time, state: clone(snapshot) });
  }
}

/** Put a capsule and its camera in exactly the rendered cabin's moving frame. */
export function riderDisplayY(player: PlayerState, simulationCab: ElevatorState, displayCab: ElevatorState): number {
  if (player.inCab) return displayCab.y + (player.grounded ? 0 : player.y - simulationCab.y);
  if (player.onRoof) return displayCab.y + (player.grounded ? CAB_HEIGHT + .12 : player.y - simulationCab.y);
  return player.y;
}

type RiderSupport = Pick<PlayerState, 'inCab' | 'onRoof'>;

/**
 * The additive presentation offset when a pose changes coordinate frames.
 * Apply this alongside the normal pose correction; it preserves the already
 * rendered height without changing physical jump velocity or displacement.
 * Cab interior and roof both use the same moving frame.
 */
export function riderFrameHandoffY(
  before: RiderSupport, after: RiderSupport,
  beforeSimulationY: number, afterSimulationY: number, displayY: number,
): number {
  const wasRiding = before.inCab || before.onRoof;
  const isRiding = after.inCab || after.onRoof;
  if (wasRiding === isRiding) return 0;
  return wasRiding ? displayY - beforeSimulationY : afterSimulationY - displayY;
}

function clone(state: ElevatorState): ElevatorState {
  return { ...state, queue: [...state.queue], landingDoors: [...state.landingDoors], landingOpen: [...state.landingOpen] };
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Cubic interpolation with bounded tangents: smooth, with no overshoot. */
function monotoneHermite(a: number, b: number, va: number, vb: number, seconds: number, t: number): number {
  const delta = b - a;
  if (Math.abs(delta) < 1e-9 || seconds <= 0) return a;
  const slope = delta / seconds;
  let alpha = Math.max(0, va / slope);
  let beta = Math.max(0, vb / slope);
  const magnitude = Math.hypot(alpha, beta);
  if (magnitude > 3) { alpha *= 3 / magnitude; beta *= 3 / magnitude; }
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * alpha * delta +
    (-2 * t3 + 3 * t2) * b + (t3 - t2) * beta * delta;
}
