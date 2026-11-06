// Catálogo de colisão (M4): collision_catalog.json, a mesma fonte única que o jogo lê. Aqui ficam os tipos, a
// validação (schema + referências) e a resolução do perfil de um objeto, com a MESMA precedência do jogo:
//   override da instância > perfil do modelo > categoria (primeiro glob que casa) > perfil padrão.
import Ajv, { type ErrorObject } from "ajv";

export type Vec3 = [number, number, number];

export type Profile = {
  note?: string;
  shape?: "none" | "terrain" | "box" | "sphere" | "capsule" | "cylinder" | "convex" | "trimesh" | "boxes";
  /** trimesh/convex: como o servidor reproduz a colisão ("boxes" = caixas com altura geradas em server_shapes.json) */
  server?: "boxes";
  fit?: "auto" | "explicit";
  margin?: number;
  scale?: number;
  radius_scale?: number;
  radius?: number;
  height?: number;
  size?: Vec3;
  offset?: Vec3;
  blocks?: string[];
};

export type Catalog = {
  version: 1;
  note?: string;
  default_profile?: string;
  profiles: Record<string, Profile>;
  categories?: { match: string; profile: string }[];
  area_tags?: Record<string, string[]>;
  models?: Record<string, string>;
};

export const SHAPES = ["none", "terrain", "box", "sphere", "capsule", "cylinder", "convex", "trimesh", "boxes"] as const;
export const BLOCK_LAYERS = ["world"];

export type Issue = { level: "erro" | "aviso"; where: string; message: string };

/** glob do jogo (String.matchn do Godot): * qualquer trecho, ? um caractere, sem diferenciar maiúsculas */
export function globMatch(pattern: string, text: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i").test(text);
}

export type Resolved = { id: string; profile: Profile; from: "instância" | "modelo" | "categoria" | "padrão" | "ausente" };

/** Qual perfil vale para um modelo (caminho relativo a assets/), com o override opcional da instância */
export function resolveProfile(c: Catalog, model: string, override?: string): Resolved {
  const get = (id: string) => c.profiles[id];
  if (override && get(override)) return { id: override, profile: get(override), from: "instância" };
  const m = c.models?.[model];
  if (m && get(m)) return { id: m, profile: get(m), from: "modelo" };
  for (const cat of c.categories ?? []) if (get(cat.profile) && globMatch(cat.match, model)) return { id: cat.profile, profile: get(cat.profile), from: "categoria" };
  const d = c.default_profile ?? "none";
  if (get(d)) return { id: d, profile: get(d), from: "padrão" };
  return { id: "none", profile: { shape: "none" }, from: "ausente" };
}

export const areaTagsFor = (c: Catalog, model: string): string[] => {
  const out: string[] = [];
  for (const [glob, tags] of Object.entries(c.area_tags ?? {})) if (globMatch(glob, model)) for (const t of tags) if (!out.includes(t)) out.push(t);
  return out;
};

export const emptyCatalog = (): Catalog => ({ version: 1, default_profile: "none", profiles: { none: { shape: "none" } }, categories: [], area_tags: {}, models: {} });

// ---------- validação com o schema (Ajv) e mensagens em português

const ajv = new Ajv({ allErrors: true, strict: false });

/** "/profiles/tree_trunk/radius" -> "profiles.tree_trunk.radius" */
const pathOf = (p: string) => p.split("/").filter(Boolean).join(".") || "(raiz)";

export function ajvMessage(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case "required": return `campo obrigatório ausente: ${String(p.missingProperty)}`;
    case "additionalProperties": return `campo desconhecido: ${String(p.additionalProperty)}`;
    case "enum": return `valor inválido (permitidos: ${(p.allowedValues as unknown[]).join(", ")})`;
    case "const": return `valor inválido (esperado ${JSON.stringify(p.allowedValue)})`;
    case "type": return `esperado ${({ number: "número", string: "texto", object: "objeto", array: "lista", integer: "número inteiro", boolean: "verdadeiro ou falso" } as Record<string, string>)[String(p.type)] ?? String(p.type)}`;
    case "exclusiveMinimum": return `precisa ser maior que ${String(p.limit)}`;
    case "minimum": return `precisa ser pelo menos ${String(p.limit)}`;
    case "minItems": return `precisa de pelo menos ${String(p.limit)} item(ns)`;
    case "maxItems": return `precisa de no máximo ${String(p.limit)} item(ns)`;
    case "minLength": return "não pode ficar vazio";
    default: return e.message ?? e.keyword;
  }
}

/** Valida contra o schema carregado de <origem>/schemas; devolve uma lista de problemas com o caminho do campo */
export function validateWithSchema(schema: unknown, data: unknown, ignorePath?: (p: string) => boolean): Issue[] {
  const validate = ajv.compile(schema as object);
  if (validate(data)) return [];
  const out: Issue[] = [];
  for (const e of validate.errors ?? []) {
    const where = pathOf(e.instancePath);
    if (ignorePath?.(where)) continue;
    const extra = e.keyword === "required" || e.keyword === "additionalProperty" ? "" : "";
    out.push({ level: "erro", where: e.keyword === "required" ? where : where, message: ajvMessage(e) + extra });
  }
  return out;
}

/** Checagens que o schema não faz: referências quebradas, modelo sem perfil, perfis sem uso */
export function lintCatalog(c: Catalog, models: string[]): Issue[] {
  const out: Issue[] = [];
  const has = (id: string) => Boolean(c.profiles[id]);
  if (c.default_profile && !has(c.default_profile)) out.push({ level: "erro", where: "default_profile", message: `o perfil "${c.default_profile}" não existe` });
  for (const [m, id] of Object.entries(c.models ?? {})) if (!has(id)) out.push({ level: "erro", where: `models.${m}`, message: `o perfil "${id}" não existe` });
  for (const [i, cat] of (c.categories ?? []).entries()) if (!has(cat.profile)) out.push({ level: "erro", where: `categories[${i}]`, message: `o perfil "${cat.profile}" não existe` });
  for (const [id, p] of Object.entries(c.profiles)) {
    const prim = p.shape === "box" || p.shape === "sphere" || p.shape === "capsule" || p.shape === "cylinder";
    if (prim && p.fit === "explicit") {
      if (p.shape === "box" && !p.size) out.push({ level: "erro", where: `profiles.${id}`, message: "box com fit explicit precisa de size [x, y, z]" });
      if (p.shape !== "box" && !p.radius) out.push({ level: "erro", where: `profiles.${id}`, message: `${p.shape} com fit explicit precisa de radius` });
      if ((p.shape === "capsule" || p.shape === "cylinder") && !p.height) out.push({ level: "erro", where: `profiles.${id}`, message: `${p.shape} com fit explicit precisa de height` });
    }
    for (const b of p.blocks ?? []) if (!BLOCK_LAYERS.includes(b)) out.push({ level: "erro", where: `profiles.${id}.blocks`, message: `camada desconhecida "${b}" (válidas: ${BLOCK_LAYERS.join(", ")})` });
    if ((p.shape === "trimesh" || p.shape === "convex") && !p.server) out.push({ level: "aviso", where: `profiles.${id}`, message: `${p.shape} usa a malha visual e o servidor não consegue reproduzir: marque "Servidor: caixas" (geradas em server_shapes.json) ou use uma forma primitiva` });
    if (p.server && p.shape !== "trimesh" && p.shape !== "convex" && p.shape !== "boxes") out.push({ level: "erro", where: `profiles.${id}.server`, message: "só faz sentido em trimesh, convex ou boxes (as formas primitivas o servidor calcula com o perfil)" });
  }
  const used = new Set<string>([c.default_profile ?? "none", ...Object.values(c.models ?? {}), ...(c.categories ?? []).map((x) => x.profile)]);
  for (const id of Object.keys(c.profiles)) if (!used.has(id)) out.push({ level: "aviso", where: `profiles.${id}`, message: "perfil que nenhum modelo nem categoria usa (pode ser só override de instância)" });
  for (const m of models) {
    const r = resolveProfile(c, m);
    if (r.from === "padrão" && !c.models?.[m]) out.push({ level: "aviso", where: `models.${m}`, message: `modelo sem perfil: vale o padrão "${r.id}" (${r.profile.shape ?? "none"}). Se for de propósito, declare "none" para ele` });
  }
  return out;
}

export const parseCatalog = (text: string): Catalog => {
  const d = JSON.parse(text);
  if (!d || typeof d !== "object" || !d.profiles) throw new Error("catálogo inválido: falta \"profiles\"");
  return d as Catalog;
};

export const serializeCatalog = (c: Catalog) => JSON.stringify(c, null, 2) + "\n";
