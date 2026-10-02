import * as THREE from 'three/webgpu';
import './style.css';
import { createWorld } from './world';
import { Network } from './network';
import {
  CROUCH_EYE_HEIGHT, EYE_HEIGHT, CAB_HALF, CAB_HEIGHT, FLOOR_HEIGHT,
  initialElevator, idleInput, insideCab, nearLanding, stepElevator, stepPlayer,
  type ElevatorState, type InputState, type PlayerState,
} from '../shared/simulation';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="hud">
    <div class="brand"><div class="eyebrow">A shared world / 001</div><h1>Persistent Elevator</h1><p>20 floors. Two players. One elevator.</p></div>
    <div class="status"><div class="status-line"><span class="dot"></span><span id="connection">Connecting…</span></div><span class="backend" id="backend">Initializing renderer</span><button id="pause" hidden>Pause / release mouse</button></div>
    <div class="crosshair"></div><div class="prompt" id="prompt"></div>
    <div class="bottom"><div class="telemetry"><div class="floor-line"><span class="floor-number" id="floor">01</span><div class="floor-state" id="phase">Doors open<br>Ground landing</div></div><div class="queue" id="queue">No stops queued</div></div>
    <div class="controls"><div><kbd>W A S D</kbd> move <kbd>Shift</kbd> sprint <kbd>Space</kbd> jump</div><div><kbd>C</kbd> crouch <kbd>Alt</kbd> free look <kbd>V</kbd> camera</div><div><kbd>E</kbd> interact <kbd>Mouse</kbd> look <kbd>R</kbd> respawn</div></div></div>
    <div class="debug" id="debug"></div>
    <div class="overlay" id="overlay"><div class="card"><div class="eyebrow">Persistent multiplayer example</div><h2>Going<br>somewhere?</h2><p>Share a ride, pick any floor, and step out into the sky. Open a second tab to bring another player along.</p><button id="play" disabled>Connecting…</button><div class="note" id="note">Move the mouse to look · Aim and press E to interact<br>Anonymous guests. No account or sign-in.</div><div class="error" id="error"></div></div></div>
  </div>`;

const ui = Object.fromEntries(['connection','backend','prompt','floor','phase','queue','debug','overlay','play','note','error'].map(id => [id, document.getElementById(id)!]));
const params = new URLSearchParams(location.search);
const debugMode = params.get('debug') === '1';
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, .1, 160);
camera.rotation.order = 'YXZ';
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.get('backend') === 'webgl' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute('aria-label', 'Elevator game. Move the mouse to look and press E to interact.');
document.body.prepend(renderer.domElement);
await renderer.init();
const isWebGPU = () => 'isWebGPUBackend' in renderer.backend && renderer.backend.isWebGPUBackend === true;
ui.backend.textContent = isWebGPU() ? 'Three.js / WebGPU' : 'Three.js / WebGL2 fallback';
const world = createWorld(scene);
world.setDebug(debugMode);
const network = new Network();
network.connect();
const keys = new Set<string>();
const raycaster = new THREE.Raycaster();
const pointerCenter = new THREE.Vector2();
let local: PlayerState | undefined;
let seenRevision = -1;
let inputSeq = 0;
let jumpSeq = 0;
let crouch = false;
let yaw = Math.PI;
let pitch = 0;
let freeYaw = 0;
let thirdPerson = false;
let entered = false;
let fallbackActive = false;
let wantsControl = false;
let captureAttempt = 0;
let mouseInside = true;
let previousMouse: { x: number; y: number } | undefined;
let previousTime = performance.now();
let simulationTimer = 0;
let displayElevator = initialElevator();
let simulatedElevatorY = displayElevator.y;
const visualOffset = new THREE.Vector3();
const displayed = new THREE.Vector3();
const knownPlayers = new Set<string>();
const remoteDisplay = new Map<string, THREE.Vector3>();
let target: { type: string; floor?: number; open?: boolean } | undefined;
let targetObject: THREE.Object3D | undefined;
let frameMs = 0;
const renderStats = { drawCalls: 0, triangles: 0 };

function pointerLocked() { return document.pointerLockElement === renderer.domElement; }
function locked() { return pointerLocked() || fallbackActive; }
function pickAction() {
  targetObject = undefined;
  const hits = raycaster.intersectObjects(scene.children,true);
  for (const hit of hits) {
    let object: THREE.Object3D | null = hit.object;
    let visible = true;
    while (object) {
      if (!object.visible || object.userData.ignorePicking) visible = false;
      object = object.parent;
    }
    if (visible) {
      const action = hit.object.userData.action as typeof target;
      if (action) targetObject = hit.object;
      return action;
    }
  }
  return undefined;
}
function getInput(): InputState {
  return {
    forward: locked() ? Number(keys.has('KeyW')) - Number(keys.has('KeyS')) : 0,
    right: locked() ? Number(keys.has('KeyD')) - Number(keys.has('KeyA')) : 0,
    yaw, sprint: locked() && (keys.has('ShiftLeft') || keys.has('ShiftRight')), crouch,
    jumpHeld: locked() && keys.has('Space'), jumpSeq, seq: inputSeq,
  };
}

function interact() {
  if (!local || !network.ready) return;
  if (target?.type === 'floor') network.floor(target.floor!);
  else if (target?.type === 'hail') network.hail(target.floor!);
  else if (target?.type === 'landingDoor') network.landingDoor(target.floor!);
  else if (target?.type === 'door') network.door(target.open!);
  else {
    const floor = Math.round(local.y / FLOOR_HEIGHT) + 1;
    if (nearLanding(local, floor) || insideCab(local, displayElevator)) network.landingDoor(floor);
  }
}

function captureMouse() {
  if (!network.local?.online) { network.join(); return; }
  entered = true;
  wantsControl = true;
  const attempt = ++captureAttempt;
  previousMouse = undefined;
  mouseInside = true;
  // Some embedded browsers reject pointer lock. Their mouse still controls look
  // directly; no mouse button has to be held down.
  try {
    window.focus();
    renderer.domElement.focus({ preventScroll:true });
    const request = renderer.domElement.requestPointerLock();
    if (request) request.catch(() => {
      if (wantsControl && attempt === captureAttempt && !pointerLocked()) fallbackActive = true;
    });
  } catch { if (wantsControl && attempt === captureAttempt) fallbackActive = true; }
}
function pause(releasePointer = true) {
  wantsControl = false;
  captureAttempt++;
  fallbackActive = false;
  keys.clear();
  previousMouse = undefined;
  freeYaw = 0;
  if (releasePointer && pointerLocked()) document.exitPointerLock();
  network.input({ ...getInput(), seq: ++inputSeq });
}
ui.play.addEventListener('click', captureMouse);
document.addEventListener('pointerlockerror', () => {
  if (wantsControl && !pointerLocked()) { fallbackActive = true; previousMouse = undefined; }
});
document.getElementById('pause')!.addEventListener('click', () => {
  pause();
});
renderer.domElement.addEventListener('click', () => {
  if (!locked()) captureMouse();
});
renderer.domElement.addEventListener('mouseenter', () => { mouseInside = true; previousMouse = undefined; });
renderer.domElement.addEventListener('mouseleave', () => {
  mouseInside = false;
  previousMouse = undefined;
  if (!pointerLocked() && fallbackActive) pause();
});
document.addEventListener('pointerlockchange', () => {
  // A request may finish after Escape or focus loss. Never resume that request.
  if (pointerLocked() && !wantsControl) { pause(); return; }
  keys.clear();
  if (pointerLocked()) { fallbackActive = false; wantsControl = true; }
  else pause(false);
  previousMouse = undefined;
  if (!locked()) freeYaw = 0;
  network.input({ ...getInput(), forward: 0, right: 0, jumpHeld: false, seq: ++inputSeq });
});
document.addEventListener('mousemove', event => {
  if (!locked()) return;
  if (!pointerLocked() && !mouseInside) return;
  let dx = event.movementX;
  let dy = event.movementY;
  if (!pointerLocked()) {
    // Client coordinates are reliable even in browsers that report zero movementX.
    if (!previousMouse) { previousMouse = { x:event.clientX, y:event.clientY }; return; }
    dx = event.clientX - previousMouse.x;
    dy = event.clientY - previousMouse.y;
    previousMouse = { x:event.clientX, y:event.clientY };
  }
  if (keys.has('AltLeft') || keys.has('AltRight')) freeYaw = THREE.MathUtils.clamp(freeYaw - dx * .0022, -2.35, 2.35);
  else yaw -= dx * .0022;
  pitch = THREE.MathUtils.clamp(pitch - dy * .0022, -1.53, 1.53);
});
document.addEventListener('keydown', event => {
  if (event.code === 'Escape' && locked()) { pause(); return; }
  if (!locked()) return;
  if (['Space','AltLeft','AltRight','Tab','KeyE'].includes(event.code)) event.preventDefault();
  keys.add(event.code);
  if (event.repeat) return;
  if (event.code === 'Space') jumpSeq++;
  if (event.code === 'KeyC') crouch = !crouch;
  if (event.code === 'KeyV') thirdPerson = !thirdPerson;
  if (event.code === 'KeyE') interact();
  if (event.code === 'KeyR') network.respawn();
  network.input({ ...getInput(), seq: ++inputSeq });
});
document.addEventListener('keyup', event => {
  keys.delete(event.code);
  if (locked()) network.input({ ...getInput(), seq: ++inputSeq });
});
window.addEventListener('blur', () => pause());
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
const heartbeat = setInterval(() => {
  if (network.local?.online) network.input({ ...getInput(), seq: ++inputSeq });
}, 100);
window.addEventListener('pagehide', () => { clearInterval(heartbeat); network.close(); });

function evaluateElevator(now: number): ElevatorState {
  const state = structuredClone(network.elevator ?? initialElevator());
  // Extrapolation is bounded: long outages cannot invent unconfirmed arrivals.
  let elapsed = Math.min(.15, Math.max(0, (now - network.elevatorReceivedAt) / 1000));
  while (elapsed > .00001) { const dt = Math.min(.05, elapsed); stepElevator(state, dt); elapsed -= dt; }
  return state;
}

function updateHud() {
  const row = network.local;
  ui.connection.textContent = network.ready ? `${network.count} / 2 players · live` : network.status;
  document.querySelector('.dot')!.classList.toggle('online', network.ready);
  ui.floor.textContent = String(displayElevator.currentFloor).padStart(2,'0');
  ui.phase.innerHTML = `${displayElevator.phase === 'moving' ? `To floor ${displayElevator.targetFloor}` : displayElevator.phase === 'idle' ? 'At landing' : `${displayElevator.phase} doors`}<br>${Math.round(displayElevator.y)} m above floor 01`;
  ui.queue.textContent = displayElevator.queue.length ? `Next stops: ${displayElevator.queue.map(f => String(f).padStart(2,'0')).join(' → ')}` : 'No stops queued';
  ui.overlay.classList.toggle('hidden', locked() || params.get('inspect') === '1');
  document.getElementById('pause')!.hidden = !fallbackActive;
  const button = ui.play as HTMLButtonElement;
  button.disabled = !network.ready;
  button.textContent = !network.ready ? 'Connecting…' : !row?.online ? 'Try joining — 2 player limit' : entered ? 'Resume ride →' : `Enter as player ${row.slot + 1} →`;
  ui.error.textContent = network.error;
  ui.note.textContent = network.ready ? row?.online ? 'Move the mouse freely. Aim at any button or door and press E. Escape pauses. Open another tab for player two.' : 'Both player slots are occupied. You can join when someone leaves.' : 'Start the database with npm run db:start, then npm run db:publish. The client reconnects automatically.';
  if (debugMode) ui.debug.textContent = `CPU frame: ${frameMs.toFixed(1)} ms\nDraw calls: ${renderStats.drawCalls}\nTriangles: ${renderStats.triangles}\nCab y: ${displayElevator.y.toFixed(3)}\nPlayer y: ${local?.y.toFixed(3) ?? '—'}\nGPU timing: not measured\nNo postprocessing / fixed scene`;
}

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(.05, (now - previousTime) / 1000);
  previousTime = now;
  const frameStart = now;
  displayElevator = evaluateElevator(now);
  if (network.revision !== seenRevision) {
    seenRevision = network.revision;
    const row = network.local;
    if (row?.online) {
      const old = local ? new THREE.Vector3(local.x, local.y, local.z) : undefined;
      const newPlayer = !local;
      local = { ...row };
      if ((local.inCab || local.onRoof) && network.elevator) local.y += displayElevator.y - network.elevator.y;
      if (newPlayer) { yaw = params.get('view') === 'panel' ? 0 : row.yaw; crouch = row.crouch; jumpSeq = row.jumpSeq; inputSeq = row.seq; }
      inputSeq = Math.max(inputSeq, row.seq);
      jumpSeq = Math.max(jumpSeq, row.jumpSeq);
      if (old && old.distanceTo(new THREE.Vector3(local.x, local.y, local.z)) < 2) {
        visualOffset.add(old.sub(new THREE.Vector3(local.x, local.y, local.z)));
        // Riders and cabin are always rendered in the same vertical frame.
        if (local.inCab || local.onRoof) visualOffset.y = 0;
      } else visualOffset.set(0,0,0);
      simulatedElevatorY = displayElevator.y;
    } else local = undefined;
  }
  if (local && network.ready) {
    simulationTimer += dt;
    const h = 1 / 60;
    while (simulationTimer >= h) {
      stepPlayer(local, getInput(), displayElevator, simulatedElevatorY, h);
      simulatedElevatorY = displayElevator.y;
      simulationTimer -= h;
    }
    visualOffset.multiplyScalar(Math.exp(-12 * dt));
    displayed.set(local.x,local.y,local.z).add(visualOffset);
  }
  if (!keys.has('AltLeft') && !keys.has('AltRight')) freeYaw *= Math.exp(-3.5 * dt);
  world.updateElevator(displayElevator);
  for (const [id, row] of network.players) {
    if (!row.online) continue;
    knownPlayers.add(id);
    let position: THREE.Vector3;
    if (id === network.identity && local) position = displayed;
    else {
      const targetPosition = new THREE.Vector3(row.x, row.y, row.z);
      if ((row.inCab || row.onRoof) && network.elevator) targetPosition.y += displayElevator.y - network.elevator.y;
      position = remoteDisplay.get(id) ?? targetPosition.clone();
      if (position.distanceTo(targetPosition) > 3) position.copy(targetPosition);
      else position.lerp(targetPosition, 1 - Math.exp(-18 * dt));
      if (row.inCab || row.onRoof) position.y = targetPosition.y;
      remoteDisplay.set(id,position);
    }
    world.updatePlayer(id, { ...row, x:position.x,y:position.y,z:position.z }, id !== network.identity || thirdPerson || !entered, id === network.identity);
  }
  for (const id of knownPlayers) {
    if (!network.players.get(id)?.online) { world.removePlayer(id); remoteDisplay.delete(id); knownPlayers.delete(id); }
  }
  if (entered && local) {
    const eye = local.crouch ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;
    camera.position.copy(displayed).add(new THREE.Vector3(0,eye,0));
    camera.rotation.set(pitch,yaw + freeYaw,0,'YXZ');
    if (thirdPerson) {
      const offset = new THREE.Vector3(0,0,2.5).applyEuler(new THREE.Euler(pitch,yaw+freeYaw,0,'YXZ')).add(new THREE.Vector3(0,.4,0));
      camera.position.add(offset);
      if (local.inCab) {
        // Keep the lens in front of the rear controls and clear of wall trim.
        camera.position.x = THREE.MathUtils.clamp(camera.position.x,-CAB_HALF+.42,CAB_HALF-.42);
        camera.position.z = THREE.MathUtils.clamp(camera.position.z,-CAB_HALF+.42,CAB_HALF-.42);
        camera.position.y = THREE.MathUtils.clamp(camera.position.y,displayElevator.y+.25,displayElevator.y+CAB_HEIGHT-.15);
      }
      camera.lookAt(displayed.x,displayed.y+eye,displayed.z);
    }
  } else {
    if (params.get('view') === 'far') { camera.position.set(35,44,78); camera.lookAt(0,36,0); }
    else { camera.position.set(10, displayElevator.y+6.5,12); camera.lookAt(0,displayElevator.y+1.4,0); }
  }
  camera.updateMatrixWorld();
  world.updateView(camera.position);
  raycaster.setFromCamera(pointerCenter,camera);
  raycaster.far = 4;
  target = pickAction();
  world.setInteractionTarget(locked() ? targetObject : undefined);
  document.querySelector('.crosshair')!.classList.toggle('active', locked() && !!target);
  ui.prompt.textContent = !locked() ? '' : target?.type === 'floor' ? `E · Select floor ${target.floor}` : target?.type === 'hail' ? `E · Call to floor ${target.floor}` : target?.type === 'landingDoor' ? 'E · Toggle landing gate' : target?.type === 'door' ? `E · ${target.open ? 'Open' : 'Close'} doors` : '';
  updateHud();
  renderer.render(scene,camera);
  renderStats.drawCalls = renderer.info.render.drawCalls;
  renderStats.triangles = renderer.info.render.triangles;
  frameMs = performance.now() - frameStart;
});

// A read-only inspection surface for deterministic visual and multiplayer QA.
Object.defineProperty(window, '__elevator', { value: {
  snapshot: () => ({ backend: isWebGPU() ? 'webgpu' : 'webgl2',
    players: [...network.players.values()].map(({ identity, ...p }) => ({ ...p, id:identity.toHexString() })),
    local: local ? { ...local } : null, elevator: { ...displayElevator, sampleMicros: String(displayElevator.sampleMicros) },
    connected: network.ready, frameMs, drawCalls:renderStats.drawCalls, triangles:renderStats.triangles }),
} });
