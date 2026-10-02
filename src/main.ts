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
    <div class="controls"><div><kbd>W A S D</kbd> move <kbd>Shift</kbd> sprint <kbd>Space</kbd> jump</div><div><kbd>C</kbd> crouch <kbd>Alt</kbd> free look <kbd>V</kbd> camera</div><div><kbd>Click</kbd> buttons <kbd>E</kbd> door / call <kbd>R</kbd> respawn</div></div></div>
    <div class="debug" id="debug"></div>
    <div class="overlay" id="overlay"><div class="card"><div class="eyebrow">Persistent multiplayer example</div><h2>Going<br>somewhere?</h2><p>Share a ride, pick any floor, and step out into the sky. Open a second tab to bring another player along.</p><button id="play" disabled>Connecting…</button><div class="note" id="note">WASD to walk · Click to look around · Escape to release your mouse<br>Anonymous guests. No account or sign-in.</div><div class="error" id="error"></div></div></div>
  </div>`;

const ui = Object.fromEntries(['connection','backend','prompt','floor','phase','queue','debug','overlay','play','note','error'].map(id => [id, document.getElementById(id)!]));
const params = new URLSearchParams(location.search);
const debugMode = params.get('debug') === '1';
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, .05, 220);
camera.rotation.order = 'YXZ';
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.get('backend') === 'webgl' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
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
let dragging = false;
let dragged = false;
let previousTime = performance.now();
let simulationTimer = 0;
let displayElevator = initialElevator();
let simulatedElevatorY = displayElevator.y;
const visualOffset = new THREE.Vector3();
const displayed = new THREE.Vector3();
const knownPlayers = new Set<string>();
const remoteDisplay = new Map<string, THREE.Vector3>();
let target: { type: string; floor?: number; open?: boolean } | undefined;
let frameMs = 0;
const renderStats = { drawCalls: 0, triangles: 0 };

function pointerLocked() { return document.pointerLockElement === renderer.domElement; }
function locked() { return pointerLocked() || fallbackActive; }
function pickAction() {
  const hits = raycaster.intersectObjects(scene.children,true);
  for (const hit of hits) {
    let object: THREE.Object3D | null = hit.object;
    let visible = true;
    while (object) {
      if (!object.visible || object.userData.ignorePicking) visible = false;
      object = object.parent;
    }
    if (visible) return hit.object.userData.action as typeof target;
  }
  return undefined;
}
function getInput(): InputState {
  return {
    forward: Number(keys.has('KeyW')) - Number(keys.has('KeyS')),
    right: Number(keys.has('KeyD')) - Number(keys.has('KeyA')),
    yaw, sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'), crouch,
    jumpHeld: keys.has('Space'), jumpSeq, seq: inputSeq,
  };
}

function interact(doorOnly = false) {
  if (!local || !network.ready) return;
  if (target?.type === 'floor' && !doorOnly) network.floor(target.floor!);
  else if (target?.type === 'hail') network.hail(target.floor!);
  else if (target?.type === 'landingDoor') network.landingDoor(target.floor!);
  else if (target?.type === 'door') network.door(target.open!);
  else {
    const floor = Math.round(local.y / FLOOR_HEIGHT) + 1;
    if (nearLanding(local, floor) || insideCab(local, displayElevator)) network.landingDoor(floor);
  }
}

ui.play.addEventListener('click', () => {
  if (!network.local?.online) { network.join(); return; }
  entered = true;
  const request = renderer.domElement.requestPointerLock();
  if (request) request.catch(() => { fallbackActive = true; });
});
document.addEventListener('pointerlockerror', () => { if (entered) fallbackActive = true; });
document.getElementById('pause')!.addEventListener('click', () => {
  fallbackActive = false; keys.clear(); document.exitPointerLock();
});
renderer.domElement.addEventListener('mousedown', () => { dragging = true; dragged = false; });
window.addEventListener('mouseup', () => { dragging = false; });
renderer.domElement.addEventListener('click', event => {
  if (!locked() || dragged) return;
  if (fallbackActive) {
    raycaster.setFromCamera(new THREE.Vector2(event.clientX / innerWidth * 2 - 1, 1 - event.clientY / innerHeight * 2),camera);
    target = pickAction();
  }
  interact();
});
document.addEventListener('pointerlockchange', () => {
  keys.clear();
  if (!locked()) freeYaw = 0;
  network.input({ ...getInput(), forward: 0, right: 0, jumpHeld: false, seq: ++inputSeq });
});
document.addEventListener('mousemove', event => {
  if (!locked()) return;
  if (!pointerLocked() && !dragging) return;
  if (Math.abs(event.movementX) + Math.abs(event.movementY) > 2) dragged = true;
  if (keys.has('AltLeft') || keys.has('AltRight')) freeYaw = THREE.MathUtils.clamp(freeYaw - event.movementX * .0022, -2.35, 2.35);
  else yaw -= event.movementX * .0022;
  pitch = THREE.MathUtils.clamp(pitch - event.movementY * .0022, -1.53, 1.53);
});
document.addEventListener('keydown', event => {
  if (!locked()) return;
  if (event.code === 'Escape' && fallbackActive) { fallbackActive = false; keys.clear(); return; }
  if (['Space','AltLeft','AltRight','Tab'].includes(event.code)) event.preventDefault();
  keys.add(event.code);
  if (event.repeat) return;
  if (event.code === 'Space') jumpSeq++;
  if (event.code === 'KeyC') crouch = !crouch;
  if (event.code === 'KeyV') thirdPerson = !thirdPerson;
  if (event.code === 'KeyE') interact(true);
  if (event.code === 'KeyR') network.respawn();
  network.input({ ...getInput(), seq: ++inputSeq });
});
document.addEventListener('keyup', event => {
  keys.delete(event.code);
  if (locked()) network.input({ ...getInput(), seq: ++inputSeq });
});
window.addEventListener('blur', () => {
  keys.clear();
  network.input({ ...getInput(), seq: ++inputSeq });
});
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
  ui.note.textContent = network.ready ? row?.online ? 'Open another tab for player two. E opens the landing gate when docked. Escape releases your mouse.' : 'Both player slots are occupied. You can join when someone leaves.' : 'Start the database with npm run db:start, then npm run db:publish. The client reconnects automatically.';
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
      const offset = new THREE.Vector3(0,.4,2.5).applyEuler(new THREE.Euler(0,yaw+freeYaw,0));
      camera.position.add(offset);
      if (local.inCab) {
        camera.position.x = THREE.MathUtils.clamp(camera.position.x,-CAB_HALF+.15,CAB_HALF-.15);
        camera.position.z = THREE.MathUtils.clamp(camera.position.z,-CAB_HALF+.15,CAB_HALF-.15);
        camera.position.y = Math.min(camera.position.y,displayElevator.y+CAB_HEIGHT-.15);
      }
      camera.lookAt(displayed.x,displayed.y+eye,displayed.z);
    }
  } else {
    if (params.get('view') === 'far') { camera.position.set(35,44,78); camera.lookAt(0,36,0); }
    else { camera.position.set(10, displayElevator.y+6.5,12); camera.lookAt(0,displayElevator.y+1.4,0); }
  }
  camera.updateMatrixWorld();
  raycaster.setFromCamera(pointerCenter,camera);
  raycaster.far = 4;
  target = pickAction();
  ui.prompt.textContent = !locked() ? '' : target?.type === 'floor' ? `Click · Floor ${target.floor}` : target?.type === 'hail' ? `Click / E · Call to floor ${target.floor}` : target?.type === 'landingDoor' ? 'Click / E · Toggle landing gate' : target?.type === 'door' ? `Click · ${target.open ? 'Open' : 'Close'} doors` : '';
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
