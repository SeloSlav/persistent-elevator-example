import {
  CanvasTexture, Color, EquirectangularReflectionMapping, LinearMipmapLinearFilter,
  MeshPhysicalMaterial, MeshStandardMaterial, MeshStandardNodeMaterial, RepeatWrapping, SRGBColorSpace,
} from 'three/webgpu';
import { bumpMap, float, materialColor, modelPosition, normalWorld, positionWorld, texture, triplanarTexture, vec3 } from 'three/tsl';

export type SurfaceDebugMode = 'off' | 'height' | 'roughness';
const surfaceDiagnostics = new WeakMap<MeshStandardNodeMaterial, (mode: SurfaceDebugMode) => void>();

export function setSurfaceMaterialDebug(surface: MeshStandardNodeMaterial, mode: SurfaceDebugMode) {
  surfaceDiagnostics.get(surface)?.(mode);
}

/** All texture fields are deterministic. One texture tile represents one metre. */
const SURFACE_SEED = 20420;
function hash(x: number, y: number) {
  let value = Math.imul(x + SURFACE_SEED, 374761393) ^ Math.imul(y + 17, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function surfaceField(kind: 'brushed' | 'concrete' | 'rubber') {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d')!;
  const pixels = context.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fine = hash(x, y);
      const broad = hash(Math.floor(x / 8), Math.floor(y / 8));
      let height: number, roughness: number, shade: number;
      if (kind === 'brushed') {
        // Long machining strokes drive both small normal relief and roughness.
        const stroke = hash(0, y);
        height = 0.48 + (stroke - 0.5) * 0.23 + (fine - 0.5) * 0.035;
        roughness = 0.3 + stroke * 0.6;
        shade = 0.42 + stroke * 0.13;
      } else if (kind === 'rubber') {
        const dx = ((x + 16) % 32) - 16;
        const dy = ((y + 16) % 32) - 16;
        const coin = Math.max(0, Math.min(1, (8.5 - Math.hypot(dx, dy)) / 2));
        height = 0.18 + coin * 0.47 + (fine - 0.5) * 0.06;
        roughness = 0.86 - coin * 0.15 + fine * 0.055;
        shade = 0.5 + coin * 0.12 + (fine - 0.5) * 0.06;
      } else {
        // Aggregates and small pores affect the same three PBR channels.
        const pore = fine < 0.045 ? -0.22 : 0;
        height = 0.5 + (fine - 0.5) * 0.22 + (broad - 0.5) * 0.13 + pore;
        roughness = 0.76 + fine * 0.2 - pore * 0.08;
        shade = 0.5 + (broad - 0.5) * 0.24 + (fine - 0.5) * 0.14 + pore * 0.32;
      }
      const index = (y * size + x) * 4;
      pixels.data[index] = height * 255;
      pixels.data[index + 1] = roughness * 255;
      pixels.data[index + 2] = shade * 255;
      pixels.data[index + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  const map = new CanvasTexture(canvas);
  map.wrapS = map.wrapT = RepeatWrapping;
  map.minFilter = LinearMipmapLinearFilter;
  map.anisotropy = 8;
  map.name = `Seed ${SURFACE_SEED}: ${kind}, 1 m tile`;
  return map;
}

function texturedMaterial(kind: 'brushed' | 'concrete' | 'rubber', color: number, metalness: number, roughMin: number, roughMax: number, relief: number) {
  const map = surfaceField(kind);
  const surface = new MeshStandardNodeMaterial({ color, metalness, roughness: (roughMin + roughMax) / 2 });
  // World units, with the object's translation removed, keep a moving cabin's
  // finish attached to it while avoiding stretched UVs on scaled boxes.
  const coordinates = positionWorld.sub(modelPosition);
  const field = triplanarTexture(texture(map), null, null, float(1), coordinates, normalWorld);
  const colorContrast = kind === 'rubber' ? 0.48 : kind === 'concrete' ? 0.23 : 0.11;
  surface.colorNode = materialColor.rgb.mul(field.b.sub(0.5).mul(colorContrast).add(1));
  const authoredRoughness = field.g.mul(roughMax - roughMin).add(roughMin);
  surface.roughnessNode = authoredRoughness;
  surface.normalNode = bumpMap(field.r, float(relief));
  const authoredColor = surface.colorNode;
  const authoredNormal = surface.normalNode;
  surfaceDiagnostics.set(surface, mode => {
    surface.colorNode = mode === 'height' ? vec3(field.r) : mode === 'roughness' ? vec3(authoredRoughness) : authoredColor;
    surface.roughnessNode = mode === 'off' ? authoredRoughness : float(1);
    surface.metalnessNode = mode === 'off' ? null : float(0);
    surface.normalNode = mode === 'off' ? authoredNormal : null;
    surface.needsUpdate = true;
  });
  surface.userData.surface = { seed: SURFACE_SEED, tileMetres: 1, roughness: [roughMin, roughMax], relief };
  surface.name = kind;
  return surface;
}

export function createSurfaceMaterials() {
  return {
    steel: new MeshStandardMaterial({ color: 0x33434c, metalness: 0.72, roughness: 0.48 }),
    dark: new MeshStandardMaterial({ color: 0x1c282d, metalness: 0.18, roughness: 0.68 }),
    aluminium: texturedMaterial('brushed', 0xc0c8c8, 0.88, 0.28, 0.46, 0.065),
    enamel: new MeshPhysicalMaterial({ color: 0xd8c9ab, metalness: 0.08, roughness: 0.43, clearcoat: 0.22, clearcoatRoughness: 0.38 }),
    ochre: new MeshPhysicalMaterial({ color: 0xb68d53, metalness: 0.08, roughness: 0.46, clearcoat: 0.18, clearcoatRoughness: 0.44 }),
    cream: new MeshStandardMaterial({ color: 0xf0e6d1, metalness: 0.02, roughness: 0.78 }),
    concrete: texturedMaterial('concrete', 0x8b9699, 0, 0.78, 0.96, 0.055),
    rubber: texturedMaterial('rubber', 0x364443, 0, 0.72, 0.94, 0.18),
  };
}

/** A small authored equirectangular sky also supplies reflected light to metal. */
export function createDuskEnvironment() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const context = canvas.getContext('2d')!;
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, '#41566f');
  gradient.addColorStop(0.28, '#7e9ba9');
  gradient.addColorStop(0.475, '#e6c1a0');
  gradient.addColorStop(0.515, '#b6bbc0');
  gradient.addColorStop(0.72, '#697777');
  gradient.addColorStop(1, '#37454c');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  // A broad low sun is intentionally soft so metal reflections remain stable.
  const glow = context.createRadialGradient(205, 217, 8, 205, 217, 100);
  glow.addColorStop(0, 'rgba(255,235,191,0.9)');
  glow.addColorStop(0.24, 'rgba(255,218,161,0.32)');
  glow.addColorStop(1, 'rgba(255,218,161,0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const sky = new CanvasTexture(canvas);
  sky.colorSpace = SRGBColorSpace;
  sky.mapping = EquirectangularReflectionMapping;
  sky.name = 'Procedural dusk sky / reflection environment';
  return { texture: sky, fog: new Color(0xc2b9ae) };
}
