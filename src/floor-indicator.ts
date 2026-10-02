import { FLOORS, GROUND_FLOOR, floorAtY, floorLabel, floorY, type ElevatorState } from '../shared/simulation';

/** Indicator follows the rendered cab, rather than its last docked floor. */
export function floorIndicator(state: Pick<ElevatorState, 'y' | 'targetFloor' | 'phase'>) {
  const floor = Math.max(GROUND_FLOOR, Math.min(FLOORS, floorAtY(state.y)));
  const difference = floorY(state.targetFloor) - state.y;
  const direction: 'up' | 'down' | 'idle' = state.phase !== 'moving' || Math.abs(difference) < .001
    ? 'idle' : difference > 0 ? 'up' : 'down';
  return { floor, label: floorLabel(floor), direction };
}
