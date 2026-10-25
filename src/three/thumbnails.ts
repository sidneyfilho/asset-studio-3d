// Gera as miniaturas dos modelos, uma de cada vez, num único renderizador fora da tela.
// A imagem fica no cache do app (lado Rust); da próxima vez ela só é lida do disco.
import * as THREE from "three";
import { getThumb, saveThumb, fileUrl, type ModelEntry } from "../api";
import { loadModel, disposeObject, addLights, frameCamera } from "./loadModel";

const SIZE = 192;
let renderer: THREE.WebGLRenderer | null = null;

type Job = { model: ModelEntry; signal: AbortSignal; ok: (url: string) => void; fail: (e: unknown) => void };
const pending: Job[] = [];
let running = false;

function getRenderer() {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(SIZE, SIZE);
    renderer.setClearColor(0x000000, 0);
  }
  return renderer;
}

async function render(m: ModelEntry): Promise<string> {
  const gltf = await loadModel(m.abs);
  const scene = new THREE.Scene();
  addLights(scene);
  scene.add(gltf.scene);
  const cam = new THREE.PerspectiveCamera(30, 1);
  frameCamera(cam, new THREE.Box3().setFromObject(gltf.scene));
  const r = getRenderer();
  r.render(scene, cam);
  const blob = await new Promise<Blob>((ok, fail) => r.domElement.toBlob((b) => (b ? ok(b) : fail(new Error("toBlob"))), "image/png"));
  disposeObject(gltf.scene);
  const path = await saveThumb(m, new Uint8Array(await blob.arrayBuffer()));
  return fileUrl(path);
}

// Processa a fila; pedidos cancelados (cartão que saiu da tela, outra pasta aberta) são pulados.
async function pump() {
  if (running) return;
  running = true;
  while (pending.length) {
    const job = pending.shift()!;
    if (job.signal.aborted) continue;
    try {
      job.ok(await render(job.model));
    } catch (e) {
      job.fail(e);
    }
  }
  running = false;
}

/** URL da miniatura do modelo; gera se ainda não existir (na fila, para não travar a janela) */
export async function thumbnailFor(m: ModelEntry, signal: AbortSignal): Promise<string> {
  const cached = await getThumb(m);
  if (cached) return fileUrl(cached);
  return new Promise((ok, fail) => {
    pending.push({ model: m, signal, ok, fail });
    pump();
  });
}
