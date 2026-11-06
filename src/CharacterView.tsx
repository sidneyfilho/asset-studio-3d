// Tela "Personagem": o corpo base com as peças de roupa trocáveis (uma por parte), como o guarda-roupa do jogo.
// Mesmo sistema do jogo: cada peça é um .glb com a malha presa ao mesmo esqueleto do corpo; aqui a malha da peça
// é religada aos ossos do corpo pelos nomes, então anima junto. A lista de peças, nomes, cores e o que cada peça
// esconde vêm do catálogo do jogo (scripts/character/outfit_catalog.gd); sem ele, saem dos nomes dos arquivos.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { pathExists, readText, type ModelEntry } from "./api";
import { joinPath, type Workspace } from "./workspace";
import { addLights, frameCamera, loadModel } from "./three/loadModel";
import { getModel } from "./three/modelCache";

export const OUTFIT_DIR = "characters/outfit/";
const CATALOG = "scripts/character/outfit_catalog.gd";

type Item = { id: string; name: string; file: string; hides: string[] };
type Catalog = { slots: string[]; names: Record<string, string>; items: Record<string, Item[]>; colors: Record<string, string[]> };
type Choice = { id: string; color: string };

/** Lê o catálogo do jogo (GDScript) só com o que interessa: slots, nomes, peças e cores */
function parseCatalog(text: string): Catalog | null {
  const block = (name: string) => {
    const i = text.indexOf(`const ${name}`);
    if (i < 0) return "";
    const start = text.indexOf("=", i) + 1;
    let depth = 0, k = start;
    for (; k < text.length; k++) {
      const ch = text[k];
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") { depth--; if (depth === 0) break; }
    }
    return text.slice(start, k + 1);
  };
  const slots = [...block("SLOTS").matchAll(/"(\w+)"/g)].map((m) => m[1]);
  if (!slots.length) return null;
  const names: Record<string, string> = {};
  for (const m of block("SLOT_NAMES").matchAll(/"(\w+)":\s*"([^"]*)"/g)) names[m[1]] = m[2];
  const items: Record<string, Item[]> = {};
  const itemsText = block("ITEMS");
  // cabeçalho de slot = `"pants": [` no fim da linha (o `"hides": [...]` fica no meio da linha da peça)
  const heads = [...itemsText.matchAll(/"(\w+)":\s*\[\s*\n/g)];
  heads.forEach((h, n) => {
    const part = itemsText.slice(h.index!, n + 1 < heads.length ? heads[n + 1].index : undefined);
    items[h[1]] = [...part.matchAll(/\{[^}]*"id":\s*"([^"]+)"[^}]*"name":\s*"([^"]+)"[^}]*"file":\s*"([^"]+)"[^}]*"hides":\s*\[([^\]]*)\][^}]*\}/g)].map(
      (m) => ({ id: m[1], name: m[2], file: m[3], hides: [...m[4].matchAll(/"([^"]+)"/g)].map((x) => x[1]) }),
    );
  });
  const colors: Record<string, string[]> = {};
  for (const line of block("COLORS").split("\n")) {
    const m = line.match(/"(\w+)":\s*\[(.*)\]/);
    if (!m) continue;
    colors[m[1]] = [...m[2].matchAll(/Color\.WHITE|Color\("([^"]+)"\)/g)].map((c) => (c[1] ? c[1] : "#ffffff"));
  }
  return { slots, names, items, colors };
}

/** Sem catálogo: slot = nome do arquivo antes do primeiro "_" (ex.: hair_bun.glb -> cabelo "bun") */
function catalogFromFiles(files: string[]): Catalog {
  const items: Record<string, Item[]> = {};
  for (const f of files) {
    const base = f.replace(/\.(glb|gltf)$/i, "");
    if (base === "body" || !base.includes("_")) continue;
    const slot = base.slice(0, base.indexOf("_")), id = base.slice(base.indexOf("_") + 1);
    (items[slot] ??= []).push({ id, name: id, file: f, hides: [] });
  }
  return { slots: Object.keys(items), names: {}, items, colors: {} };
}

/** Esconde (ou mostra) os nós com um destes nomes; malhas com vários materiais viram um grupo com o nome */
function setNamedVisible(root: THREE.Object3D, names: Set<string>, visible: boolean) {
  root.traverse((o) => {
    if (names.has(o.name)) o.visible = visible;
  });
}

export default function CharacterView({ ws, models, onClose }: { ws: Workspace; models: ModelEntry[]; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [fromGame, setFromGame] = useState(false);
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [anims, setAnims] = useState<string[]>([]);
  const [anim, setAnim] = useState("Idle");
  const [error, setError] = useState<string | null>(null);
  const stage = useRef<{ root: THREE.Object3D; bones: Map<string, THREE.Bone>; parent: THREE.Object3D; mixer: THREE.AnimationMixer; clips: THREE.AnimationClip[] } | null>(null);
  const [ready, setReady] = useState(0);
  const equipped = useRef<Record<string, { id: string; meshes: THREE.Object3D[] }>>({});

  const outfitFiles = useMemo(() => models.filter((m) => m.rel.startsWith(OUTFIT_DIR)).map((m) => m.rel.slice(OUTFIT_DIR.length)), [models]);
  const absOf = (file: string) => joinPath(ws.assets, OUTFIT_DIR + file);

  // catálogo do jogo, ou os arquivos da pasta
  useEffect(() => {
    (async () => {
      const p = joinPath(ws.godot, CATALOG);
      let c: Catalog | null = null;
      if (await pathExists(p)) c = parseCatalog(await readText(p));
      setFromGame(Boolean(c));
      c = c ?? catalogFromFiles(outfitFiles);
      setCatalog(c);
      const first: Record<string, Choice> = {};
      for (const s of c.slots) if (c.items[s]?.length) first[s] = { id: c.items[s][0].id, color: "#ffffff" };
      setChoice(first);
    })().catch((e) => setError(String(e)));
  }, [ws.godot, outfitFiles.join(",")]);

  // cena 3D com o corpo base
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x2a2d33);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    addLights(scene);
    scene.add(new THREE.GridHelper(10, 5, 0x8a8f99, 0x4a4e57));
    const cam = new THREE.PerspectiveCamera(32, 1, 0.01, 200);
    const controls = new OrbitControls(cam, renderer.domElement);
    controls.enableDamping = true;
    const clock = new THREE.Clock();
    let alive = true;
    const resize = () => {
      renderer.setSize(el.clientWidth, el.clientHeight);
      cam.aspect = el.clientWidth / Math.max(el.clientHeight, 1);
      cam.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    renderer.setAnimationLoop(() => {
      stage.current?.mixer.update(clock.getDelta());
      controls.update();
      renderer.render(scene, cam);
    });
    loadModel(absOf("body.glb"))
      .then((gltf) => {
        if (!alive) return;
        const root = gltf.scene;
        scene.add(root);
        let parent: THREE.Object3D = root;
        const bones = new Map<string, THREE.Bone>();
        root.traverse((o) => {
          if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone);
          if ((o as THREE.SkinnedMesh).isSkinnedMesh && parent === root) parent = o.parent ?? root;
        });
        stage.current = { root, bones, parent, mixer: new THREE.AnimationMixer(root), clips: gltf.animations };
        setAnims(gltf.animations.map((a) => a.name));
        const box = new THREE.Box3().setFromObject(root);
        controls.target.copy(frameCamera(cam, box, 12, 20));
        setReady((n) => n + 1);
      })
      .catch((e) => alive && setError(`corpo base (${OUTFIT_DIR}body.glb): ${e?.message ?? e}`));
    return () => {
      alive = false;
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      stage.current = null;
      equipped.current = {};
    };
  }, [ws.assets]);

  // animação
  useEffect(() => {
    const st = stage.current;
    if (!st) return;
    st.mixer.stopAllAction();
    const clip = st.clips.find((c) => c.name === anim);
    if (clip) st.mixer.clipAction(clip).play();
  }, [anim, ready]);

  // veste as peças escolhidas: troca só o slot que mudou; depois aplica as cores e o que cada peça esconde
  useEffect(() => {
    const st = stage.current;
    if (!st || !catalog) return;
    let cancelled = false;
    (async () => {
      for (const slot of catalog.slots) {
        const want = choice[slot]?.id ?? "";
        const cur = equipped.current[slot];
        if (cur && cur.id === want) continue;
        for (const m of cur?.meshes ?? []) m.removeFromParent();
        delete equipped.current[slot];
        const item = catalog.items[slot]?.find((i) => i.id === want);
        if (!item) continue;
        const src = await getModel(absOf(item.file));
        if (cancelled || stage.current !== st) return;
        const piece = cloneSkinned(src);
        const meshes: THREE.Object3D[] = [];
        piece.traverse((o) => {
          const sm = o as THREE.SkinnedMesh;
          if (!sm.isSkinnedMesh) return;
          // religa aos ossos do corpo pelo nome (mesmo esqueleto, mesma pose de repouso)
          const bones = sm.skeleton.bones.map((b) => st.bones.get(b.name) ?? b);
          sm.bind(new THREE.Skeleton(bones, sm.skeleton.boneInverses), sm.bindMatrix);
          // materiais próprios, para a cor não pintar outras cópias
          sm.material = Array.isArray(sm.material) ? sm.material.map((m) => m.clone()) : sm.material.clone();
          sm.userData.baseColors = (Array.isArray(sm.material) ? sm.material : [sm.material]).map((m) => (m as THREE.MeshStandardMaterial).color?.clone());
          meshes.push(sm);
        });
        // o nome do nó acima da malha (grupo de vários materiais) vale para o "esconde"
        for (const m of meshes) {
          const holder = new THREE.Group();
          holder.name = m.parent && m.parent !== piece && !(m.parent as THREE.Bone).isBone ? m.parent.name : m.name;
          holder.add(m);
          st.parent.add(holder);
          meshes[meshes.indexOf(m)] = holder;
        }
        equipped.current[slot] = { id: want, meshes };
      }
      // cores (multiplicam a cor original, como no jogo)
      for (const slot of catalog.slots) {
        const col = new THREE.Color(choice[slot]?.color ?? "#ffffff");
        for (const h of equipped.current[slot]?.meshes ?? []) {
          h.traverse((o) => {
            const sm = o as THREE.SkinnedMesh;
            if (!sm.isSkinnedMesh) return;
            const mats = Array.isArray(sm.material) ? sm.material : [sm.material];
            mats.forEach((m, k) => {
              const base = (sm.userData.baseColors as (THREE.Color | undefined)[])[k];
              if (base && (m as THREE.MeshStandardMaterial).color) (m as THREE.MeshStandardMaterial).color.copy(base).multiply(col);
            });
          });
        }
      }
      // o que as peças vestidas escondem (partes do corpo ou de outras peças)
      const all = new Set<string>();
      for (const s of catalog.slots) for (const i of catalog.items[s] ?? []) i.hides.forEach((h) => all.add(h));
      setNamedVisible(st.root, all, true);
      const hide = new Set<string>();
      for (const s of catalog.slots) catalog.items[s]?.find((i) => i.id === choice[s]?.id)?.hides.forEach((h) => hide.add(h));
      setNamedVisible(st.root, hide, false);
    })().catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [choice, catalog, ready]);

  const setSlot = (slot: string, patch: Partial<Choice>) =>
    setChoice((c) => ({ ...c, [slot]: { id: c[slot]?.id ?? "", color: c[slot]?.color ?? "#ffffff", ...patch } }));

  return (
    <div className="dress">
      <header>
        <button onClick={onClose}>← Voltar</button>
        <strong>Personagem</strong>
        <span className="muted small">
          {fromGame ? `peças do catálogo do jogo (${CATALOG})` : `peças da pasta ${OUTFIT_DIR} (sem o catálogo do jogo)`}
        </span>
        <span className="spacer" />
        <label className="inline">
          Animação
          <select value={anim} onChange={(e) => setAnim(e.target.value)}>
            {anims.map((a) => <option key={a}>{a}</option>)}
          </select>
        </label>
      </header>
      <aside className="dress-panel">
        {catalog?.slots.map((slot) => (
          <div key={slot} className="slot">
            <h4>{catalog.names[slot] ?? slot}</h4>
            <select value={choice[slot]?.id ?? ""} onChange={(e) => setSlot(slot, { id: e.target.value })}>
              <option value="">(nenhuma)</option>
              {(catalog.items[slot] ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
            <div className="swatches">
              {(catalog.colors[slot]?.length ? catalog.colors[slot] : ["#ffffff"]).map((c) => (
                <button key={c} className={(choice[slot]?.color ?? "#ffffff") === c ? "swatch on" : "swatch"} style={{ background: c }}
                  title={c === "#ffffff" ? "cor original" : c} onClick={() => setSlot(slot, { color: c })} />
              ))}
              <input type="color" value={choice[slot]?.color ?? "#ffffff"} onChange={(e) => setSlot(slot, { color: e.target.value })} title="outra cor" />
            </div>
          </div>
        ))}
        {error && <div className="error">{error}</div>}
        <div className="muted small">
          Botão esquerdo gira, direito arrasta, roda dá zoom. Peça nova: grave o .glb em {OUTFIT_DIR} (mesmo esqueleto do corpo) e
          acrescente no catálogo do jogo.
        </div>
      </aside>
      <div className="dress-view" ref={host} />
    </div>
  );
}
