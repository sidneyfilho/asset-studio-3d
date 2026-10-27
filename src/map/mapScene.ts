// Parte 3D do editor de mapa (three.js): chão com grade, objetos colocados, "fantasma" do objeto
// que vai ser colocado e a seta de mover. Os dados do mapa ficam no React; aqui só se desenha
// e se avisa o que o mouse fez (colocar, selecionar, mover).
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { addLights } from "../three/loadModel";
import { getModel, instanceModel } from "../three/modelCache";
import type { MapInstance, ScatterLayer } from "./mapFile";

export type Snap = "cell" | "half" | "free";

type Callbacks = {
  onPlace: (pos: [number, number, number]) => void;
  onPick: (id: string | null) => void;
  onMove: (id: string, pos: [number, number, number], rotY: number) => void;
  /** pincel: começo do traço, cada "carimbo" (x, z no chão; erase = apagar) e fim do traço */
  onBrushStart: () => void;
  onPaint: (x: number, z: number, erase: boolean) => void;
  onBrushEnd: () => void;
};

export type GizmoMode = "translate" | "rotate";

/** Sólida no jogo se a malha (ou o nó acima dela dentro do modelo: malhas com vários materiais viram um grupo) tem o nome certo */
function isSolid(o: THREE.Object3D, stop: THREE.Object3D, prefixes: string[]): boolean {
  for (let n: THREE.Object3D | null = o; n && n !== stop; n = n.parent) if (prefixes.some((p) => n!.name.startsWith(p))) return true;
  return false;
}

const GROUND = 400; // tamanho do chão desenhado, em metros

export class MapScene {
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(32, 1, 0.1, 2000);
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private ground: THREE.Mesh;
  private grid: THREE.GridHelper;
  private ray = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private objects = new Map<string, { group: THREE.Group; model: string; locked: boolean }>();
  private ghost: THREE.Group | null = null;
  private ghostModel = "";
  private ghostToken = 0;
  private selected: string | null = null;
  private selBox = new THREE.BoxHelper(new THREE.Object3D(), 0xd9a35b);
  private dragging = false;
  private downAt: { x: number; y: number } | null = null;
  private dragStart = new THREE.Vector3();
  private ro: ResizeObserver;
  // camadas espalhadas: uma InstancedMesh por malha do modelo (desenha milhares de cópias de uma vez)
  private layers = new Map<string, { points: unknown; group: THREE.Group; token: number }>();
  // pincel
  private brushRadius = 0;
  private ring: THREE.Mesh;
  private painting = false;
  private lastStamp: THREE.Vector3 | null = null;
  snap: Snap = "cell";
  cell = 2;

  constructor(private el: HTMLElement, private absOf: (rel: string) => string, private cb: Callbacks) {
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x9fb8cc);
    el.appendChild(this.renderer.domElement);
    addLights(this.scene);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND, GROUND).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x7f9a5c }),
    );
    this.scene.add(this.ground);
    this.grid = new THREE.GridHelper(GROUND, GROUND / this.cell, 0x4d5e38, 0x6a8250);
    this.grid.position.y = 0.01;
    this.scene.add(this.grid);
    this.selBox.visible = false;
    this.scene.add(this.selBox);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false }),
    );
    this.ring.visible = false;
    this.ring.renderOrder = 10;
    this.scene.add(this.ring);

    // câmera como a do jogo: 30° de elevação e 30° de giro; botão direito gira, do meio arrasta, roda dá zoom
    const a = THREE.MathUtils.degToRad(30), d = 40;
    this.cam.position.set(d * Math.cos(a) * Math.sin(a), d * Math.sin(a), d * Math.cos(a) * Math.cos(a));
    this.orbit = new OrbitControls(this.cam, this.renderer.domElement);
    this.orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.orbit.maxPolarAngle = THREE.MathUtils.degToRad(85);
    this.orbit.enableDamping = true;
    this.orbit.update();

    // setas do objeto selecionado: modo "mover" (x, z e a seta verde de subir/descer) ou "girar" (só em volta do eixo vertical)
    this.gizmo = new TransformControls(this.cam, this.renderer.domElement);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.dragging = Boolean(e.value);
      this.orbit.enabled = !this.dragging;
      const o = this.gizmo.object;
      if (this.dragging && o) this.dragStart = o.position.clone();
      const id = this.selected;
      if (!this.dragging && id && o) {
        const p = o.position;
        this.cb.onMove(id, [p.x, p.y, p.z], THREE.MathUtils.radToDeg(o.rotation.y));
      }
    });
    // o encaixe ao arrastar anda em passos a partir de onde a peça estava (não puxa para o centro da célula)
    this.gizmo.addEventListener("objectChange", () => {
      const o = this.gizmo.object;
      if (o && this.gizmo.mode === "translate") {
        const step = this.snap === "cell" ? this.cell : this.snap === "half" ? 0.5 : 0;
        const ystep = this.snap === "free" ? 0 : 0.05;
        const s = this.dragStart;
        const q = (v: number, v0: number, st: number) => (st ? v0 + Math.round((v - v0) / st) * st : v);
        o.position.set(q(o.position.x, s.x, step), q(o.position.y, s.y, ystep), q(o.position.z, s.z, step));
      }
      this.selBox.update();
    });
    this.setMode("translate");
    this.scene.add(this.gizmo.getHelper());

    const c = this.renderer.domElement;
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("contextmenu", (e) => e.preventDefault());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.orbit.update();
      this.renderer.render(this.scene, this.cam);
    });
  }

  /** Mover (x, z e altura) ou girar (em volta do eixo vertical, de 15 em 15° com encaixe) */
  setMode(mode: GizmoMode) {
    this.gizmo.setMode(mode);
    const rotate = mode === "rotate";
    this.gizmo.showX = !rotate;
    this.gizmo.showZ = !rotate;
    this.gizmo.showY = true;
    this.gizmo.setRotationSnap(rotate && this.snap !== "free" ? THREE.MathUtils.degToRad(15) : null);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.renderer.dispose();
    this.el.removeChild(this.renderer.domElement);
  }

  private resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    this.renderer.setSize(w, h);
    this.cam.aspect = w / Math.max(h, 1);
    this.cam.updateProjectionMatrix();
  }

  /** Encaixe: centro da célula (peças do kit), meio metro, ou livre */
  private snapPoint(p: THREE.Vector3): THREE.Vector3 {
    if (this.snap === "cell") {
      const c = this.cell;
      return new THREE.Vector3(Math.floor(p.x / c) * c + c / 2, p.y, Math.floor(p.z / c) * c + c / 2);
    }
    if (this.snap === "half") return new THREE.Vector3(Math.round(p.x * 2) / 2, p.y, Math.round(p.z * 2) / 2);
    return p.clone();
  }

  private groundPoint(e: PointerEvent): THREE.Vector3 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    // garante a câmera atualizada mesmo se ainda não houve um quadro desenhado
    this.cam.updateMatrixWorld();
    this.ray.setFromCamera(this.mouse, this.cam);
    const hit = this.ray.intersectObject(this.ground)[0];
    return hit ? hit.point : null;
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.brushRadius > 0) {
      const p = this.groundPoint(e);
      this.ring.visible = Boolean(p);
      if (p) {
        this.ring.position.set(p.x, 0.03, p.z);
        // novo carimbo quando o mouse andou um pedaço do raio
        if (this.painting && (!this.lastStamp || this.lastStamp.distanceTo(p) > this.brushRadius * 0.35)) this.stamp(p, e.shiftKey);
      }
      return;
    }
    if (!this.ghost) return;
    const p = this.groundPoint(e);
    if (p) {
      const s = this.snapPoint(p);
      this.ghost.position.set(s.x, 0, s.z);
      this.ghost.visible = true;
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    if (this.brushRadius > 0 && e.button === 0) {
      const p = this.groundPoint(e);
      if (!p) return;
      this.painting = true;
      this.orbit.enabled = false;
      this.cb.onBrushStart();
      this.stamp(p, e.shiftKey);
      return;
    }
    this.downAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };

  private stamp(p: THREE.Vector3, erase: boolean) {
    this.lastStamp = p.clone();
    this.cb.onPaint(p.x, p.z, erase);
  }

  /** Liga o pincel (raio em metros) ou desliga (0) */
  setBrush(radius: number) {
    this.brushRadius = radius;
    this.ring.scale.setScalar(Math.max(radius, 0.01));
    if (!radius) this.ring.visible = false;
  }

  // clique = apertar e soltar sem arrastar; arrastar a seta de mover não conta como clique
  private onPointerUp = (e: PointerEvent) => {
    if (this.painting) {
      this.painting = false;
      this.lastStamp = null;
      this.orbit.enabled = true;
      this.cb.onBrushEnd();
      return;
    }
    const d = this.downAt;
    this.downAt = null;
    if (!d || e.button !== 0 || this.dragging || this.gizmo.axis) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    if (this.ghost) {
      const p = this.groundPoint(e);
      if (p) {
        const s = this.snapPoint(p);
        this.cb.onPlace([s.x, 0, s.z]);
      }
      return;
    }
    this.cb.onPick(this.pick(e));
  };

  private pick(e: PointerEvent): string | null {
    const groups = [...this.objects.values()].filter((o) => !o.locked && o.group.visible).map((o) => o.group);
    this.groundPoint(e); // atualiza o raio
    for (const hit of this.ray.intersectObjects(groups, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o && !o.userData.instId) o = o.parent;
      if (o) return o.userData.instId as string;
    }
    return null;
  }

  /** Deixa a cena igual à lista de objetos do mapa (cria, apaga e reposiciona o que mudou) */
  setInstances(list: MapInstance[]) {
    const keep = new Set(list.map((i) => i.id));
    for (const [id, o] of this.objects) {
      if (!keep.has(id)) {
        if (this.gizmo.object === o.group) this.gizmo.detach();
        this.scene.remove(o.group);
        this.objects.delete(id);
      }
    }
    for (const i of list) {
      let o = this.objects.get(i.id);
      if (!o || o.model !== i.model) {
        if (o) this.scene.remove(o.group);
        const group = new THREE.Group();
        group.userData.instId = i.id;
        this.scene.add(group);
        o = { group, model: i.model, locked: false };
        this.objects.set(i.id, o);
        instanceModel(this.absOf(i.model))
          .then((m) => {
            group.add(m);
            this.applyCollision(group);
            if (this.selected === i.id) this.selBox.setFromObject(group);
          })
          .catch(() => group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true }))));
      }
      o.locked = Boolean(i.locked);
      if (this.gizmo.object !== o.group || !this.dragging) {
        o.group.position.set(...i.pos);
        o.group.rotation.y = THREE.MathUtils.degToRad(i.rotY);
        o.group.scale.setScalar(i.scale);
      }
    }
    this.setSelected(this.selected && keep.has(this.selected) ? this.selected : null);
  }

  /** Peças escondidas só no editor (para ver e editar dentro da casa); não somem do mapa */
  setHidden(ids: Set<string>) {
    for (const [id, o] of this.objects) o.group.visible = !ids.has(id);
  }

  setSelected(id: string | null) {
    this.selected = id;
    const g = id ? this.objects.get(id)?.group : undefined;
    if (g) {
      if (this.objects.get(id!)!.locked) this.gizmo.detach();
      else this.gizmo.attach(g);
      this.selBox.setFromObject(g);
      this.selBox.visible = true;
    } else {
      this.gizmo.detach();
      this.selBox.visible = false;
    }
  }

  /** Objeto "fantasma" que segue o mouse enquanto se escolhe onde colocar */
  async setGhost(model: string | null, rotY: number) {
    if (model === this.ghostModel && this.ghost) {
      this.ghost.rotation.y = THREE.MathUtils.degToRad(rotY);
      return;
    }
    const token = ++this.ghostToken;
    if (this.ghost) this.scene.remove(this.ghost);
    this.ghost = null;
    this.ghostModel = model ?? "";
    if (!model) return;
    const g = new THREE.Group();
    g.visible = false;
    g.rotation.y = THREE.MathUtils.degToRad(rotY);
    this.ghost = g;
    this.scene.add(g);
    try {
      const m = await instanceModel(this.absOf(model));
      if (token === this.ghostToken) g.add(m);
    } catch {
      // modelo com erro: o fantasma fica vazio
    }
  }

  /** Deixa as camadas espalhadas iguais às do mapa (refaz só a camada cujos pontos mudaram) */
  setScatter(list: ScatterLayer[]) {
    const keep = new Set(list.map((l) => l.id));
    for (const [id, l] of this.layers) {
      if (!keep.has(id)) {
        this.scene.remove(l.group);
        this.layers.delete(id);
      }
    }
    for (const l of list) {
      let cur = this.layers.get(l.id);
      if (cur && cur.points === l.points) continue;
      if (!cur) {
        cur = { points: null, group: new THREE.Group(), token: 0 };
        this.scene.add(cur.group);
        this.layers.set(l.id, cur);
      }
      cur.points = l.points;
      const token = ++cur.token;
      const entry = cur;
      getModel(this.absOf(l.model)).then((model) => {
        if (token !== entry.token) return;
        model.updateMatrixWorld(true);
        const g = new THREE.Group();
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        model.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, Math.max(1, l.points.length));
          im.count = l.points.length;
          l.points.forEach(([x, z, rot, sc], k) => {
            m.compose(pos.set(x, 0, z), q.setFromAxisAngle(up, THREE.MathUtils.degToRad(rot)), s.setScalar(sc));
            im.setMatrixAt(k, m.multiply(mesh.matrixWorld));
          });
          im.instanceMatrix.needsUpdate = true;
          im.computeBoundingSphere();
          g.add(im);
        });
        entry.group.clear();
        entry.group.add(g);
      }).catch(() => undefined);
    }
  }

  /** Mostra em vermelho (aramado) as malhas sólidas no jogo, pelo nome; desligado com prefixes = null */
  setCollisionView(prefixes: string[] | null) {
    this.solid = prefixes;
    for (const o of this.objects.values()) this.applyCollision(o.group);
  }

  private solid: string[] | null = null;
  private wireMat = new THREE.MeshBasicMaterial({ color: 0xff4a3a, wireframe: true, transparent: true, opacity: 0.55 });

  private applyCollision(group: THREE.Object3D) {
    const old: THREE.Object3D[] = [];
    group.traverse((o) => o.userData.collisionWire && old.push(o));
    for (const o of old) o.removeFromParent();
    if (!this.solid) return;
    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
    for (const m of meshes) {
      if (!isSolid(m, group, this.solid)) continue;
      const w = new THREE.Mesh(m.geometry, this.wireMat);
      w.userData.collisionWire = true;
      w.raycast = () => undefined;   // o aramado não atrapalha o clique
      m.add(w);
    }
  }

  /** Altura do topo do objeto (m) e se ele tem alguma malha sólida no jogo */
  info(id: string, prefixes: string[]): { top: number; base: number; solid: boolean } | null {
    const g = this.objects.get(id)?.group;
    if (!g || !g.children.length) return null;
    const box = new THREE.Box3().setFromObject(g);
    let solid = false;
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !o.userData.collisionWire && isSolid(o, g, prefixes)) solid = true;
    });
    return { top: box.max.y, base: box.min.y, solid };
  }

  setCell(cell: number) {
    this.cell = cell;
    this.scene.remove(this.grid);
    this.grid = new THREE.GridHelper(GROUND, GROUND / cell, 0x4d5e38, 0x6a8250);
    this.grid.position.y = 0.01;
    this.scene.add(this.grid);
  }
}
