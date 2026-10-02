import {
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CylinderGeometry,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  LinearFilter,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  RingGeometry,
  Scene,
  SpotLight,
  SRGBColorSpace,
  Vector3,
} from 'three/webgpu';
import { createDuskEnvironment, createSurfaceMaterials, setSurfaceMaterialDebug, type SurfaceDebugMode } from './materials';

export interface ElevatorVisualState {
  y: number;
  door: number;
  currentFloor: number;
  targetFloor: number | null;
  phase: string;
  queue: number[];
  landingOpen?: number[];
  landingDoors?: boolean[];
}

export interface PlayerVisualState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  crouch: boolean | number;
  slot: number;
}

type Action =
  | { type: 'floor'; floor: number }
  | { type: 'hail'; floor: number }
  | { type: 'door'; open: boolean }
  | { type: 'landingDoor'; floor: number };

const FLOORS = 20;
const FLOOR_HEIGHT = 4;
const CAB_HALF = 1.8;
const DOOR_HALF = 0.85;
const DOOR_HEIGHT = 2.6;
const PLATFORM_DEPTH = 6;
const PLAYER_HEIGHT = 1.78;
const CROUCH_HEIGHT = 1.2;

const colors = {
  steel: 0x28343d,
  dark: 0x171d21,
  aluminium: 0x9aa6aa,
  ochre: 0xa66d24,
  cab: 0xc3904b,
  cream: 0xe9dfc1,
  concrete: 0x66717a,
  amber: 0xffb54a,
  queued: 0xdb5749,
};

function material(color: number, roughness = 0.68, metalness = 0.2) {
  return new MeshStandardMaterial({ color, roughness, metalness });
}

/** All dimensions use the same frame as shared/simulation.ts: +z is the exit. */
export function createWorld(scene: Scene) {
  const world = new Group();
  world.name = 'Twenty-floor elevator tower';
  scene.add(world);
  const environment = createDuskEnvironment();
  scene.background = environment.texture;
  scene.backgroundBlurriness = 0.05;
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.6;
  scene.fog = new FogExp2(environment.fog, 0.004);

  const { steel, dark, aluminium, ochre, enamel, cream, concrete, rubber } = createSurfaceMaterials();
  const windowGlass = new MeshStandardMaterial({
    color: 0xa9c4cb,
    transparent: true,
    opacity: 0.24,
    roughness: 0.18,
    metalness: 0.12,
    depthWrite: false,
  });
  const lightPanel = new MeshStandardMaterial({
    color: 0xffe3ae,
    emissive: 0xffd59d,
    emissiveIntensity: 2.3,
    roughness: 0.7,
  });
  const boxGeometry = new BoxGeometry(1, 1, 1);
  const planeGeometry = new PlaneGeometry(1, 1);
  const buttonGeometry = new CylinderGeometry(0.104, 0.104, 0.055, 48);
  buttonGeometry.rotateX(Math.PI / 2);
  const rimGeometry = new CylinderGeometry(0.13, 0.13, 0.052, 48);
  rimGeometry.rotateX(Math.PI / 2);

  function box(parent: Object3D, mat: Material, x: number, y: number, z: number, w: number, h: number, d: number) {
    const mesh = new Mesh(boxGeometry, mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  function textTexture(text: string, options: { width?: number; height?: number; fontSize?: number; color?: string; background?: string } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = options.width ?? 128;
    canvas.height = options.height ?? 128;
    const ctx = canvas.getContext('2d')!;
    if (options.background) {
      ctx.fillStyle = options.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.fillStyle = options.color ?? '#efe5cd';
    ctx.font = `600 ${options.fontSize ?? 64}px "Courier New", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    return texture;
  }

  function label(parent: Object3D, text: string, x: number, y: number, z: number, w: number, h: number, options: Parameters<typeof textTexture>[1] = {}) {
    const mat = new MeshBasicMaterial({ map: textTexture(text, options), transparent: !options?.background, depthWrite: !!options?.background, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const mesh = new Mesh(planeGeometry, mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, 1);
    parent.add(mesh);
    return mesh;
  }

  const interactables: Object3D[] = [];
  function interactive(mesh: Object3D, action: Action) {
    mesh.userData.action = action;
    interactables.push(mesh);
    return mesh;
  }

  // A small, unguarded plaza catches players who jump off a landing.
  box(world, concrete, 0, -4.22, 0, 36, 0.44, 36);
  const gridParts: Array<{ position: Vector3; scale: Vector3; rotation?: number }> = [];
  for (let n = -16; n <= 16; n += 2) {
    gridParts.push({ position: new Vector3(n, -3.99, 0), scale: new Vector3(0.017, 0.006, 34) });
    gridParts.push({ position: new Vector3(0, -3.99, n), scale: new Vector3(34, 0.006, 0.017) });
  }
  batchBoxes(world, gridParts, material(0x828e94, 1, 0));
  box(world, dark, 0, -3.96, -3.05, 4.7, 0.05, 0.8);
  const towerName = label(world, 'PERSISTENT / 20', 0, -3.927, -3.05, 3.7, 0.38, { width: 768, height: 96, fontSize: 55 });
  towerName.rotation.x = -Math.PI / 2;

  // One instanced structural assembly keeps the open tower inexpensive.
  const structure: Array<{ position: Vector3; scale: Vector3; rotation?: number }> = [];
  const top = (FLOORS - 1) * FLOOR_HEIGHT + 3.5;
  for (const x of [-2.08, 2.08]) {
    for (const z of [-2.08, 2.08]) {
      structure.push({ position: new Vector3(x, (top - 4) / 2, z), scale: new Vector3(0.14, top + 4, 0.14) });
    }
  }
  for (let floor = 1; floor <= FLOORS; floor++) {
    const y = (floor - 1) * FLOOR_HEIGHT;
    for (const x of [-2.08, 2.08]) {
      structure.push({ position: new Vector3(x, y - 0.25, 0), scale: new Vector3(0.16, 0.18, 4.32) });
    }
    structure.push({ position: new Vector3(0, y - 0.25, -2.08), scale: new Vector3(4.32, 0.18, 0.16) });
    // Rear X braces read as a steel elevator shaft, without obstructing exits.
    if (floor < FLOORS) {
      const span = 4.16;
      const rise = FLOOR_HEIGHT;
      const length = Math.hypot(span, rise);
      for (const sign of [-1, 1]) {
        structure.push({ position: new Vector3(0, y + rise / 2 - 0.25, -2.08), scale: new Vector3(0.075, length, 0.08), rotation: sign * Math.atan2(span, rise) });
      }
    }
  }
  const shaftStructure = batchBoxes(world, structure, steel);
  shaftStructure.castShadow = true;
  // Two guide rails remain visible through the rear of the open shaft.
  box(world, aluminium, -1.4, (top - 4) / 2, -1.97, 0.06, top + 4, 0.08);
  box(world, aluminium, 1.4, (top - 4) / 2, -1.97, 0.06, top + 4, 0.08);

  const landingPivots: Group[] = [];
  const callLights: MeshStandardMaterial[] = [];
  const callButtons: Mesh[] = [];
  const platformParts: Array<{ position: Vector3; scale: Vector3 }> = [];
  const edgeParts: Array<{ position: Vector3; scale: Vector3 }> = [];
  const fixtureParts: Array<{ position: Vector3; scale: Vector3 }> = [];
  const fixtureLights: Array<{ position: Vector3; scale: Vector3 }> = [];
  const platformBraces: Array<{ position: Vector3; scale: Vector3; rotation?: number }> = [];
  const hazardParts: Array<{ position: Vector3; scale: Vector3 }> = [];
  const hazardCanvas = document.createElement('canvas');
  hazardCanvas.width = 256; hazardCanvas.height = 32;
  const hazardContext = hazardCanvas.getContext('2d')!;
  hazardContext.fillStyle = '#b7a16a'; hazardContext.fillRect(0, 0, 256, 32);
  hazardContext.fillStyle = '#26373b';
  for (let x = -32; x < 288; x += 32) {
    hazardContext.beginPath();
    hazardContext.moveTo(x, 0); hazardContext.lineTo(x + 16, 0);
    hazardContext.lineTo(x + 48, 32); hazardContext.lineTo(x + 32, 32);
    hazardContext.closePath(); hazardContext.fill();
  }
  const hazardMap = new CanvasTexture(hazardCanvas); hazardMap.colorSpace = SRGBColorSpace;
  const hazardMaterial = new MeshStandardMaterial({ map: hazardMap, color: 0xe2d5b0, metalness: 0, roughness: 0.84, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  for (let floor = 1; floor <= FLOORS; floor++) {
    const y = (floor - 1) * FLOOR_HEIGHT;
    platformParts.push({ position: new Vector3(0, y - 0.11, 1.8 + PLATFORM_DEPTH / 2), scale: new Vector3(7.6, 0.22, PLATFORM_DEPTH) });
    // Fascia sits outside and below the slab, so its top never overlays concrete.
    edgeParts.push({ position: new Vector3(0, y - 0.115, 7.824), scale: new Vector3(7.6, 0.16, 0.035) });
    for (const side of [-1, 1]) {
      edgeParts.push({ position: new Vector3(side * 3.824, y - 0.115, 4.8), scale: new Vector3(0.035, 0.16, 6) });
      // Under-slab cantilevers add a structural silhouette without obstructing play.
      platformBraces.push({ position: new Vector3(side * 2.85, y - 0.41, 4.8), scale: new Vector3(0.09, 0.25, 5.8) });
      fixtureParts.push({ position: new Vector3(side * 0.95, y + 2.87, 2.067), scale: new Vector3(0.16, 0.055, 0.08) });
      fixtureLights.push({ position: new Vector3(side * 0.95, y + 2.87, 2.113), scale: new Vector3(0.11, 0.021, 0.012) });
      hazardParts.push({ position: new Vector3(side * 3.47, y + 0.003, 4.8), scale: new Vector3(0.16, 0.004, 5.72) });
    }
    hazardParts.push({ position: new Vector3(0, y + 0.003, 7.49), scale: new Vector3(7.04, 0.004, 0.18) });
    // The gate frame ends at the doorway; the rest of every platform is open.
    box(world, steel, -0.925, y + 1.38, 1.96, 0.15, 2.76, 0.2).castShadow = true;
    box(world, steel, 0.925, y + 1.38, 1.96, 0.15, 2.76, 0.2).castShadow = true;
    box(world, steel, 0, y + 2.69, 1.96, 2, 0.15, 0.2).castShadow = true;

    const pivot = new Group();
    pivot.position.set(-DOOR_HALF, y, 1.97);
    pivot.name = `Landing ${floor} swing door`;
    world.add(pivot);
    landingPivots.push(pivot);
    const action: Action = { type: 'landingDoor', floor };
    // The 19 × 94 cm window is a real aperture in the painted door leaf.
    const leafWidth = DOOR_HALF * 2;
    const windowX = 0.72;
    const windowWidth = 0.19;
    const windowBottom = 1.2;
    const windowTop = windowBottom + 0.94;
    const a = windowX - windowWidth / 2;
    const b = windowX + windowWidth / 2;
    for (const part of [
      box(pivot, ochre, leafWidth / 2, windowBottom / 2, 0, leafWidth, windowBottom, 0.075),
      box(pivot, ochre, leafWidth / 2, (windowTop + DOOR_HEIGHT) / 2, 0, leafWidth, DOOR_HEIGHT - windowTop, 0.075),
      box(pivot, ochre, a / 2, (windowBottom + windowTop) / 2, 0, a, 0.94, 0.075),
      box(pivot, ochre, (b + leafWidth) / 2, (windowBottom + windowTop) / 2, 0, leafWidth - b, 0.94, 0.075),
    ]) { part.castShadow = true; interactive(part, action); }
    const reveal = [
      box(pivot, aluminium, a - 0.011, 1.67, 0.043, 0.022, 0.98, 0.024),
      box(pivot, aluminium, b + 0.011, 1.67, 0.043, 0.022, 0.98, 0.024),
      box(pivot, aluminium, windowX, windowBottom - 0.011, 0.043, 0.23, 0.022, 0.024),
      box(pivot, aluminium, windowX, windowTop + 0.011, 0.043, 0.23, 0.022, 0.024),
      box(pivot, windowGlass, windowX, 1.67, 0.005, windowWidth, 0.94, 0.009),
    ];
    for (const mesh of reveal) interactive(mesh, action);
    box(pivot, dark, windowX, 1.06, 0.047, 0.24, 0.12, 0.012);
    for (const handle of [
      box(pivot, aluminium, 1.38, 1.08, 0.145, 0.035, 0.3, 0.034),
      box(pivot, aluminium, 1.38, 1.22, 0.097, 0.035, 0.026, 0.12),
      box(pivot, aluminium, 1.38, 0.94, 0.097, 0.035, 0.026, 0.12),
    ]) interactive(handle, action);
    // Only floor numbers and the call face emit light.
    box(world, dark, 1.28, y + 1.69, 1.98, 0.36, 0.48, 0.09);
    label(world, String(floor).padStart(2, '0'), 1.28, y + 1.76, 2.038, 0.29, 0.22, { fontSize: 76 });
    const callMat = new MeshStandardMaterial({ color: colors.dark, emissive: colors.amber, emissiveIntensity: 0.025, roughness: 0.5, metalness: 0.3 });
    callLights.push(callMat);
    const call = new Mesh(buttonGeometry, callMat);
    call.scale.setScalar(0.75);
    call.position.set(1.28, y + 1.52, 2.065);
    world.add(call);
    interactive(call, { type: 'hail', floor });
    callButtons.push(call);
    // Larger clean wayfinding is visible across the exposed platform.
    box(world, dark, -1.46, y + 2.17, 1.98, 0.78, 0.57, 0.055);
    label(world, `${String(floor).padStart(2, '0')}`, -1.46, y + 2.2, 2.013, 0.64, 0.39, { fontSize: 86 });
  }
  batchBoxes(world, platformParts, concrete).castShadow = true;
  batchBoxes(world, edgeParts, ochre);
  batchBoxes(world, platformBraces, steel);
  batchBoxes(world, fixtureParts, dark);
  batchBoxes(world, fixtureLights, lightPanel);
  batchBoxes(world, hazardParts, hazardMaterial);

  const cab = new Group();
  cab.name = 'Persistent elevator cab';
  world.add(cab);
  // Subfloor ends 3 cm below the finish; there is one surface at physics y=0.
  box(cab, dark, 0, -0.075, 0, 3.6, 0.09, 3.6).castShadow = true;
  box(cab, rubber, 0, -0.015, -0.015, 3.6, 0.03, 3.57);
  box(cab, enamel, 0, 1.5, -1.86, 3.6, 3, 0.12).castShadow = true;
  box(cab, enamel, -1.86, 1.5, 0, 0.12, 3, 3.6).castShadow = true;
  box(cab, enamel, 1.86, 1.5, 0, 0.12, 3, 3.6).castShadow = true;
  box(cab, dark, 0, 3.06, 0, 3.6, 0.12, 3.6).castShadow = true;
  // Threshold occupies the final 3 cm, meeting the rubber edge at z=1.77.
  box(cab, aluminium, 0, -0.015, 1.785, 1.7, 0.03, 0.03);
  box(cab, dark, 0, 0.13, -1.778, 3.57, 0.2, 0.025);
  for (const side of [-1, 1]) {
    box(cab, dark, side * 1.778, 0.13, 0, 0.025, 0.2, 3.55);
    box(cab, aluminium, side * 1.784, 2.52, 0, 0.014, 0.022, 3.5);
    box(cab, aluminium, side * 1.784, 1.53, -1.71, 0.015, 2.35, 0.04);
  }
  box(cab, aluminium, 0, 2.52, -1.784, 3.52, 0.022, 0.014);
  // The front side pockets leave exactly the collision model's 1.7 m opening.
  for (const side of [-1, 1]) {
    box(cab, ochre, side * (CAB_HALF + DOOR_HALF) / 2, 1.5, 1.86, CAB_HALF - DOOR_HALF, 3, 0.12).castShadow = true;
    box(cab, aluminium, side * 0.884, 1.33, 1.9275, 0.05, 2.66, 0.015);
    box(cab, aluminium, side * 1.688, 1.02, -0.05, 0.055, 0.055, 2.96);
  }
  box(cab, ochre, 0, 2.825, 1.86, 1.7, 0.35, 0.12).castShadow = true;
  for (const x of [-1.23, 1.23]) box(cab, aluminium, x, 1.02, -1.664, 0.89, 0.055, 0.055);
  box(cab, aluminium, 0, 2.653, 1.9275, 1.83, 0.045, 0.015);
  const cabDoorParts: Group[] = [];
  for (const side of [-1, 1]) {
    const door = new Group();
    door.position.x = side * DOOR_HALF / 2;
    cab.add(door);
    cabDoorParts.push(door);
    // Leaves travel behind the pockets, rather than sharing their planar faces.
    box(door, aluminium, 0, 1.31, 1.75, DOOR_HALF - 0.013, 2.62, 0.06).castShadow = true;
    box(door, dark, side * 0.32, 1.32, 1.786, 0.018, 2.55, 0.008);
    // Horizontal pressed-metal seams make door movement readable.
    for (const height of [0.34, 2.31]) box(door, steel, 0, height, 1.786, DOOR_HALF - 0.04, 0.013, 0.008);
  }
  for (const x of [-0.98, 0.98]) {
    box(cab, dark, x, 2.867, 0, 0.67, 0.06, 1.96);
    box(cab, lightPanel, x, 2.828, 0, 0.55, 0.02, 1.78);
  }
  const cabLight = new PointLight(0xffddaf, 12, 5.5, 2);
  cabLight.position.set(0, 2.61, -0.8);
  cab.add(cabLight);
  const cabSpot = new SpotLight(0xffe1b5, 27, 7, 0.98, 0.8, 2);
  cabSpot.position.set(0, 2.73, 0.5);
  cabSpot.target.position.set(0, 0.1, -0.25);
  cabSpot.castShadow = true;
  cabSpot.shadow.mapSize.set(1024, 1024);
  cabSpot.shadow.bias = -0.00015;
  cabSpot.shadow.normalBias = 0.008;
  cabSpot.shadow.camera.near = 0.12;
  cabSpot.shadow.camera.far = 7;
  cab.add(cabSpot, cabSpot.target);

  // Back-wall controls stay in one direct glance from the entrance.
  const panel = new Group();
  panel.position.set(0, 0, -1.706);
  cab.add(panel);
  box(panel, aluminium, 0, 1.45, 0, 1.5, 1.91, 0.055);
  box(panel, dark, 0, 1.44, 0.034, 1.41, 1.81, 0.02);
  label(panel, 'SELECT FLOOR', 0, 2.21, 0.053, 1.24, 0.15, { width: 512, height: 64, fontSize: 44 });
  const buttonMaterials: MeshStandardMaterial[] = [];
  const buttonNumberMaterials: MeshBasicMaterial[] = [];
  const floorButtons: Mesh[] = [];
  for (let floor = 1; floor <= FLOORS; floor++) {
    const column = (floor - 1) % 4;
    const row = Math.floor((floor - 1) / 4);
    const x = (column - 1.5) * 0.317;
    const y = 1.9 - row * 0.278;
    const rim = new Mesh(rimGeometry, aluminium);
    rim.position.set(x, y, 0.056);
    panel.add(rim);
    interactive(rim, { type: 'floor', floor });
    const buttonMat = new MeshStandardMaterial({ color: colors.dark, roughness: 0.62, metalness: 0.15, emissive: colors.amber, emissiveIntensity: 0.02 });
    buttonMaterials.push(buttonMat);
    const button = new Mesh(buttonGeometry, buttonMat);
    button.position.set(x, y, 0.084);
    panel.add(button);
    interactive(button, { type: 'floor', floor });
    floorButtons.push(button);
    const number = label(panel, String(floor), x, y, 0.115, 0.157, 0.157, { fontSize: floor > 9 ? 72 : 81 });
    buttonNumberMaterials.push(number.material);
    interactive(number, { type: 'floor', floor });
  }
  for (const [open, x, text] of [[true, -0.24, '◀ ▶'], [false, 0.24, '▶ ◀']] as const) {
    const face = box(panel, dark, x, 0.575, 0.073, 0.35, 0.16, 0.065);
    interactive(face, { type: 'door', open });
    const symbol = label(panel, text, x, 0.575, 0.111, 0.29, 0.105, { width: 256, height: 64, fontSize: 42 });
    interactive(symbol, { type: 'door', open });
  }
  // The floor indicator is deliberately readable without post-processing.
  box(cab, dark, 0, 2.65, -1.697, 1.49, 0.27, 0.056);
  const displayCanvas = document.createElement('canvas');
  displayCanvas.width = 512;
  displayCanvas.height = 96;
  const displayContext = displayCanvas.getContext('2d')!;
  const displayTexture = new CanvasTexture(displayCanvas);
  displayTexture.colorSpace = SRGBColorSpace;
  const display = new Mesh(planeGeometry, new MeshBasicMaterial({ map: displayTexture }));
  display.position.set(0, 2.65, -1.664);
  display.scale.set(1.38, 0.21, 1);
  cab.add(display);
  label(cab, '20 FLOORS · TWO RIDERS', 0, 0.27, -1.71, 2.4, 0.13, { width: 768, height: 64, fontSize: 42 });

  // A real, slightly raised rim makes the control under the crosshair clear.
  const targetRing = new Mesh(new RingGeometry(0.11, 0.128, 40), new MeshBasicMaterial({ color: 0xffdb92, toneMapped: false }));
  targetRing.name = 'Aimed control rim';
  targetRing.userData.ignorePicking = true;
  targetRing.visible = false;
  world.add(targetRing);

  const sky = new HemisphereLight(0xb7d4e4, 0x746557, 0.95);
  scene.add(sky);
  const sun = new DirectionalLight(0xffddaf, 2.2);
  sun.position.set(-14, 35, 15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -10;
  sun.shadow.camera.right = sun.shadow.camera.top = 10;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 52;
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.012;
  scene.add(sun, sun.target);
  const rimLight = new DirectionalLight(0x93b5d1, 0.55);
  rimLight.position.set(12, 10, -12);
  scene.add(rimLight);

  const avatars = new Map<string, { root: Group; body: Mesh; face: Group; slot: number }>();
  const pillGeometry = new CapsuleGeometry(0.22, PLAYER_HEIGHT - 0.44, 12, 28);
  const faceMaterial = material(0x1f282e, 0.4, 0.2);
  const avatarColors = [0xe0b56f, 0x70bec8];
  const debugMaterial = new MeshBasicMaterial({ color: 0x80e9d6, wireframe: true, transparent: true, opacity: 0.3, depthWrite: false });
  const debug = new Group();
  debug.visible = false;
  debug.userData.ignorePicking = true;
  world.add(debug);
  const cabBounds = box(cab, debugMaterial, 0, 1.5, 0, 3.6, 3, 3.6);
  cabBounds.visible = false;
  cabBounds.userData.ignorePicking = true;
  for (let floor = 1; floor <= FLOORS; floor++) {
    box(debug, debugMaterial, 0, (floor - 1) * FLOOR_HEIGHT - 0.035, 4.8, 7.6, 0.07, 6);
  }

  let indicatorState = '';
  function updateElevator(state: ElevatorVisualState) {
    cab.position.y = state.y;
    const opening = Math.max(0, Math.min(1, state.door));
    cabDoorParts[0].position.x = -DOOR_HALF / 2 - opening * DOOR_HALF;
    cabDoorParts[1].position.x = DOOR_HALF / 2 + opening * DOOR_HALF;
    for (let i = 0; i < FLOORS; i++) {
      landingPivots[i].rotation.y = -(state.landingOpen?.[i] ?? (i === 0 ? 1 : 0)) * 1.55;
      const current = state.currentFloor === i + 1;
      const queued = state.queue.includes(i + 1) || state.targetFloor === i + 1;
      buttonMaterials[i].color.setHex(current ? 0xe2a34b : queued ? 0x9b3930 : colors.dark);
      buttonMaterials[i].emissive.setHex(queued && !current ? colors.queued : colors.amber);
      buttonMaterials[i].emissiveIntensity = current ? 0.68 : queued ? 0.42 : 0.02;
      buttonNumberMaterials[i].color.setHex(current ? 0x1c282d : 0xffffff);
      callLights[i].color.setHex(queued ? 0xa27030 : colors.dark);
      callLights[i].emissiveIntensity = queued ? 0.5 : 0.025;
    }
    const direction = state.targetFloor == null ? '—' : state.targetFloor > state.currentFloor ? '↑' : state.targetFloor < state.currentFloor ? '↓' : '—';
    const nextIndicator = `${String(state.currentFloor).padStart(2, '0')}  ${direction}  ${state.phase === 'moving' ? 'TRAVEL' : state.door > 0.8 ? 'OPEN' : 'READY'}`;
    if (indicatorState !== nextIndicator) {
      indicatorState = nextIndicator;
      displayContext.fillStyle = '#181c1d';
      displayContext.fillRect(0, 0, displayCanvas.width, displayCanvas.height);
      displayContext.fillStyle = '#ffc66d';
      displayContext.font = '600 61px "Courier New", monospace';
      displayContext.textAlign = 'center';
      displayContext.textBaseline = 'middle';
      displayContext.fillText(indicatorState, displayCanvas.width / 2, displayCanvas.height / 2 + 4);
      displayTexture.needsUpdate = true;
    }
  }

  function updatePlayer(id: string, player: PlayerVisualState, visible: boolean, ignorePicking = false) {
    let avatar = avatars.get(id);
    if (!avatar) {
      const root = new Group();
      root.name = `Rider ${player.slot + 1}`;
      const body = new Mesh(pillGeometry, material(avatarColors[player.slot % 2], 0.4, 0.03));
      body.castShadow = true;
      body.receiveShadow = true;
      root.add(body);
      const face = new Group();
      root.add(face);
      // A small visor says which way another capsule is looking.
      box(face, faceMaterial, 0, 0, -0.207, 0.265, 0.11, 0.065);
      box(face, cream, 0, 0, -0.244, 0.15, 0.019, 0.01);
      world.add(root);
      avatar = { root, body, face, slot: player.slot };
      avatars.set(id, avatar);
    }
    if (avatar.slot !== player.slot) {
      avatar.slot = player.slot;
      (avatar.body.material as MeshStandardMaterial).color.setHex(avatarColors[player.slot % 2]);
    }
    const crouch = typeof player.crouch === 'number' ? player.crouch : player.crouch ? 1 : 0;
    const height = PLAYER_HEIGHT + (CROUCH_HEIGHT - PLAYER_HEIGHT) * Math.max(0, Math.min(1, crouch));
    avatar.root.visible = visible;
    avatar.root.userData.ignorePicking = ignorePicking;
    avatar.root.position.set(player.x, player.y, player.z);
    avatar.root.rotation.y = player.yaw;
    avatar.body.position.y = height / 2;
    avatar.body.scale.y = height / PLAYER_HEIGHT;
    avatar.face.position.y = height - 0.31;
  }

  function removePlayer(id: string) {
    const avatar = avatars.get(id);
    if (!avatar) return;
    world.remove(avatar.root);
    (avatar.body.material as MeshStandardMaterial).dispose();
    avatars.delete(id);
  }

  function setDebug(enabled: boolean) {
    debug.visible = enabled;
    cabBounds.visible = enabled;
  }

  function setMaterialDebug(mode: SurfaceDebugMode) {
    for (const surface of [aluminium, concrete, rubber]) setSurfaceMaterialDebug(surface, mode);
  }

  function setInteractionTarget(object?: Object3D | null) {
    const action = object?.userData.action as Action | undefined;
    const anchor = action?.type === 'floor' ? floorButtons[action.floor - 1] : action?.type === 'hail' ? callButtons[action.floor - 1] : undefined;
    targetRing.visible = !!anchor;
    if (!anchor) return;
    anchor.updateWorldMatrix(true, false);
    anchor.getWorldPosition(targetRing.position);
    targetRing.quaternion.copy(anchor.getWorldQuaternion(targetRing.quaternion));
    targetRing.position.add(new Vector3(0, 0, action?.type === 'hail' ? 0.025 : 0.035).applyQuaternion(targetRing.quaternion));
    targetRing.scale.setScalar(action?.type === 'hail' ? 0.75 : 1);
  }

  const shadowDirection = new Vector3(-14, 24, 16);
  const lightForward = shadowDirection.clone().normalize();
  const lightRight = new Vector3(0, 1, 0).cross(lightForward).normalize();
  const lightUp = lightForward.clone().cross(lightRight).normalize();
  function updateView(position: Vector3) {
    // Snap in the light's projection axes, rather than world axes, so shadow
    // texels remain still as the rider moves and the cabin travels vertically.
    const texel = 20 / sun.shadow.mapSize.x;
    const right = Math.round(position.dot(lightRight) / texel) * texel;
    const up = Math.round(position.dot(lightUp) / texel) * texel;
    const forward = position.dot(lightForward);
    sun.target.position.copy(lightRight).multiplyScalar(right)
      .addScaledVector(lightUp, up).addScaledVector(lightForward, forward);
    sun.position.copy(sun.target.position).add(shadowDirection);
  }

  return { cab, interactables, updateElevator, updatePlayer, removePlayer, setDebug, setMaterialDebug, setInteractionTarget, updateView };
}

function batchBoxes(parent: Object3D, parts: Array<{ position: Vector3; scale: Vector3; rotation?: number }>, mat: Material) {
  const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), mat, parts.length);
  const transform = new Object3D();
  for (let i = 0; i < parts.length; i++) {
    transform.position.copy(parts[i].position);
    transform.scale.copy(parts[i].scale);
    transform.rotation.set(0, 0, parts[i].rotation ?? 0);
    transform.updateMatrix();
    mesh.setMatrixAt(i, transform.matrix);
  }
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  parent.add(mesh);
  return mesh;
}
