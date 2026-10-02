import test from 'node:test';
import assert from 'node:assert/strict';
import { PointerCapture } from '../src/pointer-capture';

function fixture(request: () => Promise<void> | void = () => Promise.resolve()) {
  const doc = new EventTarget() as EventTarget & { pointerLockElement: unknown; exitPointerLock: () => void };
  doc.pointerLockElement = null;
  let releases = 0;
  doc.exitPointerLock = () => { releases++; doc.pointerLockElement = null; };
  const canvas = { ownerDocument: doc, focus() {}, requestPointerLock: request };
  const changes: boolean[] = [];
  const capture = new PointerCapture(canvas as unknown as HTMLCanvasElement, value => changes.push(value));
  return { doc, canvas, capture, changes, get releases() { return releases; } };
}

test('gameplay starts only after actual canvas pointer lock, never at request time', () => {
  const f = fixture();
  f.capture.request();
  assert.equal(f.capture.locked, false);
  assert.equal(f.capture.pending, true);
  assert.deepEqual(f.changes, []);
  f.doc.pointerLockElement = f.canvas;
  f.doc.dispatchEvent(new Event('pointerlockchange'));
  assert.equal(f.capture.locked, true);
  assert.deepEqual(f.changes, [true]);
});

test('capture failure stays paused and tells the player how to get continuous rotation', async () => {
  const f = fixture(() => Promise.reject(new Error('WrongDocumentError')));
  f.capture.request();
  await Promise.resolve();
  assert.equal(f.capture.locked, false);
  assert.equal(f.capture.pending, false);
  assert.match(f.capture.error, /desktop browser/);
  assert.deepEqual(f.changes, [false]);
});

test('a late native capture after Escape is released instead of resuming gameplay', () => {
  const f = fixture();
  f.capture.request();
  f.capture.release();
  f.doc.pointerLockElement = f.canvas;
  f.doc.dispatchEvent(new Event('pointerlockchange'));
  assert.equal(f.releases, 1);
  assert.equal(f.capture.locked, false);
  assert.ok(f.changes.every(locked => !locked));
});

test('a rejected old request cannot cancel a newer successful capture', async () => {
  let rejectOld!: (reason: unknown) => void;
  const old = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
  let count = 0;
  const f = fixture(() => count++ === 0 ? old : Promise.resolve());
  f.capture.request();
  f.capture.release();
  f.capture.request();
  f.doc.pointerLockElement = f.canvas;
  f.doc.dispatchEvent(new Event('pointerlockchange'));
  rejectOld(new Error('old failure'));
  await Promise.resolve();
  assert.equal(f.capture.locked, true);
  assert.equal(f.capture.error, '');
});

test('Escape disables gameplay immediately while native release is asynchronous', () => {
  const f = fixture();
  f.capture.request();
  f.doc.pointerLockElement = f.canvas;
  f.doc.dispatchEvent(new Event('pointerlockchange'));
  let releaseRequested = false;
  f.doc.exitPointerLock = () => { releaseRequested = true; };
  f.capture.release();
  assert.equal(releaseRequested, true);
  assert.equal(f.doc.pointerLockElement, f.canvas);
  assert.equal(f.capture.locked, false);
  assert.equal(f.changes.at(-1), false);
  f.doc.pointerLockElement = null;
  f.doc.dispatchEvent(new Event('pointerlockchange'));
  assert.equal(f.capture.locked, false);
});

test('a synchronous focus failure clears the pending request and remains paused', () => {
  const f = fixture();
  f.canvas.focus = () => { throw new Error('detached canvas'); };
  f.capture.request();
  assert.equal(f.capture.pending, false);
  assert.equal(f.capture.locked, false);
  assert.match(f.capture.error, /desktop browser/);
});
