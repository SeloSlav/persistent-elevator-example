import * as THREE from 'three/webgpu';
import './style.css';
import { createWorld } from './world';
import { Network } from './network';
import { PointerCapture } from './pointer-capture';
import { createFpLookInertiaState, resetFpLookInertia, stepFpLookInertia, stepFpFreeLookRecenter } from './fp-look';
import { ElevatorMotion, riderDisplayY, riderFrameHandoffY } from './motion';
import { floorIndicator } from './floor-indicator';
import {
  CROUCH_EYE_HEIGHT, EYE_HEIGHT, GROUND_Y, floorLabel,
  initialElevator, insideCab, stepElevator, stepPlayer,
  type ElevatorState, type InputState, type PlayerState,
} from '../shared/simulation';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="hud">
    <div class="brand"><div class="eyebrow">A shared world / 001</div><h1>Persistent Elevator</h1><p>Ground + 20 floors. Two players. One elevator.</p></div>
    <div class="status"><div class="status-line"><span class="dot"></span><span id="connection">Connecting…</span></div><span class="backend" id="backend">Initializing renderer</span></div>
    <div class="crosshair"></div><div class="prompt" id="prompt"></div>
    <div class="bottom"><div class="telemetry"><div class="floor-line"><span class="floor-number" id="floor">01</span><span class="travel-direction" id="direction"></span><div class="floor-state" id="phase">Doors open<br>Floor 1</div></div><div class="queue" id="queue">No stops queued</div></div>
    <div class="controls"><div><kbd>W A S D</kbd> move <kbd>Shift</kbd> sprint <kbd>Space</kbd> jump</div><div><kbd>C</kbd> crouch <kbd>Alt</kbd> free look <kbd>R</kbd> respawn</div><div><kbd>Click / E</kbd> interact <kbd>Mouse</kbd> look <kbd>Esc</kbd> pause</div></div></div>
    <div class="debug" id="debug"></div>
    <div class="overlay" id="overlay"><div class="card"><div class="eyebrow">Persistent multiplayer example</div><h2>Going<br>somewhere?</h2><p>Share a ride, pick any floor, and step out into the sky. Open a second tab to bring another player along.</p><button id="play" disabled>Connecting…</button><div class="note" id="note">Enter to capture the mouse · Click or E to interact<br>Anonymous guests. No account or sign-in.</div><div class="error" id="error"></div><div id="browser-help" hidden><a id="open-browser">Open in Edge ↗</a><button id="copy-url">Copy game URL</button></div></div></div>
  </div>`;

const ui = Object.fromEntries(['connection','backend','prompt','floor','direction','phase','queue','debug','overlay','play','note','error','browser-help'].map(id => [id, document.getElementById(id)!]));
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
renderer.shadowMap.enabled = params.get('shadows') !== '0';
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute('aria-label', 'Elevator game. Capture the mouse to look, then click or press E to interact.');
document.body.prepend(renderer.domElement);
await renderer.init();
const isWebGPU = () => 'isWebGPUBackend' in renderer.backend && renderer.backend.isWebGPUBackend === true;
ui.backend.textContent = isWebGPU() ? 'Three.js / WebGPU' : 'Three.js / WebGL2 fallback';
const world = createWorld(scene);
world.setDebug(debugMode);
if (params.get('surface') === 'height' || params.get('surface') === 'roughness') {
  world.setMaterialDebug(params.get('surface') as 'height' | 'roughness');
}
const network = new Network(params.get('inspect') === '1');
network.connect();
const keys = new Set<string>();
const raycaster = new THREE.Raycaster();
const pointerCenter = new THREE.Vector2();
let local: PlayerState | undefined;
let seenRevision = -1;
let inputSeq = 0;
let jumpSeq = 0;
let crouch = false;
const look = { bodyYaw: Math.PI, pitch: 0, headLookYaw: 0 };
const lookInertia = createFpLookInertiaState();
let entered = false;
let lastInputSentAt = 0;
let lastInputYaw = look.bodyYaw;
let previousTime = performance.now();
let simulationTimer = 0;
let displayElevator = initialElevator();
let simulationElevator = initialElevator();
const elevatorMotion = new ElevatorMotion();
let simulatedElevatorY = displayElevator.y;
const visualOffset = new THREE.Vector3();
const displayed = new THREE.Vector3();
const knownPlayers = new Set<string>();
const remoteDisplay = new Map<string, THREE.Vector3>();
let target: { type: string; floor?: number; open?: boolean } | undefined;
let targetObject: THREE.Object3D | undefined;
let frameMs = 0;
const renderStats = { drawCalls: 0, triangles: 0 };

const capture = new PointerCapture(renderer.domElement, active => {
  if (active) entered = true;
  else {
    // Mammoth preserves the viewed heading when Alt/focus/capture ends.
    look.bodyYaw += look.headLookYaw;
    look.headLookYaw = 0;
    resetFpLookInertia(lookInertia);
    keys.clear();
  }
  sendInput();
});
function locked() { return capture.locked; }
function freeLook() { return keys.has('AltLeft') || keys.has('AltRight'); }
function applyCameraLook() {
  camera.rotation.set(look.pitch, look.bodyYaw + look.headLookYaw, 0, 'YXZ');
  camera.updateMatrixWorld(true);
}
function sendInput() {
  lastInputSentAt = performance.now();
  lastInputYaw = look.bodyYaw;
  network.input({ ...getInput(), seq: ++inputSeq });
}
function pickAction(objects: THREE.Object3D[] = scene.children) {
  targetObject = undefined;
  const hits = raycaster.intersectObjects(objects,true);
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
    yaw: look.bodyYaw, sprint: locked() && (keys.has('ShiftLeft') || keys.has('ShiftRight')), crouch,
    jumpHeld: locked() && keys.has('Space'), jumpSeq, seq: inputSeq,
  };
}

function interact() {
  if (!local || !network.ready) return;
  // Mouse updates the rig between frames. Pick the current view, not an old ray.
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  raycaster.setFromCamera(pointerCenter,camera);
  raycaster.far = 4;
  target = pickAction();
  if (target?.type === 'floor') network.floor(target.floor!);
  else if (target?.type === 'hail') network.hail(target.floor!);
  else if (target?.type === 'landingDoor') network.landingDoor(target.floor!);
  else if (target?.type === 'door') network.door(target.open!);
}

function captureMouse() {
  if (!network.local?.online) { network.join(); return; }
  window.focus();
  capture.request();
}
ui.play.addEventListener('click', captureMouse);
renderer.domElement.addEventListener('click', () => {
  if (!locked()) captureMouse();
});
// As in Mammoth, acquisition click captures; only a subsequent locked press acts.
renderer.domElement.addEventListener('pointerdown', event => {
  if (event.button === 0 && locked()) interact();
});
renderer.domElement.addEventListener('contextmenu', event => event.preventDefault());
window.addEventListener('mousemove', event => {
  if (!locked()) return;
  if (!event.movementX && !event.movementY) return;
  stepFpLookInertia(lookInertia,look,event.movementX,event.movementY,0,{freeLook:freeLook()});
  applyCameraLook();
  if (Math.abs(look.bodyYaw-lastInputYaw) >= .02 && performance.now()-lastInputSentAt >= 20) sendInput();
});
window.addEventListener('keydown', event => {
  if (event.code === 'Escape' && locked()) { capture.release(); return; }
  if (!locked()) return;
  if (['Space','AltLeft','AltRight','Tab','KeyE'].includes(event.code)) event.preventDefault();
  keys.add(event.code);
  if (event.repeat) return;
  if (event.code === 'Space') jumpSeq++;
  if (event.code === 'KeyC') crouch = !crouch;
  if (event.code === 'KeyE') interact();
  if (event.code === 'KeyR') network.respawn();
  sendInput();
});
window.addEventListener('keyup', event => {
  keys.delete(event.code);
  if (event.code === 'AltLeft' || event.code === 'AltRight') resetFpLookInertia(lookInertia);
  if (locked()) sendInput();
});
window.addEventListener('blur', () => capture.release());
document.addEventListener('visibilitychange', () => { if (document.hidden) capture.release(); });
const browserLink = document.getElementById('open-browser') as HTMLAnchorElement;
browserLink.href = `microsoft-edge:${location.href}`;
browserLink.hidden = !navigator.userAgent.includes('Windows');
document.getElementById('copy-url')!.addEventListener('click', () => {
  void navigator.clipboard.writeText(location.href).then(() => {
    document.getElementById('copy-url')!.textContent = 'URL copied';
  }).catch(() => { ui.error.textContent = `Open ${location.href} in a desktop browser.`; });
});
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
const heartbeat = setInterval(() => {
  if (network.local?.online) sendInput();
}, 50);
window.addEventListener('pagehide', () => { clearInterval(heartbeat); capture.dispose(); network.close(); });

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
  const indication = floorIndicator(displayElevator);
  ui.floor.textContent = indication.floor === 0 ? 'G' : indication.label.padStart(2,'0');
  ui.direction.textContent = indication.direction === 'up' ? '↑' : indication.direction === 'down' ? '↓' : '';
  const destination = displayElevator.targetFloor === 0 ? 'ground' : `floor ${displayElevator.targetFloor}`;
  ui.phase.innerHTML = `${displayElevator.phase === 'moving' ? `To ${destination}` : displayElevator.phase === 'idle' ? indication.floor === 0 ? 'Ground plaza' : 'At landing' : `${displayElevator.phase} doors`}<br>${Math.round(displayElevator.y-GROUND_Y)} m above ground`;
  ui.queue.textContent = displayElevator.queue.length ? `Next stops: ${displayElevator.queue.map(floorLabel).join(' → ')}` : 'No stops queued';
  ui.overlay.classList.toggle('hidden', locked() || params.get('inspect') === '1');
  const button = ui.play as HTMLButtonElement;
  button.disabled = !network.ready || capture.pending;
  button.textContent = capture.pending ? 'Capturing mouse…' : !network.ready ? 'Connecting…' : !row?.online ? 'Try joining — 2 player limit' : entered ? 'Resume ride →' : `Enter as player ${row.slot + 1} →`;
  ui.error.textContent = capture.error || network.error;
  ui['browser-help'].hidden = !capture.error;
  ui.note.textContent = network.ready ? row?.online ? 'The mouse stays captured for continuous look. Aim and click or press E. Escape pauses. Open a second tab for player two.' : 'Both player slots are occupied. You can join when someone leaves.' : 'Start the database with npm run db:start, then npm run db:publish. The client reconnects automatically.';
  if (debugMode) ui.debug.textContent = `CPU frame: ${frameMs.toFixed(1)} ms\nDraw calls: ${renderStats.drawCalls}\nTriangles: ${renderStats.triangles}\nCab y: ${displayElevator.y.toFixed(3)}\nPlayer y: ${local?.y.toFixed(3) ?? '—'}\nCamera / cab: ${(camera.position.y-displayElevator.y).toFixed(6)} m\nFeet / cab: ${local ? (displayed.y-displayElevator.y).toFixed(6) : '—'} m\nGPU timing: not measured\nNo postprocessing / fixed scene`;
}

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(.05, (now - previousTime) / 1000);
  previousTime = now;
  const frameStart = now;
  const previousDisplayY = displayElevator.y;
  simulationElevator = evaluateElevator(now);
  displayElevator = elevatorMotion.update(network.elevator,network.elevatorReceivedAt,now);
  if (locked()) {
    stepFpLookInertia(lookInertia,look,0,0,dt,{freeLook:freeLook()});
    if (!freeLook()) stepFpFreeLookRecenter(look,dt);
  }
  if (network.revision !== seenRevision) {
    seenRevision = network.revision;
    const row = network.local;
    if (row?.online) {
      const old = local ? new THREE.Vector3(local.x, local.y, local.z) : undefined;
      const oldSupport = local ? { inCab: local.inCab, onRoof: local.onRoof } : undefined;
      const oldOnCab = oldSupport?.inCab || oldSupport?.onRoof;
      const oldCabY = simulatedElevatorY;
      const newPlayer = !local;
      local = { ...row };
      if ((local.inCab || local.onRoof) && network.elevator) local.y += simulationElevator.y - network.elevator.y;
      if (newPlayer) { look.bodyYaw = row.yaw; crouch = row.crouch; jumpSeq = row.jumpSeq; inputSeq = row.seq; }
      inputSeq = Math.max(inputSeq, row.seq);
      jumpSeq = Math.max(jumpSeq, row.jumpSeq);
      if (old && old.distanceTo(new THREE.Vector3(local.x, local.y, local.z)) < 2) {
        const correction = old.sub(new THREE.Vector3(local.x,local.y,local.z));
        if (oldOnCab && (local.inCab || local.onRoof)) correction.y += simulationElevator.y-oldCabY;
        if (oldSupport) correction.y += riderFrameHandoffY(oldSupport,local,oldCabY,simulationElevator.y,displayElevator.y);
        visualOffset.add(correction);
        if (local.grounded && (local.inCab || local.onRoof)) visualOffset.y = 0;
      } else visualOffset.set(0,0,0);
      simulatedElevatorY = simulationElevator.y;
    } else local = undefined;
  }
  if (local && network.ready) {
    simulationTimer += dt;
    const h = 1 / 60;
    while (simulationTimer >= h) {
      const oldSupport = { inCab: local.inCab, onRoof: local.onRoof };
      stepPlayer(local, getInput(), simulationElevator, simulatedElevatorY, h);
      simulatedElevatorY = simulationElevator.y;
      // Carry the presentation frame through a roof exit or airborne reentry.
      // The physics step still owns the actual jump and fall displacement.
      visualOffset.y += riderFrameHandoffY(oldSupport,local,simulationElevator.y,simulationElevator.y,displayElevator.y);
      simulationTimer -= h;
    }
    visualOffset.multiplyScalar(Math.exp(-12 * dt));
    if (local.grounded && (local.inCab || local.onRoof)) visualOffset.y = 0;
    displayed.set(local.x,riderDisplayY(local,{...simulationElevator,y:simulatedElevatorY},displayElevator),local.z).add(visualOffset);
  }
  world.updateElevator(displayElevator);
  for (const [id, row] of network.players) {
    if (!row.online) continue;
    knownPlayers.add(id);
    let position: THREE.Vector3;
    if (id === network.identity && local) position = displayed;
    else {
      const targetPosition = new THREE.Vector3(row.x, row.y, row.z);
      if (network.elevator) targetPosition.y = riderDisplayY(row,network.elevator,displayElevator);
      const previousPosition = remoteDisplay.get(id);
      position = previousPosition ?? targetPosition.clone();
      if (previousPosition && (row.inCab || row.onRoof)) position.y += displayElevator.y-previousDisplayY;
      if (position.distanceTo(targetPosition) > 3) position.copy(targetPosition);
      else position.lerp(targetPosition, 1 - Math.exp(-18 * dt));
      if (row.grounded && (row.inCab || row.onRoof)) position.y = targetPosition.y;
      remoteDisplay.set(id,position);
    }
    world.updatePlayer(id, { ...row, x:position.x,y:position.y,z:position.z,yaw:id===network.identity?look.bodyYaw:row.yaw }, id !== network.identity || !entered, id === network.identity);
  }
  for (const id of knownPlayers) {
    if (!network.players.get(id)?.online) { world.removePlayer(id); remoteDisplay.delete(id); knownPlayers.delete(id); }
  }
  if (entered && local) {
    const eye = local.crouch ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;
    camera.position.copy(displayed).add(new THREE.Vector3(0,eye,0));
    applyCameraLook();
  } else {
    if (params.get('view') === 'far') { camera.position.set(35,44,78); camera.lookAt(0,36,0); }
    else if (params.get('inspect') === '1' && params.get('view') === 'ground') { camera.position.set(5,-1.3,7); camera.lookAt(0,-2.5,1.8); }
    else if (params.get('inspect') === '1' && params.get('view') === 'panel') { camera.position.set(.78,displayElevator.y+1.65,.70); camera.lookAt(1.326,displayElevator.y+1.52,1.765); }
    else if (params.get('inspect') === '1' && params.get('view') === 'doors') { camera.position.set(0,displayElevator.y+1.55,-.8); camera.rotation.set(0,Math.PI,0); }
    else if (params.get('inspect') === '1' && params.get('view') === 'cab') { camera.position.set(-1.2,displayElevator.y+2.05,-1.3); camera.lookAt(.2,displayElevator.y+1.45,1.4); }
    else { camera.position.set(10, displayElevator.y+6.5,12); camera.lookAt(0,displayElevator.y+1.4,0); }
  }
  camera.updateMatrixWorld();
  scene.updateMatrixWorld(true);
  world.updateView(camera.position);
  raycaster.setFromCamera(pointerCenter,camera);
  raycaster.far = 4;
  // Decorative bevels never need triangle raycasts every frame. Validate full
  // scene occlusion only on interaction; these semantic controls drive the HUD.
  target = pickAction(world.interactables);
  if (target?.type === 'floor' && (!local || !insideCab(local,simulationElevator))) target = undefined;
  if (!target) targetObject = undefined;
  world.setInteractionTarget(locked() ? targetObject : undefined);
  document.querySelector('.crosshair')!.classList.toggle('active', locked() && !!target);
  const floorName = target?.floor === 0 ? 'Ground' : `Floor ${target?.floor}`;
  ui.prompt.textContent = !locked() ? '' : target?.type === 'floor' ? `Click / E · ${floorName}` : target?.type === 'hail' ? `Click / E · Call ${floorName.toLowerCase()}` : target?.type === 'landingDoor' ? 'Click / E · Landing gate' : target?.type === 'door' ? `Click / E · ${target.open ? 'Open' : 'Close'} doors` : '';
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
