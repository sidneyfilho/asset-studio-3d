// Regiões jogáveis (M2/M4): <mapa>.regions.json, o mesmo arquivo que o jogo lê. A área jogável é a união das regiões;
// o jogo gera as paredes invisíveis nas bordas e usa as propriedades (ex.: flyer_max_altitude).
import type { Issue } from "./catalog";

export type Region = {
  id: string;
  note?: string;
  bounds: { type: "rect"; min: [number, number]; max: [number, number] };
  properties?: Record<string, unknown>;
  neighbors?: string[];
};

export type RegionsFile = { version: 1; note?: string; regions: Region[] };

export const emptyRegions = (): RegionsFile => ({ version: 1, regions: [] });
export const parseRegions = (text: string): RegionsFile => {
  const d = JSON.parse(text);
  if (!d || !Array.isArray(d.regions)) throw new Error("arquivo de regiões inválido: falta a lista \"regions\"");
  return { version: 1, note: d.note, regions: d.regions };
};
export const serializeRegions = (r: RegionsFile) => JSON.stringify({ version: 1, ...(r.note ? { note: r.note } : {}), regions: r.regions }, null, 2) + "\n";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Mesmas regras e mensagens do jogo (scripts/blocks/region_def.gd e world_limits.gd) */
export function lintRegions(list: Region[]): Issue[] {
  const out: Issue[] = [];
  const ids = new Set<string>();
  for (const [i, r] of list.entries()) {
    const where = `regions[${r.id || i}]`;
    const e = (message: string): Issue => ({ level: "erro", where, message });
    if (!r.id) out.push(e("id obrigatório (texto não vazio)"));
    else if (ids.has(r.id)) out.push(e("id repetido"));
    ids.add(r.id);
    const b = r.bounds;
    if (!b || b.type !== "rect" || ![b.min, b.max].every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum))) {
      out.push(e('bounds: esperado {"type": "rect", "min": [x, z], "max": [x, z]} com números'));
      continue;
    }
    if (!(b.max[0] > b.min[0] && b.max[1] > b.min[1])) out.push(e(`bounds: max precisa ser maior que min nos dois eixos (min ${b.min.join(", ")}, max ${b.max.join(", ")})`));
  }
  for (const r of list) for (const n of r.neighbors ?? []) if (!ids.has(n)) out.push({ level: "erro", where: `regions[${r.id}].neighbors`, message: `a região "${n}" não existe` });
  if (!list.length) out.push({ level: "aviso", where: "regions", message: "nenhuma região: o jogo usa a região padrão de 36 m" });
  return out;
}
