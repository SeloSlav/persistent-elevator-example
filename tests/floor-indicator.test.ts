import test from 'node:test';
import assert from 'node:assert/strict';
import { floorIndicator } from '../src/floor-indicator';
import { floorY, initialElevator } from '../shared/simulation';

test('indicator changes through every floor during ascent without waiting for docking', () => {
  const state = { ...initialElevator(), phase: 'moving', targetFloor: 20, currentFloor: 0 };
  for (let floor = 0; floor < 20; floor++) {
    state.y = floorY(floor) + .1;
    assert.deepEqual(floorIndicator(state), { floor, label: floor === 0 ? 'G' : String(floor), direction: 'up' });
  }
  state.y = floorY(20);
  assert.deepEqual(floorIndicator(state), { floor: 20, label: '20', direction: 'idle' });
});

test('descent reaches G and reverses its arrow without using the last docked floor', () => {
  const state = { ...initialElevator(), phase: 'moving', targetFloor: 0, currentFloor: 20 };
  for (let floor = 20; floor > 0; floor--) {
    state.y = floorY(floor) - .1;
    assert.equal(floorIndicator(state).floor, floor);
    assert.equal(floorIndicator(state).direction, 'down');
  }
  state.y = floorY(0);
  assert.deepEqual(floorIndicator(state), { floor: 0, label: 'G', direction: 'idle' });
  state.phase = 'opening';
  assert.equal(floorIndicator(state).direction, 'idle');
});

test('floor indication switches at the midpoint and clamps to physical stops', () => {
  const state = initialElevator();
  assert.equal(floorIndicator({ ...state, y: -2.01 }).label, 'G');
  assert.equal(floorIndicator({ ...state, y: -1.99 }).label, '1');
  assert.equal(floorIndicator({ ...state, y: 1.99 }).label, '1');
  assert.equal(floorIndicator({ ...state, y: 2.01 }).label, '2');
  assert.equal(floorIndicator({ ...state, y: -100 }).label, 'G');
  assert.equal(floorIndicator({ ...state, y: 100 }).label, '20');
});
