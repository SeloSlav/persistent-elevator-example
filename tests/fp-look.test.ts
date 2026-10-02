import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFpRigLookRotations,
  createFpLookInertiaState,
  resetFpLookInertia,
  stepFpFreeLookRecenter,
  stepFpLookInertia,
  type FpLookAngleState,
} from '../src/fp-look';
import {
  FREE_LOOK_RECENTER_RATE_PER_S,
  FREE_LOOK_YAW_MAX,
  LOOK_INERTIA_COAST_GAIN,
  LOOK_INERTIA_DAMP_PER_S,
  MOUSE_SENS,
  PITCH_LIMIT,
} from '../src/fp-look-constants';

// Behavior contracts adapted from Mammoth's fpSessionCameraLook.test.ts.
const DT = 1 / 60;
const angles = (): FpLookAngleState => ({ bodyYaw: 0, pitch: 0, headLookYaw: 0 });
function close(actual: number, expected: number, epsilon = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} differs from ${expected}`);
}

test('normal pointer look can make repeated full turns in either direction', () => {
  const look = angles();
  const inertia = createFpLookInertiaState();
  for (let turn = 0; turn < 20; turn++) {
    stepFpLookInertia(inertia, look, -500, 0, 0, { freeLook: false });
  }
  close(look.bodyYaw, 22);
  assert.ok(look.bodyYaw > Math.PI * 2 * 3);
  for (let turn = 0; turn < 40; turn++) {
    stepFpLookInertia(inertia, look, 500, 0, 0, { freeLook: false });
  }
  close(look.bodyYaw, -22);
  assert.ok(look.bodyYaw < -Math.PI * 2 * 3);
  assert.equal(look.headLookYaw, 0);
});

test('a pointer event updates view rotation immediately before the next frame', () => {
  const look = angles();
  const inertia = createFpLookInertiaState();
  const nodes = {
    playerRig: { rotation: { y: 0 } },
    headPitch: { rotation: { x: 0 } },
    headCameraPitch: { rotation: { x: 0 } },
    headFreeLook: { rotation: { y: 0 } },
  };
  stepFpLookInertia(inertia, look, -120, 40, 0, { freeLook: false });
  applyFpRigLookRotations(nodes, look, false);
  close(nodes.playerRig.rotation.y, 0.264);
  close(nodes.headCameraPitch.rotation.x, -0.088);
  assert.equal(nodes.headPitch.rotation.x, nodes.headCameraPitch.rotation.x);
  assert.equal(nodes.headFreeLook.rotation.y, 0);
});

test('steady mouse movement keeps Mammoth sensitivity without delaying input', () => {
  const look = angles();
  const inertia = createFpLookInertiaState();
  for (let frame = 0; frame < 120; frame++) {
    stepFpLookInertia(inertia, look, -14, 0, DT, { freeLook: false });
  }
  close(look.bodyYaw, 120 * 14 * MOUSE_SENS);
});

test('vertical view clamps near 88 degrees without clamping horizontal turns', () => {
  const look = angles();
  const inertia = createFpLookInertiaState();
  stepFpLookInertia(inertia, look, -10_000, -10_000, 0, { freeLook: false });
  close(look.bodyYaw, 22);
  assert.equal(look.pitch, PITCH_LIMIT);
  stepFpLookInertia(inertia, look, 0, 0, DT, { freeLook: false });
  assert.equal(inertia.velPitch, 0);
  stepFpLookInertia(inertia, look, 0, 10_000, 0, { freeLook: false });
  assert.equal(look.pitch, -PITCH_LIMIT);
  stepFpLookInertia(inertia, look, 0, 0, DT, { freeLook: false });
  assert.equal(inertia.velPitch, 0);
});

test('Mammoth post-flick coast decays and input reset stops it', () => {
  const look = angles();
  const inertia = createFpLookInertiaState();
  stepFpLookInertia(inertia, look, -120, 0, 0, { freeLook: false });
  const initialYaw = look.bodyYaw;
  const expectedCoast = 120 * MOUSE_SENS * LOOK_INERTIA_COAST_GAIN;
  stepFpLookInertia(inertia, look, 0, 0, DT, { freeLook: false });
  close(look.bodyYaw, initialYaw + expectedCoast);
  close(inertia.velYaw, expectedCoast * Math.exp(-LOOK_INERTIA_DAMP_PER_S * DT));
  const pausedYaw = look.bodyYaw;
  resetFpLookInertia(inertia);
  for (let frame = 0; frame < 60; frame++) {
    stepFpLookInertia(inertia, look, 0, 0, DT, { freeLook: false });
  }
  assert.equal(look.bodyYaw, pausedYaw);
  assert.deepEqual(inertia, { velYaw: 0, velPitch: 0 });
});

test('Alt free-look moves the head while keeping the walking heading fixed', () => {
  const look = { ...angles(), bodyYaw: 0.5 };
  const inertia = createFpLookInertiaState();
  stepFpLookInertia(inertia, look, -40, 20, 0, { freeLook: true });
  assert.equal(look.bodyYaw, 0.5);
  close(look.headLookYaw, 0.088);
  close(look.pitch, -0.044);
  stepFpLookInertia(inertia, look, -10_000, 0, 0, { freeLook: true });
  assert.equal(look.headLookYaw, FREE_LOOK_YAW_MAX);
  stepFpLookInertia(inertia, look, 0, 0, DT, { freeLook: true });
  assert.equal(inertia.velYaw, 0);
  assert.equal(look.bodyYaw, 0.5);
});

test('releasing Alt eases the camera back toward the walking heading', () => {
  const look = { ...angles(), bodyYaw: 0.4, headLookYaw: 1.1 };
  assert.equal(stepFpFreeLookRecenter(look, DT), true);
  close(look.headLookYaw, 1.1 * Math.exp(-FREE_LOOK_RECENTER_RATE_PER_S * DT));
  assert.equal(look.bodyYaw, 0.4);
  for (let frame = 0; frame < 240; frame++) {
    if (!stepFpFreeLookRecenter(look, DT)) break;
  }
  assert.equal(look.headLookYaw, 0);
  assert.equal(look.bodyYaw, 0.4);
});

test('Alt camera yaw remains ahead of pitch in the first-person rig', () => {
  const look = { bodyYaw: 0.4, pitch: 0.7, headLookYaw: 0.6 };
  const nodes = {
    playerRig: { rotation: { y: 0 } },
    headPitch: { rotation: { x: 0 } },
    headCameraPitch: { rotation: { x: 0 } },
    headFreeLook: { rotation: { y: 0 } },
  };
  applyFpRigLookRotations(nodes, look, true);
  assert.equal(nodes.playerRig.rotation.y, 0.4);
  assert.equal(nodes.headFreeLook.rotation.y, 0.6);
  assert.equal(nodes.headCameraPitch.rotation.x, 0.7);
  assert.equal(nodes.headPitch.rotation.x, 0);
});
