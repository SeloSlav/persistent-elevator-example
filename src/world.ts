import {
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CylinderGeometry,
  LatheGeometry,
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
  Vector2,
} from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createDuskEnvironment, createSurfaceMaterials, setSurfaceMaterialDebug, type SurfaceDebugMode } from './materials';
import { GROUND_FLOOR, GROUND_Y, LANDING_COUNT, floorLabel, floorY, landingFloor, landingIndex } from '../shared/simulation';
import { floorIndicator } from './floor-indicator';

export interface ElevatorVisualState {
  y: number;
  door: number;
  currentFloor: number;
  targetFloor: number | null;
  phase: string;
  queue: number[];
  velocity?: number;
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
  scene.environmentIntensity = 0.48;
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
    emissiveIntensity: 1.8,
    roughness: 0.7,
  });
  const boxGeometry = new BoxGeometry(1, 1, 1);
  const planeGeometry = new PlaneGeometry(1, 1);
  // The button and bezel are separate turned profiles, with a real annular
  // opening and bevels. Their depth contract is shared by the call stations.
  const buttonGeometry = new LatheGeometry([
    new Vector2(0, 0), new Vector2(0.09, 0), new Vector2(0.1, 0.007),
    new Vector2(0.102, 0.026), new Vector2(0.096, 0.039),
    new Vector2(0.088, 0.044), new Vector2(0, 0.044),
  ], 48);
  buttonGeometry.rotateX(Math.PI / 2);
  const rimGeometry = new LatheGeometry([
    new Vector2(0.106, 0), new Vector2(0.125, 0),
    new Vector2(0.135, 0.008), new Vector2(0.135, 0.024),
    new Vector2(0.128, 0.034), new Vector2(0.106, 0.034),
    new Vector2(0.106, 0),
  ], 48);
  rimGeometry.rotateX(Math.PI / 2);
  const roundedGeometry = new Map<string, RoundedBoxGeometry>();

  function box(parent: Object3D, mat: Material, x: number, y: number, z: number, w: number, h: number, d: number) {
    const mesh = new Mesh(boxGeometry, mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  function fittedBox(parent: Object3D, mat: Material, x: number, y: number, z: number, w: number, h: number, d: number, radius = 0.012) {
    // Repeated tower fittings use one bevel subdivision; the close interior
    // receives two. Smooth normals retain the edge highlight at either tier.
    const segments = parent === world || parent.name.startsWith('Landing ') ? 1 : 2;
    const key = [w, h, d, radius, segments].join('/');
    let geometry = roundedGeometry.get(key);
    if (!geometry) {
      geometry = new RoundedBoxGeometry(w, h, d, segments, radius);
      roundedGeometry.set(key, geometry);
    }
    const mesh = new Mesh(geometry, mat);
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    mesh.userData.decoration = true;
    parent.add(mesh);
    return mesh;
  }

  // Noninteractive fittings with the same material compile into one mesh.
  // Moving leaves and clickable controls retain their own object identity.
  function compileFittings(parent: Object3D) {
    const bundles = new Map<string, Mesh[]>();
    for (const child of [...parent.children]) {
      if (!(child instanceof Mesh) || !child.userData.decoration || child.userData.action || Array.isArray(child.material)) continue;
      const key = `${child.material.uuid}/${child.castShadow}/${child.receiveShadow}`;
      const bundle = bundles.get(key) ?? [];
      bundle.push(child);
      bundles.set(key, bundle);
    }
    for (const meshes of bundles.values()) {
      if (meshes.length < 2) continue;
      const parts = meshes.map(mesh => {
        mesh.updateMatrix();
        const part = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
        return part.applyMatrix4(mesh.matrix);
      });
      const geometry = mergeGeometries(parts);
      for (const part of parts) part.dispose();
      if (!geometry) continue;
      const compiled = new Mesh(geometry, meshes[0].material);
      compiled.name = 'Batched machined fittings';
      compiled.castShadow = meshes[0].castShadow;
      compiled.receiveShadow = meshes[0].receiveShadow;
      parent.add(compiled);
      for (const mesh of meshes) parent.remove(mesh);
    }
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
    ctx.font = `600 ${options.fontSize ?? 64}px "Segoe UI", Arial, sans-serif`;
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
    const mat = new MeshBasicMaterial({ map: textTexture(text, options), transparent: !options?.background, depthWrite: !!options?.background });
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

  // The plaza and G cab share physics y=-4. The insert under the shaft is
  // hidden while the cab occupies it, leaving exactly one visible floor.
  box(world, concrete, -9.9, GROUND_Y - 0.22, 0, 16.2, 0.44, 36);
  box(world, concrete, 9.9, GROUND_Y - 0.22, 0, 16.2, 0.44, 36);
  box(world, concrete, 0, GROUND_Y - 0.22, -9.9, 3.6, 0.44, 16.2);
  box(world, concrete, 0, GROUND_Y - 0.22, 9.9, 3.6, 0.44, 16.2);
  const groundShaftInsert = box(world, concrete, 0, GROUND_Y - 0.22, 0, 3.6, 0.44, 3.6);
  const gridParts: Array<{ position: Vector3; scale: Vector3; rotation?: number }> = [];
  for (let n = -16; n <= 16; n += 2) {
    if (Math.abs(n) < CAB_HALF) {
      for (const side of [-1, 1]) {
        gridParts.push({ position: new Vector3(n, GROUND_Y + 0.01, side * 9.42), scale: new Vector3(0.017, 0.006, 15.16) });
        gridParts.push({ position: new Vector3(side * 9.42, GROUND_Y + 0.01, n), scale: new Vector3(15.16, 0.006, 0.017) });
      }
    } else {
      gridParts.push({ position: new Vector3(n, GROUND_Y + 0.01, 0), scale: new Vector3(0.017, 0.006, 34) });
      gridParts.push({ position: new Vector3(0, GROUND_Y + 0.01, n), scale: new Vector3(34, 0.006, 0.017) });
    }
  }
  batchBoxes(world, gridParts, material(0x828e94, 1, 0));
  box(world, dark, 0, -3.96, -3.05, 4.7, 0.05, 0.8);
  const towerName = label(world, 'PERSISTENT / 20', 0, -3.927, -3.05, 3.7, 0.38, { width: 768, height: 96, fontSize: 55 });
  towerName.rotation.x = -Math.PI / 2;

  // One instanced structural assembly keeps the open tower inexpensive.
  const structure: Array<{ position: Vector3; scale: Vector3; rotation?: number }> = [];
  const top = (FLOORS - 1) * FLOOR_HEIGHT + 3.5;
  const shaftBottom = GROUND_Y - 0.45;
  for (const x of [-2.08, 2.08]) {
    for (const z of [-2.08, 2.08]) {
      structure.push({ position: new Vector3(x, (top + shaftBottom) / 2, z), scale: new Vector3(0.14, top - shaftBottom, 0.14) });
    }
  }
  for (let floor = GROUND_FLOOR; floor <= FLOORS; floor++) {
    const y = floorY(floor);
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
        // Cross braces occupy separate depth layers at their intersection.
        structure.push({ position: new Vector3(0, y + rise / 2 - 0.25, -2.08 + (sign === 1 ? 0.055 : -0.055)), scale: new Vector3(0.075, length, 0.08), rotation: sign * Math.atan2(span, rise) });
      }
    }
  }
  const shaftStructure = batchBoxes(world, structure, steel);
  shaftStructure.castShadow = true;
  // Two guide rails remain visible through the rear of the open shaft.
  box(world, aluminium, -1.4, (top + shaftBottom) / 2, -1.97, 0.06, top - shaftBottom, 0.08);
  box(world, aluminium, 1.4, (top + shaftBottom) / 2, -1.97, 0.06, top - shaftBottom, 0.08);

  const landingPivots: Group[] = [];
  const callLights: MeshStandardMaterial[] = [];
  const callButtons: Mesh[] = [];
  const platformParts: Array<{ position: Vector3; scale: Vector3 }> = [];
  const edgeParts: Array<{ position: Vector3; scale: Vector3 }> = [];
  const fixtureParts: Array<{ position: Vector3; scale: Vector3 }> = [];
  const fixtureLights: Array<{ position: Vector3; scale: Vector3 }> = [];
  const platformBraces: Array<{ position: Vector3; scale: Vector3; rotation?: number }> = [];
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
  const hazardMaterial = new MeshStandardMaterial({ map: hazardMap, color: 0xe2d5b0, metalness: 0, roughness: 0.84 });
  const hazardGeometry = new PlaneGeometry(1, 1);
  // Paint belongs to one top-facing sheet. Boxes printed the same graphic on
  // every cap, and intersecting corner strips produced coincident top faces.
  function hazardStripe(x: number, y: number, z: number, w: number, d: number) {
    const mesh = new Mesh(hazardGeometry, hazardMaterial);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y + 0.009, z);
    mesh.scale.set(w, d, 1);
    mesh.receiveShadow = false;
    mesh.userData.decoration = true;
    world.add(mesh);
  }
  for (let index = 0; index < LANDING_COUNT; index++) {
    const floor = landingFloor(index);
    const y = floorY(floor);
    if (floor !== GROUND_FLOOR) platformParts.push({ position: new Vector3(0, y - 0.11, 1.8 + PLATFORM_DEPTH / 2), scale: new Vector3(7.6, 0.22, PLATFORM_DEPTH) });
    // Fascia sits outside and below the slab, so its top never overlays concrete.
    if (floor !== GROUND_FLOOR) edgeParts.push({ position: new Vector3(0, y - 0.115, 7.824), scale: new Vector3(7.6, 0.16, 0.035) });
    for (const side of [-1, 1]) {
      if (floor !== GROUND_FLOOR) edgeParts.push({ position: new Vector3(side * 3.824, y - 0.115, 4.8), scale: new Vector3(0.035, 0.16, 6) });
      // Under-slab cantilevers add a structural silhouette without obstructing play.
      if (floor !== GROUND_FLOOR) platformBraces.push({ position: new Vector3(side * 2.85, y - 0.41, 4.8), scale: new Vector3(0.09, 0.25, 5.8) });
      fixtureParts.push({ position: new Vector3(side * 0.95, y + 2.815, 2.067), scale: new Vector3(0.16, 0.055, 0.08) });
      fixtureLights.push({ position: new Vector3(side * 0.95, y + 2.815, 2.113), scale: new Vector3(0.11, 0.021, 0.012) });
      if (floor !== GROUND_FLOOR) hazardStripe(side * 3.47, y, 4.65, 0.16, 5.38);
    }
    // End strip stops short of each side stripe; corners never overlap.
    if (floor !== GROUND_FLOOR) hazardStripe(0, y, 7.49, 6.72, 0.18);
    // The gate frame ends at the doorway; the rest of every platform is open.
    // Posts end at the underside of the lintel, avoiding stacked top caps.
    for (const side of [-1, 1]) {
      fittedBox(world, steel, side * 0.925, y + 1.315, 1.96, 0.15, 2.63, 0.2, 0.014).castShadow = true;
      fittedBox(world, aluminium, side * 0.925, y + 0.065, 1.96, 0.195, 0.11, 0.245, 0.012);
    }
    fittedBox(world, steel, 0, y + 2.715, 1.96, 2.06, 0.15, 0.22, 0.018).castShadow = true;
    fittedBox(world, aluminium, 0, y + 2.815, 1.975, 2.16, 0.035, 0.255, 0.008);

    const pivot = new Group();
    pivot.position.set(-DOOR_HALF, y, 1.97);
    pivot.name = `Landing ${floor} swing door`;
    world.add(pivot);
    landingPivots[index] = pivot;
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
      fittedBox(pivot, aluminium, a - 0.016, 1.67, 0.052, 0.028, 0.94, 0.023, 0.004),
      fittedBox(pivot, aluminium, b + 0.016, 1.67, 0.052, 0.028, 0.94, 0.023, 0.004),
      fittedBox(pivot, aluminium, windowX, windowBottom - 0.023, 0.052, 0.25, 0.032, 0.023, 0.004),
      fittedBox(pivot, aluminium, windowX, windowTop + 0.023, 0.052, 0.25, 0.032, 0.023, 0.004),
      box(pivot, windowGlass, windowX, 1.67, 0.005, windowWidth, 0.94, 0.009),
    ];
    for (const mesh of reveal) interactive(mesh, action);
    fittedBox(pivot, dark, windowX, 1.06, 0.052, 0.24, 0.12, 0.02, 0.006);
    for (const handle of [
      box(pivot, aluminium, 1.38, 1.08, 0.145, 0.035, 0.3, 0.034),
      box(pivot, aluminium, 1.38, 1.22, 0.097, 0.035, 0.026, 0.12),
      box(pivot, aluminium, 1.38, 0.94, 0.097, 0.035, 0.026, 0.12),
    ]) interactive(handle, action);
    // A protected hinge and kick plate give each leaf a readable construction.
    for (const hingeY of [0.38, 2.28]) fittedBox(pivot, aluminium, 0.055, hingeY, 0.054, 0.055, 0.15, 0.024, 0.008);
    const kick = fittedBox(pivot, aluminium, leafWidth / 2, 0.17, 0.052, leafWidth - 0.12, 0.22, 0.02, 0.006);
    interactive(kick, action);
    // Only floor numbers and the call face emit light.
    fittedBox(world, steel, 1.28, y + 1.28, 1.93, 0.085, 2.56, 0.085, 0.01);
    fittedBox(world, aluminium, 1.28, y + 1.695, 1.996, 0.40, 0.66, 0.078, 0.018);
    fittedBox(world, dark, 1.28, y + 1.695, 2.041, 0.35, 0.60, 0.018, 0.009);
    label(world, floorLabel(floor), 1.28, y + 1.80, 2.061, 0.27, 0.15, { fontSize: 76 });
    const callMat = new MeshStandardMaterial({ color: colors.dark, emissive: colors.amber, emissiveIntensity: 0.025, roughness: 0.5, metalness: 0.3 });
    callLights[index] = callMat;
    const call = new Mesh(buttonGeometry, callMat);
    call.scale.setScalar(0.75);
    call.position.set(1.28, y + 1.52, 2.061);
    call.userData.targetOffsetZ = 0.041;
    call.userData.targetScale = 0.75;
    world.add(call);
    interactive(call, { type: 'hail', floor });
    callButtons[index] = call;
    const callRim = new Mesh(rimGeometry, aluminium);
    callRim.scale.setScalar(0.75);
    callRim.position.set(1.28, y + 1.52, 2.056);
    world.add(callRim);
    interactive(callRim, { type: 'hail', floor });
    // Larger clean wayfinding is visible across the exposed platform.
    fittedBox(world, steel, -1.16, y + 2.22, 1.94, 0.50, 0.055, 0.065, 0.006);
    fittedBox(world, aluminium, -1.46, y + 2.17, 1.986, 0.84, 0.65, 0.065, 0.018);
    fittedBox(world, dark, -1.46, y + 2.17, 2.027, 0.77, 0.58, 0.014, 0.007);
    label(world, floorLabel(floor), -1.46, y + 2.23, 2.046, 0.64, 0.35, { fontSize: 86 });
    label(world, floor === GROUND_FLOOR ? 'GROUND' : 'LANDING', -1.46, y + 1.97, 2.046, 0.61, 0.07, { width: 256, height: 64, fontSize: 36 });
    compileFittings(pivot);
  }
  batchBoxes(world, platformParts, concrete).castShadow = true;
  batchBoxes(world, edgeParts, ochre);
  batchBoxes(world, platformBraces, steel);
  batchBoxes(world, fixtureParts, dark);
  batchBoxes(world, fixtureLights, lightPanel);

  const cab = new Group();
  cab.name = 'Persistent elevator cab';
  world.add(cab);
  // The finish owns the one walking plane at physics y=0. Its metal border
  // occupies separate rectangles rather than overlaying the rubber surface.
  box(cab, dark, 0, -0.075, 0, 3.6, 0.09, 3.6).castShadow = true;
  box(cab, rubber, 0, -0.015, 0, 3.376, 0.03, 3.376);
  box(cab, aluminium, 0, -0.015, -1.745, 3.6, 0.03, 0.11);
  box(cab, aluminium, 0, -0.015, 1.745, 3.6, 0.03, 0.11);
  for (const side of [-1, 1]) box(cab, aluminium, side * 1.745, -0.015, 0, 0.11, 0.03, 3.376);
  box(cab, dark, 0, 1.5, -1.86, 3.6, 3, 0.12).castShadow = true;
  box(cab, dark, -1.86, 1.5, 0, 0.12, 3, 3.6).castShadow = true;
  box(cab, dark, 1.86, 1.5, 0, 0.12, 3, 3.6).castShadow = true;
  box(cab, dark, 0, 3.06, 0, 3.6, 0.12, 3.6).castShadow = true;
  // Each wall bay has a shadow reveal and an individually formed enamel panel.
  // Decorative surfaces stay within 4 cm of the original wall bounds.
  for (const side of [-1, 1]) {
    for (const z of [-1.15, 0, 1.15]) {
      fittedBox(cab, enamel, side * 1.780, 1.515, z, 0.031, 2.39, 1.065, 0.012);
      fittedBox(cab, aluminium, side * 1.754, 0.58, z, 0.018, 0.36, 0.94, 0.008);
    }
    fittedBox(cab, aluminium, side * 1.778, 0.17, 0, 0.03, 0.23, 3.53, 0.01);
    fittedBox(cab, aluminium, side * 1.776, 2.79, 0, 0.031, 0.055, 3.53, 0.01);
    fittedBox(cab, aluminium, side * 1.778, 1.54, -1.768, 0.033, 2.43, 0.031, 0.009);
    fittedBox(cab, enamel, side * 1.282, 1.515, -1.780, 0.87, 2.39, 0.031, 0.012);
  }
  fittedBox(cab, enamel, 0, 1.515, -1.780, 1.65, 2.39, 0.031, 0.012);
  fittedBox(cab, aluminium, 0, 0.17, -1.778, 3.53, 0.23, 0.03, 0.01);
  fittedBox(cab, aluminium, 0, 2.79, -1.776, 3.53, 0.055, 0.031, 0.01);
  // Circular handrails and small stand-offs follow the wall bays.
  function handrail(x: number, y: number, z: number, length: number, alongX = false) {
    const mesh = new Mesh(new CapsuleGeometry(0.027, length - 0.054, 4, 16), aluminium);
    if (alongX) mesh.rotation.z = Math.PI / 2;
    else mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.userData.decoration = true;
    mesh.receiveShadow = true;
    cab.add(mesh);
  }
  for (const side of [-1, 1]) {
    handrail(side * 1.66, 1.02, -0.03, 2.95);
    for (const z of [-1.24, 1.18]) fittedBox(cab, aluminium, side * 1.726, 1.02, z, 0.102, 0.04, 0.07, 0.012);
    fittedBox(cab, aluminium, side * 1.39, 1.02, -1.726, 0.07, 0.04, 0.102, 0.012);
  }
  handrail(0, 1.02, -1.66, 3.21, true);
  fittedBox(cab, aluminium, 0, 1.02, -1.726, 0.07, 0.04, 0.102, 0.012);
  // The front side pockets leave exactly the collision model's 1.7 m opening.
  for (const side of [-1, 1]) {
    // A true pocket: the inner cover ends at z=1.816, the outside cover
    // starts at z=1.906. Retracting leaves fit between them and disappear
    // behind the cover from either side of the cab.
    box(cab, ochre, side * (CAB_HALF + DOOR_HALF) / 2, 1.5, 1.808, CAB_HALF - DOOR_HALF, 3, 0.016).castShadow = true;
    box(cab, ochre, side * (CAB_HALF + DOOR_HALF) / 2, 1.5, 1.918, CAB_HALF - DOOR_HALF, 3, 0.024).castShadow = true;
    // Jambs finish at the header rather than overlapping its end caps.
    fittedBox(cab, aluminium, side * 0.889, 1.32, 1.934, 0.058, 2.64, 0.023, 0.008);
    if (side < 0) fittedBox(cab, aluminium, side * 1.326, 1.46, 1.785, 0.74, 2.68, 0.018, 0.007);
    else {
      // The compact station is recessed into a real opening in this cover.
      // Four separate panels leave an aperture, rather than overlaying steel.
      for (const x of [1.026, 1.626]) fittedBox(cab, aluminium, x, 1.46, 1.785, 0.14, 2.68, 0.018, 0.006);
      fittedBox(cab, aluminium, 1.326, 0.477, 1.785, 0.46, 0.714, 0.018, 0.006);
      fittedBox(cab, aluminium, 1.326, 2.490, 1.785, 0.46, 0.62, 0.018, 0.006);
    }
  }
  box(cab, ochre, 0, 2.825, 1.86, 1.7, 0.35, 0.12).castShadow = true;
  fittedBox(cab, aluminium, 0, 2.679, 1.934, 1.836, 0.058, 0.023, 0.008);
  const cabDoorParts: Group[] = [];
  for (const side of [-1, 1]) {
    const door = new Group();
    door.position.x = side * DOOR_HALF / 2;
    cab.add(door);
    cabDoorParts.push(door);
    // Decorated faces lie in [1.819, 1.897], with 3/9 mm cavity clearances.
    // Seams are gaps between formed panels; no crossed strip faces remain.
    fittedBox(door, steel, 0, 1.31, 1.858, DOOR_HALF - 0.013, 2.62, 0.042, 0.007).castShadow = true;
    for (const depth of [1.826, 1.890]) {
      for (const [height, span] of [[0.32, 0.48], [1.42, 1.58], [2.415, 0.30]]) {
        fittedBox(door, aluminium, 0, height, depth, 0.742, span, 0.014, 0.005);
      }
    }
    compileFittings(door);
  }
  // Complete recessed luminaire: formed frame, diffuser, perimeter coffer and
  // separate vent slots. Every underside occupies its own height layer.
  fittedBox(cab, cream, 0, 2.969, 0, 3.52, 0.036, 3.52, 0.01);
  fittedBox(cab, aluminium, 0, 2.93, -0.10, 2.91, 0.068, 2.25, 0.025);
  fittedBox(cab, lightPanel, 0, 2.878, -0.10, 2.68, 0.024, 1.98, 0.011);
  const ceilingLouvers: Array<{ position: Vector3; scale: Vector3 }> = [];
  for (const z of [-1.49, 1.40]) {
    fittedBox(cab, steel, 0, 2.902, z, 2.55, 0.025, 0.23, 0.01);
    for (let x = -1.11; x <= 1.12; x += 0.085) ceilingLouvers.push({ position: new Vector3(x, 2.88, z), scale: new Vector3(0.026, 0.012, 0.16) });
  }
  batchBoxes(cab, ceilingLouvers, aluminium).receiveShadow = false;
  const cabLight = new PointLight(0xffddaf, 7.5, 5.5, 2);
  cabLight.position.set(0, 2.60, -0.95);
  cab.add(cabLight);
  const cabSpot = new SpotLight(0xffe1b5, 21, 6, 0.92, 0.72, 2);
  cabSpot.position.set(0, 2.73, 0.5);
  cabSpot.target.position.set(0, 0.1, -0.25);
  cabSpot.castShadow = true;
  cabSpot.shadow.mapSize.set(1024, 1024);
  cabSpot.shadow.bias = -0.00008;
  cabSpot.shadow.normalBias = 0.006;
  cabSpot.shadow.camera.near = 0.16;
  cabSpot.shadow.camera.far = 6;
  cab.add(cabSpot, cabSpot.target);

  // A 450 × 1250 mm real control station is recessed into the right doorway
  // pocket. Inward-facing controls project less than 4 cm past the wall skin.
  const panel = new Group();
  panel.name = 'Compact right doorway control station';
  panel.position.set(1.326, 0, 1.802);
  panel.rotation.y = Math.PI;
  cab.add(panel);
  fittedBox(panel, dark, 0, 1.50, 0.011, 0.47, 1.28, 0.006, 0.009);
  fittedBox(panel, aluminium, 0, 1.50, 0.017, 0.45, 1.25, 0.010, 0.008);
  label(panel, 'ELEVATOR', 0, 2.087, 0.025, 0.235, 0.023, { width: 384, height: 64, fontSize: 42, color: '#24373a' });
  const fastener = new CylinderGeometry(0.0045, 0.0045, 0.003, 24);
  fastener.rotateX(Math.PI / 2);
  for (const x of [-0.203, 0.203]) for (const y of [0.922, 2.077]) {
    const screw = new Mesh(fastener, aluminium);
    screw.position.set(x, y, 0.025);
    screw.userData.decoration = true;
    screw.receiveShadow = true;
    panel.add(screw);
    fittedBox(panel, dark, x, y, 0.0276, 0.0055, 0.0009, 0.0005, 0.0002);
  }
  // Shared crisp emissive display texture drives the doorway and station.
  const displayCanvas = document.createElement('canvas');
  displayCanvas.width = 512;
  displayCanvas.height = 128;
  const displayContext = displayCanvas.getContext('2d')!;
  const displayTexture = new CanvasTexture(displayCanvas);
  displayTexture.colorSpace = SRGBColorSpace;
  displayTexture.minFilter = LinearFilter;
  displayTexture.magFilter = LinearFilter;
  const displayMaterial = new MeshBasicMaterial({ map: displayTexture, toneMapped: false });
  fittedBox(panel, dark, 0, 2.027, 0.024, 0.318, 0.071, 0.005, 0.004);
  const stationDisplay = new Mesh(planeGeometry, displayMaterial);
  stationDisplay.position.set(0, 2.027, 0.030);
  stationDisplay.scale.set(0.297, 0.060, 1);
  panel.add(stationDisplay);
  const buttonMaterials: MeshStandardMaterial[] = [];
  const buttonNumberMaterials: MeshBasicMaterial[] = [];
  const floorButtons: Mesh[] = [];
  const controlScale = 0.26;
  for (let index = 0; index < LANDING_COUNT; index++) {
    const floor = landingFloor(index);
    const column = floor === GROUND_FLOOR ? 0 : (floor - 1) % 2;
    const row = floor === GROUND_FLOOR ? -1 : Math.floor((floor - 1) / 2);
    const x = (column - 0.5) * 0.168;
    const y = 1.230 + row * 0.072;
    const rim = new Mesh(rimGeometry, aluminium);
    rim.scale.setScalar(controlScale);
    rim.position.set(x, y, 0.022);
    panel.add(rim);
    interactive(rim, { type: 'floor', floor });
    const buttonMat = new MeshStandardMaterial({ color: colors.dark, roughness: 0.44, metalness: 0.2, emissive: colors.amber, emissiveIntensity: 0.015 });
    buttonMaterials[index] = buttonMat;
    const button = new Mesh(buttonGeometry, buttonMat);
    button.scale.setScalar(controlScale);
    button.position.set(x, y, 0.025);
    button.userData.targetOffsetZ = 0.019;
    button.userData.targetScale = controlScale;
    panel.add(button);
    interactive(button, { type: 'floor', floor });
    floorButtons[index] = button;
    const number = label(panel, floor === GROUND_FLOOR ? '★G' : floorLabel(floor), x, y, 0.0405, 0.041, 0.041, { fontSize: floor === GROUND_FLOOR ? 61 : floor > 9 ? 76 : 86, color: '#ffffff' });
    buttonNumberMaterials[index] = number.material;
    interactive(number, { type: 'floor', floor });
  }
  label(panel, 'GROUND', 0.076, 1.158, 0.026, 0.125, 0.023, { width: 256, height: 64, fontSize: 39, color: '#314043' });
  for (const [open, x, text] of [[true, -0.084, '◀ ▶'], [false, 0.084, '▶ ◀']] as const) {
    fittedBox(panel, steel, x, 1.016, 0.025, 0.088, 0.063, 0.005, 0.006);
    const face = fittedBox(panel, dark, x, 1.016, 0.031, 0.078, 0.052, 0.006, 0.007);
    interactive(face, { type: 'door', open });
    const symbol = label(panel, text, x, 1.016, 0.038, 0.062, 0.033, { width: 256, height: 128, fontSize: 55, color: '#f2eee4' });
    interactive(symbol, { type: 'door', open });
  }
  label(panel, 'DOORS', 0, 0.956, 0.026, 0.131, 0.019, { width: 256, height: 64, fontSize: 39, color: '#314043' });
  // Header indicator is a compact inward-facing module above the door opening.
  const indicator = new Group();
  indicator.position.set(0, 2.817, 1.802);
  indicator.rotation.y = Math.PI;
  cab.add(indicator);
  fittedBox(indicator, aluminium, 0, 0, 0.013, 0.53, 0.174, 0.018, 0.010);
  fittedBox(indicator, dark, 0, 0, 0.028, 0.486, 0.132, 0.008, 0.005);
  const display = new Mesh(planeGeometry, displayMaterial);
  display.position.set(0, 0, 0.037);
  display.scale.set(0.457, 0.109, 1);
  indicator.add(display);
  label(cab, 'CAPACITY 2 PERSONS  /  200 KG', 0, 2.55, -1.749, 0.56, 0.040, { width: 768, height: 96, fontSize: 48, color: '#42504e' });
  compileFittings(indicator);
  compileFittings(panel);
  compileFittings(cab);
  compileFittings(world);

  // A real, slightly raised rim makes the control under the crosshair clear.
  const targetRing = new Mesh(new RingGeometry(0.11, 0.128, 40), new MeshBasicMaterial({ color: 0xffdb92, toneMapped: false }));
  targetRing.name = 'Aimed control rim';
  targetRing.userData.ignorePicking = true;
  targetRing.visible = false;
  world.add(targetRing);

  const sky = new HemisphereLight(0xb7d4e4, 0x746557, 0.70);
  scene.add(sky);
  const sun = new DirectionalLight(0xffddaf, 1.85);
  sun.position.set(-14, 35, 15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -10;
  sun.shadow.camera.right = sun.shadow.camera.top = 10;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 52;
  sun.shadow.bias = -0.00010;
  sun.shadow.normalBias = 0.009;
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
  for (let floor = GROUND_FLOOR; floor <= FLOORS; floor++) {
    box(debug, debugMaterial, 0, floorY(floor) - 0.035, 4.8, 7.6, 0.07, 6);
  }

  let indicatorState = '';
  function updateElevator(state: ElevatorVisualState) {
    cab.position.y = state.y;
    groundShaftInsert.visible = state.y - GROUND_Y > 0.13;
    const opening = Math.max(0, Math.min(1, state.door));
    cabDoorParts[0].position.x = -DOOR_HALF / 2 - opening * DOOR_HALF;
    cabDoorParts[1].position.x = DOOR_HALF / 2 + opening * DOOR_HALF;
    const indication = floorIndicator({ y: state.y, targetFloor: state.targetFloor ?? state.currentFloor, phase: state.phase === 'moving' ? 'moving' : 'idle' });
    for (let i = 0; i < LANDING_COUNT; i++) {
      const floor = landingFloor(i);
      landingPivots[i].rotation.y = -(state.landingOpen?.[i] ?? (floor === state.currentFloor ? opening : 0)) * 1.55;
      const current = state.phase !== 'moving' && indication.floor === floor;
      const queued = state.queue.includes(floor) || state.targetFloor === floor;
      buttonMaterials[i].color.setHex(current ? 0xe2a34b : queued ? 0x9b3930 : colors.dark);
      buttonMaterials[i].emissive.setHex(queued && !current ? colors.queued : colors.amber);
      buttonMaterials[i].emissiveIntensity = current ? 0.68 : queued ? 0.42 : 0.02;
      buttonNumberMaterials[i].color.setHex(current ? 0x1c282d : 0xffffff);
      callLights[i].color.setHex(queued ? 0xa27030 : colors.dark);
      callLights[i].emissiveIntensity = queued ? 0.5 : 0.025;
    }
    const nextIndicator = `${indication.label}/${indication.direction}`;
    if (indicatorState !== nextIndicator) {
      indicatorState = nextIndicator;
      displayContext.fillStyle = '#12201f';
      displayContext.fillRect(0, 0, displayCanvas.width, displayCanvas.height);
      displayContext.fillStyle = '#f3cb87';
      displayContext.font = '600 98px "Segoe UI", Arial, sans-serif';
      displayContext.textAlign = 'center';
      displayContext.textBaseline = 'middle';
      displayContext.fillText(indication.label, 310, displayCanvas.height / 2 + 2);
      if (indication.direction !== 'idle') {
        const up = indication.direction === 'up';
        displayContext.strokeStyle = '#f3cb87';
        displayContext.lineWidth = 8;
        displayContext.lineCap = 'round';
        displayContext.lineJoin = 'round';
        displayContext.beginPath();
        displayContext.moveTo(97, up ? 79 : 48);
        displayContext.lineTo(123, up ? 49 : 78);
        displayContext.lineTo(149, up ? 79 : 48);
        displayContext.stroke();
      }
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
    const anchor = action?.type === 'floor' ? floorButtons[landingIndex(action.floor)] : action?.type === 'hail' ? callButtons[landingIndex(action.floor)] : undefined;
    targetRing.visible = !!anchor;
    if (!anchor) return;
    anchor.updateWorldMatrix(true, false);
    anchor.getWorldPosition(targetRing.position);
    targetRing.quaternion.copy(anchor.getWorldQuaternion(targetRing.quaternion));
    targetRing.position.add(new Vector3(0, 0, anchor.userData.targetOffsetZ ?? 0.054).applyQuaternion(targetRing.quaternion));
    targetRing.scale.setScalar(anchor.userData.targetScale ?? 1);
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
