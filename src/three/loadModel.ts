// Carrega um .glb/.gltf do disco com o three.js.
// Texturas externas (ex.: Kenney usa "Textures/colormap.png") são resolvidas a partir da pasta do modelo.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { fileUrl } from "../api";

const manager = new THREE.LoadingManager();
// caminhos do disco viram URL do protocolo asset; URLs de verdade (blob/data/http) passam direto
// (texturas compartilhadas vêm como "../tex/x.jpg": os ".." são resolvidos antes, para o caminho ficar limpo)
manager.setURLModifier((url) => (/^(blob:|data:|https?:)/.test(url) ? url : fileUrl(normalizePath(decodeURI(url)))));

function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, "/").split("/")) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  return out.join("/");
}
const loader = new GLTFLoader(manager);

export async function loadModel(abs: string): Promise<GLTF> {
  const data = await fetch(fileUrl(abs)).then((r) => {
    if (!r.ok) throw new Error(`não consegui ler ${abs}`);
    return r.arrayBuffer();
  });
  const dir = abs.replace(/\\/g, "/").replace(/[^/]*$/, "");
  return loader.parseAsync(data, dir);
}

/** Libera da memória da placa de vídeo tudo o que o modelo usa */
export function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}

/** Luz parecida com a do jogo: céu + sol vindo da frente-esquerda */
export function addLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x5a5040, 1.6));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
  sun.position.set(-4, 8, 6);
  scene.add(sun);
}

/** Posiciona a câmera para o modelo caber inteiro, olhando como a câmera do jogo (30° de elevação, 30° de giro) */
export function frameCamera(cam: THREE.PerspectiveCamera, box: THREE.Box3, pitchDeg = 30, yawDeg = 30) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.01);
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2));
  const p = THREE.MathUtils.degToRad(pitchDeg);
  const y = THREE.MathUtils.degToRad(yawDeg);
  cam.position.set(
    center.x + dist * Math.cos(p) * Math.sin(y),
    center.y + dist * Math.sin(p),
    center.z + dist * Math.cos(p) * Math.cos(y),
  );
  cam.near = dist / 100;
  cam.far = dist * 10;
  cam.lookAt(center);
  cam.updateProjectionMatrix();
  return center;
}
