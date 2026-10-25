// Visualizador 3D do modelo selecionado: girar com o botão esquerdo, arrastar com o direito, zoom na roda.
// A grade do chão tem células de 2 m (o padrão do kit do Alvorland) para conferir o tamanho das peças.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ModelEntry } from "./api";
import { loadModel, disposeObject, addLights, frameCamera } from "./three/loadModel";

export const CELL = 2; // tamanho da célula do GridMap, em metros

type Stats = {
  size: THREE.Vector3;
  min: THREE.Vector3;
  triangles: number;
  meshes: number;
  materials: string[];
  animations: string[];
};

export default function Viewer({ model }: { model: ModelEntry }) {
  const host = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anim, setAnim] = useState<string>("");
  const playRef = useRef<(name: string) => void>(() => {});

  useEffect(() => {
    const el = host.current!;
    setStats(null);
    setError(null);
    setAnim("");
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x2a2d33);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    addLights(scene);
    scene.add(new THREE.GridHelper(20 * CELL, 20, 0x8a8f99, 0x4a4e57));
    scene.add(new THREE.AxesHelper(1));
    const cam = new THREE.PerspectiveCamera(32, 1, 0.01, 1000);
    const controls = new OrbitControls(cam, renderer.domElement);
    controls.enableDamping = true;
    const clock = new THREE.Clock();
    let mixer: THREE.AnimationMixer | null = null;
    let root: THREE.Object3D | null = null;
    let alive = true;

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h);
      cam.aspect = w / Math.max(h, 1);
      cam.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    renderer.setAnimationLoop(() => {
      mixer?.update(clock.getDelta());
      controls.update();
      renderer.render(scene, cam);
    });

    loadModel(model.abs)
      .then((gltf) => {
        if (!alive) return disposeObject(gltf.scene);
        root = gltf.scene;
        scene.add(root);
        const box = new THREE.Box3().setFromObject(root);
        controls.target.copy(frameCamera(cam, box));
        let triangles = 0, meshes = 0;
        const mats = new Set<string>();
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          meshes++;
          const g = m.geometry;
          triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
          for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mat.name || "(sem nome)");
        });
        if (gltf.animations.length) {
          const mx = new THREE.AnimationMixer(root);
          mixer = mx;
          playRef.current = (name) => {
            mx.stopAllAction();
            const clip = gltf.animations.find((a) => a.name === name);
            if (clip) mx.clipAction(clip).play();
          };
        }
        setStats({
          size: box.getSize(new THREE.Vector3()),
          min: box.min.clone(),
          triangles: Math.round(triangles),
          meshes,
          materials: [...mats],
          animations: gltf.animations.map((a) => a.name),
        });
      })
      .catch((e) => alive && setError(String(e?.message ?? e)));

    return () => {
      alive = false;
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls.dispose();
      if (root) disposeObject(root);
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [model.abs, model.mtime]);

  const f = (n: number) => n.toFixed(2).replace(".", ",");
  return (
    <div className="viewer">
      <div className="viewer-canvas" ref={host} />
      <div className="viewer-info">
        <h3 title={model.rel}>{model.rel.split("/").pop()}</h3>
        <div className="muted">{model.rel}</div>
        {error && <div className="error">Erro ao abrir: {error}</div>}
        {stats && (
          <table>
            <tbody>
              <tr><td>Tamanho (L x A x P)</td><td>{f(stats.size.x)} x {f(stats.size.y)} x {f(stats.size.z)} m</td></tr>
              <tr><td>Em células de {CELL} m</td><td>{f(stats.size.x / CELL)} x {f(stats.size.z / CELL)}</td></tr>
              <tr><td>Base (y mínimo)</td><td>{f(stats.min.y)} m {Math.abs(stats.min.y) > 0.01 && <span className="warn">(não está no chão)</span>}</td></tr>
              <tr><td>Triângulos</td><td>{stats.triangles.toLocaleString("pt-BR")}</td></tr>
              <tr><td>Malhas</td><td>{stats.meshes}</td></tr>
              <tr><td>Materiais</td><td>{stats.materials.join(", ")}</td></tr>
              <tr><td>Arquivo</td><td>{(model.size / 1024).toFixed(0)} KB</td></tr>
              {stats.animations.length > 0 && (
                <tr>
                  <td>Animações</td>
                  <td>
                    <select value={anim} onChange={(e) => { setAnim(e.target.value); playRef.current(e.target.value); }}>
                      <option value="">(parado)</option>
                      {stats.animations.map((a) => <option key={a}>{a}</option>)}
                    </select>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
