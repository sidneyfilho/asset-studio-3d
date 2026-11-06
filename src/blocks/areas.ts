// Áreas configuráveis (M4): <mapa>.areas.json, o mesmo arquivo que o jogo e o servidor leem. Aqui ficam os tipos,
// a validação, as áreas derivadas dos modelos (area_tags do catálogo) e as checagens de erro de configuração.
import { areaTagsFor, type Catalog, type Issue, type Vec3 } from "./catalog";

export type AreaShape =
  | { type: "box"; center: Vec3; size: Vec3; yaw?: number }
  | { type: "sphere"; center: Vec3; radius: number }
  | { type: "cylinder"; center: Vec3; radius: number; height: number };

export type Area = {
  id: string;
  region?: string;
  note?: string;
  shape: AreaShape;
  tags: string[];
  priority?: number;
  properties?: Record<string, unknown>;
};

export type AreasFile = { version: 1; note?: string; areas: Area[] };

/** Tags conhecidas, com cor no overlay. Tag nova (digitada) usa a cor "outra". */
export const KNOWN_TAGS: { tag: string; label: string; color: string }[] = [
  { tag: "safe_zone", label: "Zona segura", color: "#4cc9f0" },
  { tag: "build_blocked", label: "Construção bloqueada", color: "#e0453a" },
  { tag: "build_allowed", label: "Construção permitida", color: "#7bc043" },
  { tag: "farm", label: "Fazenda", color: "#c9b037" },
  { tag: "restricted", label: "Acesso restrito", color: "#c084fc" },
  { tag: "interact", label: "Interação", color: "#ff9f1c" },
  { tag: "no_mount", label: "Montaria não entra", color: "#2ec4b6" },
  { tag: "interior", label: "Interior", color: "#e56fa8" },
];
export const OTHER_TAG_COLOR = "#9aa5b1";
export const tagColor = (tags: string[]) => KNOWN_TAGS.find((k) => tags.includes(k.tag))?.color ?? OTHER_TAG_COLOR;

export const emptyAreas = (): AreasFile => ({ version: 1, areas: [] });
export const parseAreas = (text: string): AreasFile => {
  const d = JSON.parse(text);
  if (!d || !Array.isArray(d.areas)) throw new Error("arquivo de áreas inválido: falta a lista \"areas\"");
  return { version: 1, note: d.note, areas: d.areas };
};
export const serializeAreas = (a: AreasFile) => JSON.stringify({ version: 1, ...(a.note ? { note: a.note } : {}), areas: a.areas }, null, 2) + "\n";
export const areasPathOf = (mapFile: string) => mapFile.replace(/\.map\.json$/i, ".areas.json");
export const regionsPathOf = (mapFile: string) => mapFile.replace(/\.map\.json$/i, ".regions.json");

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);

/** Forma de uma área: mesmas regras e mensagens do jogo (scripts/blocks/area_def.gd) */
export function shapeIssues(a: Area, where: string): Issue[] {
  const s = a.shape as Partial<AreaShape> & Record<string, unknown>;
  const e = (m: string): Issue => ({ level: "erro", where, message: m });
  if (!s || typeof s !== "object") return [e("shape: esperado um objeto com \"type\" (box, sphere, cylinder)")];
  if (!["box", "sphere", "cylinder"].includes(String(s.type))) return [e(`shape.type: "${String(s.type)}" inválido (válidos: box, sphere, cylinder)`)];
  const out: Issue[] = [];
  if (!isVec3(s.center)) out.push(e("shape.center: esperado [x, y, z] com números"));
  if (s.type === "box") {
    if (!(isVec3(s.size) && s.size.every((v) => v > 0))) out.push(e("shape.size: esperado [x, y, z] com números positivos"));
  } else {
    if (!(isNum(s.radius) && s.radius > 0)) out.push(e("shape.radius: esperado número maior que zero"));
    if (s.type === "cylinder" && !(isNum(s.height) && (s.height as number) > 0)) out.push(e("shape.height: esperado número maior que zero"));
  }
  return out;
}

/** Pegada vista de cima: polígono (caixa girada) ou círculo */
export type Footprint = { kind: "poly"; pts: [number, number][] } | { kind: "circle"; c: [number, number]; r: number };

export function footprint(a: Area): Footprint | null {
  const s = a.shape;
  if (shapeIssues(a, "").length) return null;
  if (s.type !== "box") return { kind: "circle", c: [s.center[0], s.center[2]], r: s.radius };
  const yaw = ((s.yaw ?? 0) * Math.PI) / 180, sn = Math.sin(yaw), cs = Math.cos(yaw);
  const hx = s.size[0] / 2, hz = s.size[2] / 2;
  const pts = ([[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]] as const).map(([x, z]) => [s.center[0] + x * cs + z * sn, s.center[2] - x * sn + z * cs] as [number, number]);
  return { kind: "poly", pts };
}

export function yRange(a: Area): [number, number] {
  const s = a.shape;
  if (s.type === "box") return [s.center[1] - s.size[1] / 2, s.center[1] + s.size[1] / 2];
  if (s.type === "sphere") return [s.center[1] - s.radius, s.center[1] + s.radius];
  return [s.center[1] - s.height / 2, s.center[1] + s.height / 2];
}

// ---------- sobreposição exata entre pegadas (para avisar conflito de regras)

const sub = (a: [number, number], b: [number, number]): [number, number] => [a[0] - b[0], a[1] - b[1]];
const dot = (a: [number, number], b: [number, number]) => a[0] * b[0] + a[1] * b[1];

function segDist(p: [number, number], a: [number, number], b: [number, number]) {
  const ab = sub(b, a), ap = sub(p, a);
  const t = Math.max(0, Math.min(1, dot(ap, ab) / (dot(ab, ab) || 1)));
  return Math.hypot(p[0] - (a[0] + ab[0] * t), p[1] - (a[1] + ab[1] * t));
}

function inPoly(p: [number, number], poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function circlePoly(c: [number, number], r: number, poly: [number, number][]) {
  if (inPoly(c, poly)) return true;
  return poly.some((a, i) => segDist(c, a, poly[(i + 1) % poly.length]) <= r);
}

function polyPoly(p: [number, number][], q: [number, number][]) {
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const e = sub(poly[(i + 1) % poly.length], poly[i]);
      const axis: [number, number] = [-e[1], e[0]];
      if (dot(axis, axis) < 1e-12) continue;
      const range = (pts: [number, number][]) => {
        const d = pts.map((v) => dot(axis, v));
        return [Math.min(...d), Math.max(...d)];
      };
      const [a0, a1] = range(p), [b0, b1] = range(q);
      if (a1 < b0 || b1 < a0) return false;
    }
  }
  return true;
}

export function overlaps(a: Area, b: Area): boolean {
  const fa = footprint(a), fb = footprint(b);
  if (!fa || !fb) return false;
  const [a0, a1] = yRange(a), [b0, b1] = yRange(b);
  if (a1 < b0 || b1 < a0) return false;
  if (fa.kind === "circle" && fb.kind === "circle") return Math.hypot(fa.c[0] - fb.c[0], fa.c[1] - fb.c[1]) <= fa.r + fb.r;
  if (fa.kind === "circle" && fb.kind === "poly") return circlePoly(fa.c, fa.r, fb.pts);
  if (fa.kind === "poly" && fb.kind === "circle") return circlePoly(fb.c, fb.r, fa.pts);
  return fa.kind === "poly" && fb.kind === "poly" && polyPoly(fa.pts, fb.pts);
}

// ---------- áreas derivadas dos modelos (iguais às do jogo: caixa do modelo no mundo + area_tags do catálogo)

export type WorldBox = { min: Vec3; max: Vec3 };

export function deriveAreas(c: Catalog, instances: { id: string; model: string; noAreas?: boolean }[], boxes: Map<string, WorldBox>): Area[] {
  const out: Area[] = [];
  for (const i of instances) {
    if (i.noAreas) continue;
    const tags = areaTagsFor(c, i.model);
    const b = boxes.get(i.id);
    if (!tags.length || !b) continue;
    const size: Vec3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    if (size.some((v) => v <= 0)) continue;
    out.push({ id: i.id, shape: { type: "box", center: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2], size }, tags, priority: 0, note: "derivada do modelo (area_tags)" });
  }
  return out;
}

// ---------- checagens de erro de configuração

export type RegionRect = { id: string; min: [number, number]; max: [number, number] };

export function lintAreas(
  areas: Area[],
  derived: Area[],
  regions: RegionRect[],
  instanceBoxes: { id: string; model: string; box: WorldBox }[],
): Issue[] {
  const out: Issue[] = [];
  const seen = new Set<string>();
  for (const [i, a] of areas.entries()) {
    const where = `areas[${a.id || i}]`;
    if (!a.id) out.push({ level: "erro", where, message: "id obrigatório (texto não vazio)" });
    else if (seen.has(a.id) || derived.some((d) => d.id === a.id)) out.push({ level: "erro", where, message: "id repetido (também vale para áreas derivadas de objetos)" });
    seen.add(a.id);
    if (!a.tags?.length) out.push({ level: "erro", where, message: "a área precisa de ao menos uma tag (senão não faz nada)" });
    out.push(...shapeIssues(a, where));
    for (const t of a.tags ?? []) if (!KNOWN_TAGS.some((k) => k.tag === t)) out.push({ level: "aviso", where, message: `tag "${t}" não é uma das conhecidas (${KNOWN_TAGS.map((k) => k.tag).join(", ")}): confira se não é erro de digitação` });
    if (a.region && regions.length && !regions.some((r) => r.id === a.region)) out.push({ level: "erro", where, message: `a região "${a.region}" não existe em regions.json` });
  }
  const all = [...areas, ...derived];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if ((a.priority ?? 0) !== (b.priority ?? 0)) continue;
      const conflict = (a.tags.includes("build_blocked") && b.tags.includes("build_allowed")) || (a.tags.includes("build_allowed") && b.tags.includes("build_blocked"));
      if (conflict && overlaps(a, b)) out.push({ level: "erro", where: `areas[${a.id}] x areas[${b.id}]`, message: "build_blocked e build_allowed se sobrepõem com a mesma prioridade: dê prioridades diferentes para saber qual vence" });
    }
  }
  for (const i of instanceBoxes) {
    if (!regions.length) break;
    const cx = (i.box.min[0] + i.box.max[0]) / 2, cz = (i.box.min[2] + i.box.max[2]) / 2;
    if (!regions.some((r) => cx >= r.min[0] && cx <= r.max[0] && cz >= r.min[1] && cz <= r.max[1])) out.push({ level: "aviso", where: `instância ${i.id}`, message: `o objeto (${i.model}) está fora de todas as regiões jogáveis` });
  }
  return out;
}
