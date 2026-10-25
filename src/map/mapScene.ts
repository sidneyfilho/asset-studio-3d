// Parte 3D do editor de mapa (three.js): chão com grade, objetos colocados, "fantasma" do objeto
// que vai ser colocado e a seta de mover. Os dados do mapa ficam no React; aqui só se desenha
// e se avisa o que o mouse fez (colocar, selecionar, mover).
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { addLights } from "../three/loadModel";
import { instanceModel } from "../three/modelCache";
import type { MapInstance } from "./mapFile";

export type Snap = "cell" | "half" | "free";

type Callbacks = {
  onPlace: (pos: [number, number, number]) => void;
  onPick: (id: string | null) => void;
  onMove: (id: string, pos: [number, number, number]) => void;
};

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
  private objects = new Map<string, { group: THREE.Group; model: string }>();
  private ghost: THREE.Group | null = null;
  private ghostModel = "";
  private ghostToken = 0;
  private selected: string | null = null;
  private selBox = new THREE.BoxHelper(new THREE.Object3D(), 0xd9a35b);
  private dragging = false;
  private downAt: { x: number; y: number } | null = null;
  private ro: ResizeObserver;
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

    // câmera como a do jogo: 30° de elevação e 30° de giro; botão direito gira, do meio arrasta, roda dá zoom
    const a = THREE.MathUtils.degToRad(30), d = 40;
    this.cam.position.set(d * Math.cos(a) * Math.sin(a), d * Math.sin(a), d * Math.cos(a) * Math.cos(a));
    this.orbit = new OrbitControls(this.cam, this.renderer.domElement);
    this.orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.orbit.maxPolarAngle = THREE.MathUtils.degToRad(85);
    this.orbit.enableDamping = true;

    // seta de mover: só no plano do chão (x e z)
    this.gizmo = new TransformControls(this.cam, this.renderer.domElement);
    this.gizmo.showY = false;
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.dragging = Boolean(e.value);
      this.orbit.enabled = !this.dragging;
      const id = this.selected;
      if (!this.dragging && id) {
        const p = this.objects.get(id)?.group.position;
        if (p) this.cb.onMove(id, [p.x, p.y, p.z]);
      }
    });
    this.gizmo.addEventListener("objectChange", () => {
      const o = this.gizmo.object;
      if (o) {
        const p = this.snapPoint(o.position);
        o.position.set(p.x, o.position.y, p.z);
        this.selBox.update();
      }
    });
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
    this.ray.setFromCamera(this.mouse, this.cam);
    const hit = this.ray.intersectObject(this.ground)[0];
    return hit ? hit.point : null;
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.ghost) return;
    const p = this.groundPoint(e);
    if (p) {
      const s = this.snapPoint(p);
      this.ghost.position.set(s.x, 0, s.z);
      this.ghost.visible = true;
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    this.downAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };

  // clique = apertar e soltar sem arrastar; arrastar a seta de mover não conta como clique
  private onPointerUp = (e: PointerEvent) => {
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
    const groups = [...this.objects.values()].map((o) => o.group);
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
        o = { group, model: i.model };
        this.objects.set(i.id, o);
        instanceModel(this.absOf(i.model))
          .then((m) => {
            group.add(m);
            if (this.selected === i.id) this.selBox.setFromObject(group);
          })
          .catch(() => group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true }))));
      }
      if (this.gizmo.object !== o.group || !this.dragging) {
        o.group.position.set(...i.pos);
        o.group.rotation.y = THREE.MathUtils.degToRad(i.rotY);
        o.group.scale.setScalar(i.scale);
      }
    }
    this.setSelected(this.selected && keep.has(this.selected) ? this.selected : null);
  }

  setSelected(id: string | null) {
    this.selected = id;
    const g = id ? this.objects.get(id)?.group : undefined;
    if (g) {
      this.gizmo.attach(g);
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

  setCell(cell: number) {
    this.cell = cell;
    this.scene.remove(this.grid);
    this.grid = new THREE.GridHelper(GROUND, GROUND / cell, 0x4d5e38, 0x6a8250);
    this.grid.position.y = 0.01;
    this.scene.add(this.grid);
  }
}
