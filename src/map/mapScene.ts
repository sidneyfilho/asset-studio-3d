// Parte 3D do editor de mapa (three.js): chão com grade, objetos colocados, "fantasma" do objeto
// que vai ser colocado e a seta de mover. Os dados do mapa ficam no React; aqui só se desenha
// e se avisa o que o mouse fez (colocar, selecionar, mover).
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { addLights } from "../three/loadModel";
import { getModel, instanceModel } from "../three/modelCache";
import type { MapInstance, ScatterLayer } from "./mapFile";
import { solidType, type BlocksData, type Box3 } from "./blocks";
import type { Profile } from "../blocks/catalog";
import { footprint, tagColor, yRange, type Area, type WorldBox } from "../blocks/areas";

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

/** Resolve o perfil de colisão de um modelo (com o override da instância); null = sem catálogo */
export type SolidResolver = (model: string, override?: string) => Profile | null;

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
  private objects = new Map<string, { group: THREE.Group; model: string; locked: boolean; collision?: string }>();
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
    // o chão do editor fica um pouco abaixo do nível zero: o lago do mapa (água em -0,04 m) aparece por cima dele em vez de ficar escondido
    this.ground.position.y = -0.06;
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
  /** Escolher um ponto no chão (ajustes dos bloqueios): o próximo clique chama cb e desliga; null cancela */
  setPickPoint(cb: ((x: number, z: number) => void) | null) {
    this.pickCb = cb;
    this.renderer.domElement.style.cursor = cb ? "crosshair" : "";
  }

  private pickCb: ((x: number, z: number) => void) | null = null;

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
    if (this.pickCb) {
      const p = this.groundPoint(e);
      if (p) {
        const cb = this.pickCb;
        this.setPickPoint(null);
        cb(Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10);
      }
      return;
    }
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
        o = { group, model: i.model, locked: false, collision: i.collision };
        this.objects.set(i.id, o);
        instanceModel(this.absOf(i.model))
          .then((m) => {
            group.add(m);
            this.applyCollision(group, i.model, this.objects.get(i.id)?.collision);
            if (this.selected === i.id) this.selBox.setFromObject(group);
          })
          .catch(() => group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true }))));
      }
      o.locked = Boolean(i.locked);
      if (o.collision !== i.collision) {
        o.collision = i.collision;
        this.applyCollision(o.group, o.model, o.collision);
      }
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

  /** Mostra em vermelho (aramado) a colisão de cada objeto, pelo perfil do catálogo; desligado com resolve = null */
  setCollisionView(resolve: SolidResolver | null) {
    this.solid = resolve;
    for (const o of this.objects.values()) this.applyCollision(o.group, o.model, o.collision);
  }

  private solid: SolidResolver | null = null;
  private wireMat = new THREE.MeshBasicMaterial({ color: 0xff4a3a, wireframe: true, transparent: true, opacity: 0.55 });

  /** Caixa do modelo no espaço do objeto (sem a escala da instância) */
  private localBox(group: THREE.Object3D): THREE.Box3 {
    group.updateMatrixWorld(true);
    const inv = group.matrixWorld.clone().invert();
    const box = new THREE.Box3();
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o.userData.collisionWire) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox!.clone().applyMatrix4(inv.clone().multiply(m.matrixWorld)));
    });
    return box;
  }

  private applyCollision(group: THREE.Object3D, model: string, override?: string) {
    const old: THREE.Object3D[] = [];
    group.traverse((o) => o.userData.collisionWire && old.push(o));
    for (const o of old) o.removeFromParent();
    if (!this.solid) return;
    const p = this.solid(model, override);
    if (!p || !p.shape || p.shape === "none" || p.shape === "terrain") return;
    if (p.shape === "trimesh" || p.shape === "convex" || p.shape === "boxes") {
      const meshes: THREE.Mesh[] = [];
      group.traverse((o) => (o as THREE.Mesh).isMesh && !o.userData.collisionWire && meshes.push(o as THREE.Mesh));
      for (const m of meshes) {
        const w = new THREE.Mesh(m.geometry, this.wireMat);
        w.userData.collisionWire = true;
        w.raycast = () => undefined;   // o aramado não atrapalha o clique
        m.add(w);
      }
      return;
    }
    const k = group.scale.x || 1;
    const box = this.localBox(group);
    const explicit = p.fit === "explicit";
    const sz = new THREE.Vector3(), ctr = new THREE.Vector3();
    box.getSize(sz);
    box.getCenter(ctr);
    let geo: THREE.BufferGeometry;
    let pos = new THREE.Vector3();
    let scale = 1;
    const off = new THREE.Vector3(...(p.offset ?? [0, 0, 0]));
    if (p.shape === "box") {
      const size = explicit ? new THREE.Vector3(...(p.size ?? [1, 1, 1])) : sz.clone().addScalar((p.margin ?? 0) * 2).multiplyScalar(p.scale ?? 1);
      geo = new THREE.BoxGeometry(size.x, size.y, size.z);
    } else if (p.shape === "sphere") {
      geo = new THREE.SphereGeometry(explicit ? p.radius ?? 1 : (Math.max(sz.x, sz.z) / 2) * (p.scale ?? 1), 16, 10);
    } else {
      const r = explicit ? p.radius ?? 1 : (Math.max(sz.x, sz.z) / 2) * (p.radius_scale ?? 1);
      const h = explicit ? p.height ?? 1 : sz.y * (p.scale ?? 1);
      geo = p.shape === "capsule" ? new THREE.CapsuleGeometry(r, Math.max(h - r * 2, 0.001), 4, 12) : new THREE.CylinderGeometry(r, r, h, 20);
    }
    if (explicit) {
      pos = off.divideScalar(k);   // metros do mundo: desfaz a escala do grupo
      scale = 1 / k;
    } else {
      pos = ctr.add(off);
    }
    const w = new THREE.Mesh(geo, this.wireMat);
    w.userData.collisionWire = true;
    w.raycast = () => undefined;
    w.position.copy(pos);
    w.scale.setScalar(scale);
    group.add(w);
  }

  /** Altura do topo do objeto (m) e se ele tem colisão no jogo (pelo perfil) */
  info(id: string, resolve: SolidResolver | null): { top: number; base: number; solid: boolean } | null {
    const o = this.objects.get(id);
    const g = o?.group;
    if (!o || !g || !g.children.length) return null;
    const box = new THREE.Box3();
    g.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (mesh.isMesh && !m.userData.collisionWire) box.expandByObject(mesh);
    });
    const p = resolve?.(o.model, o.collision);
    return { top: box.max.y, base: box.min.y, solid: Boolean(p && p.shape && p.shape !== "none" && p.shape !== "terrain") };
  }

  /** Caixa de cada objeto no mundo (para áreas derivadas e checagens) */
  worldBoxes(): Map<string, WorldBox> {
    const out = new Map<string, WorldBox>();
    for (const [id, o] of this.objects) {
      const box = new THREE.Box3();
      o.group.traverse((m) => {
        const mesh = m as THREE.Mesh;
        if (mesh.isMesh && !m.userData.collisionWire) box.expandByObject(mesh);
      });
      if (!box.isEmpty()) out.set(id, { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] });
    }
    return out;
  }

  // ---------- regiões jogáveis e caixas do servidor (M4): só desenho
  private regionGroup = new THREE.Group();
  private serverGroup = new THREE.Group();

  /** Contorno de cada região no chão, com postes nos cantos; selected destaca uma */
  setRegions(list: { id: string; min: [number, number]; max: [number, number]; selected: boolean }[]) {
    this.scene.remove(this.regionGroup);
    this.regionGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.regionGroup = new THREE.Group();
    for (const r of list) {
      const color = r.selected ? 0xffffff : 0xffd24d;
      const mat = new THREE.LineBasicMaterial({ color, depthTest: false });
      const pts = [r.min[0], 0.12, r.min[1], r.max[0], 0.12, r.min[1], r.max[0], 0.12, r.max[1], r.min[0], 0.12, r.max[1]];
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const loop = new THREE.LineLoop(g, mat);
      loop.renderOrder = 24;
      loop.raycast = () => undefined;
      this.regionGroup.add(loop);
      for (const [x, z] of [[r.min[0], r.min[1]], [r.max[0], r.min[1]], [r.max[0], r.max[1]], [r.min[0], r.max[1]]]) {
        const pg = new THREE.BufferGeometry();
        pg.setAttribute("position", new THREE.Float32BufferAttribute([x, 0, z, x, 6, z], 3));
        const pole = new THREE.Line(pg, mat);
        pole.renderOrder = 24;
        pole.raycast = () => undefined;
        this.regionGroup.add(pole);
      }
    }
    this.scene.add(this.regionGroup);
  }

  /** Caixas do servidor ([x0, z0, x1, z1, y0, y1], espaço do modelo) de um objeto, na posição, giro e escala dele */
  setServerBoxes(boxes: number[][] | null, pos: [number, number, number], rotY: number, scale: number) {
    this.scene.remove(this.serverGroup);
    this.serverGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.serverGroup = new THREE.Group();
    if (boxes && boxes.length) {
      const positions: number[] = [];
      const edge = (a: THREE.Vector3, b: THREE.Vector3) => positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      for (const [x0, z0, x1, z1, y0, y1] of boxes) {
        const c = [
          new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y0, z0), new THREE.Vector3(x1, y0, z1), new THREE.Vector3(x0, y0, z1),
          new THREE.Vector3(x0, y1, z0), new THREE.Vector3(x1, y1, z0), new THREE.Vector3(x1, y1, z1), new THREE.Vector3(x0, y1, z1),
        ];
        for (let i = 0; i < 4; i++) {
          edge(c[i], c[(i + 1) % 4]);
          edge(c[4 + i], c[4 + ((i + 1) % 4)]);
          edge(c[i], c[4 + i]);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.8, depthTest: false }));
      lines.renderOrder = 25;
      lines.raycast = () => undefined;
      lines.position.set(...pos);
      lines.rotation.y = THREE.MathUtils.degToRad(rotY);
      lines.scale.setScalar(scale);
      this.serverGroup.add(lines);
    }
    this.scene.add(this.serverGroup);
  }

  // ---------- áreas configuráveis (M4): só desenho; os dados ficam no React
  private areaGroup = new THREE.Group();

  setAreas(list: { area: Area; derived: boolean; selected: boolean }[]) {
    this.scene.remove(this.areaGroup);
    this.areaGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.areaGroup = new THREE.Group();
    for (const { area, derived, selected } of list) {
      const fp = footprint(area);
      if (!fp) continue;
      const color = new THREE.Color(tagColor(area.tags));
      const [y0, y1] = yRange(area);
      const fill = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: selected ? 0.5 : 0.28, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      const line = new THREE.LineBasicMaterial({ color: selected ? 0xffffff : color, transparent: true, opacity: derived ? 0.6 : 1, depthTest: false });
      let shape2d: THREE.Shape;
      if (fp.kind === "circle") {
        shape2d = new THREE.Shape();
        shape2d.absarc(0, 0, fp.r, 0, Math.PI * 2, false);
      } else {
        shape2d = new THREE.Shape(fp.pts.map(([x, z]) => new THREE.Vector2(x, z)));
      }
      const geo = new THREE.ShapeGeometry(shape2d).rotateX(Math.PI / 2);   // (x, y) do shape vira (x, z) no chão
      const mesh = new THREE.Mesh(geo, fill);
      mesh.position.y = Math.max(y0, 0) + 0.08;
      if (fp.kind === "circle") mesh.position.set(fp.c[0], mesh.position.y, fp.c[1]);
      mesh.renderOrder = 22;
      mesh.raycast = () => undefined;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), line);
      edges.position.copy(mesh.position);
      edges.renderOrder = 23;
      edges.raycast = () => undefined;
      this.areaGroup.add(mesh, edges);
      // haste na altura máxima, para ver a faixa vertical
      const top = new THREE.BufferGeometry();
      const cx = fp.kind === "circle" ? fp.c[0] : fp.pts.reduce((a, p) => a + p[0], 0) / fp.pts.length;
      const cz = fp.kind === "circle" ? fp.c[1] : fp.pts.reduce((a, p) => a + p[1], 0) / fp.pts.length;
      top.setAttribute("position", new THREE.Float32BufferAttribute([cx, Math.max(y0, 0), cz, cx, y1, cz], 3));
      const pole = new THREE.Line(top, line);
      pole.renderOrder = 23;
      pole.raycast = () => undefined;
      this.areaGroup.add(pole);
    }
    this.scene.add(this.areaGroup);
  }

  // ---------- camada de bloqueios (T068): só desenho, lida do <mapa>.blocks.json

  private blockGroups = new Map<string, THREE.Group>();

  /** Desenha os bloqueios (null apaga). Cada tipo vira um grupo; cor e visibilidade vêm depois, por tipo */
  setBlocks(data: BlocksData | null, colors: Record<string, string>, visible: Record<string, boolean>) {
    for (const g of this.blockGroups.values()) {
      this.scene.remove(g);
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
    }
    this.blockGroups.clear();
    if (!data) return;
    const Y = 0.06; // um pouco acima do chão, para não brigar com ele
    const group = (id: string) => {
      let g = this.blockGroups.get(id);
      if (!g) {
        g = new THREE.Group();
        g.renderOrder = 20;
        this.blockGroups.set(id, g);
        this.scene.add(g);
      }
      return g;
    };
    // sem teste de profundidade: o overlay aparece por cima da casa e das árvores
    const fillMat = () => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.38, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    const lineMat = () => new THREE.LineBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false });
    const flat = (geo: THREE.BufferGeometry, y = Y) => {
      const m = new THREE.Mesh(geo, fillMat());
      m.position.y = y;
      m.renderOrder = 20;
      m.raycast = () => undefined;
      return m;
    };
    const lines = (geo: THREE.BufferGeometry) => {
      const l = new THREE.LineSegments(geo, lineMat());
      l.renderOrder = 21;
      l.raycast = () => undefined;
      return l;
    };
    const rectFlat = (x0: number, z0: number, x1: number, z1: number, y = Y) => {
      const m = flat(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2), y);
      m.position.x = (x0 + x1) / 2;
      m.position.z = (z0 + z1) / 2;
      return m;
    };
    const boxEdges = (b: Box3) => {
      const size = new THREE.Vector3(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      const e = lines(new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)));
      e.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
      return e;
    };
    const rectOutline = (x0: number, z0: number, x1: number, z1: number, y = Y) => {
      const pts = [x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      return lines(geo);
    };
    const ring = (cx: number, cz: number, r: number, w: number) => {
      const m = flat(new THREE.RingGeometry(Math.max(r - w, 0), r, 96).rotateX(-Math.PI / 2));
      m.position.x = cx;
      m.position.z = cz;
      return m;
    };
    const disc = (cx: number, cz: number, r: number) => {
      const m = flat(new THREE.CircleGeometry(r, 32).rotateX(-Math.PI / 2));
      m.position.x = cx;
      m.position.z = cz;
      return m;
    };
    const pole = (x: number, y0: number, y1: number, z: number) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute([x, y0, z, x, y1, z], 3));
      return lines(geo);
    };

    // limites do mapa: a faixa de fora (fora dos 36 m) preenchida, mais o contorno
    const [bx0, bz0] = data.bounds.min, [bx1, bz1] = data.bounds.max;
    const out = 120;
    const shape = new THREE.Shape([new THREE.Vector2(-out, -out), new THREE.Vector2(out, -out), new THREE.Vector2(out, out), new THREE.Vector2(-out, out)]);
    shape.holes.push(new THREE.Path([new THREE.Vector2(bx0, bz0), new THREE.Vector2(bx0, bz1), new THREE.Vector2(bx1, bz1), new THREE.Vector2(bx1, bz0)]));
    const outside = flat(new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2));
    (outside.material as THREE.MeshBasicMaterial).opacity = 0.22;
    group("bounds").add(outside, rectOutline(bx0, bz0, bx1, bz1));

    // malhas sólidas: a pegada real vista de cima (células de 0,25 m), uma malha só por tipo.
    // Sem "rects" (arquivo antigo) cai na caixa; a cerca nunca usa a caixa, que cobre o terreno todo.
    const quads = new Map<string, number[]>();
    for (const sd of data.solids) {
      const id = solidType(sd.kind);
      const arr = quads.get(id) ?? [];
      quads.set(id, arr);
      const rects = sd.rects ?? (sd.kind === "fence" ? [] : [[sd.min[0], sd.min[2], sd.max[0], sd.max[2], sd.max[1]]]);
      for (const [x0, z0, x1, z1] of rects) arr.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z0, x1, 0, z1, x0, 0, z1);
    }
    for (const [id, pos] of quads) {
      if (!pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      group(id).add(flat(geo));
    }
    for (const t of data.trunks) {
      const g = group("trunks");
      g.add(disc(t.pos[0], t.pos[1], t.radius));
      g.add(pole(t.pos[0], 0, t.height, t.pos[1]));
    }
    for (const b of [data.door, data.wardrobe]) {
      group("door").add(rectFlat(b.min[0], b.min[2], b.max[0], b.max[2]), boxEdges(b));
    }
    const wz = group("deep_water");
    if (data.deep_water.length) {
      const pos: number[] = [];
      for (const t of data.deep_water) for (const [x, z] of t) pos.push(x, 0, z);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      wz.add(flat(geo, 0.04));
    }
    for (const z of data.mount_zones.zones) {
      group("mount_zones").add(rectFlat(z.min[0], z.min[1], z.max[0], z.max[1], 0.05), rectOutline(z.min[0], z.min[1], z.max[0], z.max[1], 0.05));
    }
    const [rx, , rz] = data.mule.rest_point;
    group("mule").add(ring(rx, rz, data.mule.wander_radius, 0.12), disc(rx, rz, 0.35));
    const [lx, , lz] = data.flyer.land_point;
    group("landing").add(disc(lx, lz, 0.5), pole(lx, 0, data.flyer.max_altitude, lz), ring(lx, lz, 1.0, 0.08));

    this.setBlockStyle(colors, visible);
  }

  /** Cor e interruptor por tipo */
  setBlockStyle(colors: Record<string, string>, visible: Record<string, boolean>) {
    for (const [id, g] of this.blockGroups) {
      g.visible = visible[id] !== false;
      const c = new THREE.Color(colors[id] ?? "#ffffff");
      g.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | THREE.LineBasicMaterial | undefined;
        if (mat && "color" in mat) mat.color.copy(c);
      });
    }
  }

  setCell(cell: number) {
    this.cell = cell;
    this.scene.remove(this.grid);
    this.grid = new THREE.GridHelper(GROUND, GROUND / cell, 0x4d5e38, 0x6a8250);
    this.grid.position.y = 0.01;
    this.scene.add(this.grid);
  }
}
