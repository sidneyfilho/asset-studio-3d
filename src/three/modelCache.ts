// Cada modelo é lido do disco uma vez só; o mapa usa cópias (clone) para cada objeto colocado.
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { loadModel } from "./loadModel";

const cache = new Map<string, Promise<THREE.Object3D>>();

export function getModel(abs: string): Promise<THREE.Object3D> {
  let p = cache.get(abs);
  if (!p) {
    p = loadModel(abs).then((g) => g.scene);
    p.catch(() => cache.delete(abs));
    cache.set(abs, p);
  }
  return p;
}

/** Cópia do modelo; a malha e os materiais são compartilhados com o original */
export async function instanceModel(abs: string): Promise<THREE.Object3D> {
  return cloneSkinned(await getModel(abs));
}
