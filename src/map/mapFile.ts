// Formato do mapa da ferramenta (.map.json) e a exportação para cena do Godot (.tscn).
// O .map.json é o "arquivo de trabalho" (a ferramenta abre e edita); o .tscn é gerado a cada salvar
// e é o que o jogo usa. Cada objeto vira um nó que instancia o .glb, com posição, giro e escala.

export type MapInstance = {
  id: string;
  /** caminho do modelo relativo ao projeto (ex.: assets/nature/tree_oak.glb) */
  model: string;
  /** posição em metros (x, y, z do Godot: y para cima) */
  pos: [number, number, number];
  /** giro em torno do eixo vertical, em graus */
  rotY: number;
  scale: number;
};

export type MapData = {
  version: 1;
  name: string;
  /** tamanho da célula da grade, em metros */
  cell: number;
  instances: MapInstance[];
};

export const newMap = (name: string): MapData => ({ version: 1, name, cell: 2, instances: [] });

export const newId = () => Math.random().toString(36).slice(2, 10);

export function parseMap(text: string): MapData {
  const d = JSON.parse(text);
  if (!d || !Array.isArray(d.instances)) throw new Error("arquivo de mapa inválido");
  return { version: 1, name: d.name ?? "mapa", cell: d.cell ?? 2, instances: d.instances };
}

export const serializeMap = (m: MapData) => JSON.stringify(m, null, 2) + "\n";

// número curto e sem notação científica para o .tscn
const num = (n: number) => {
  const v = Math.abs(n) < 1e-6 ? 0 : n;
  return String(Number(v.toFixed(5)));
};

/** Nome de nó válido no Godot (letras, números e _) */
const nodeName = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_") || "Node";

/**
 * Gera a cena do Godot. O Godot grava a base (Basis) do Transform3D linha por linha, e a rotação em torno de Y
 * tem as linhas [cos, 0, sin], [0, 1, 0], [-sin, 0, cos] — a mesma convenção do three.js.
 */
export function toTscn(m: MapData): string {
  const models = [...new Set(m.instances.map((i) => i.model))];
  const idOf = new Map(models.map((p, k) => [p, String(k + 1)]));
  const out: string[] = ["[gd_scene format=3]", ""];
  for (const p of models) out.push(`[ext_resource type="PackedScene" path="res://${p}" id="${idOf.get(p)}"]`);
  if (models.length) out.push("");
  out.push(`[node name="${nodeName(m.name)}" type="Node3D"]`, "");
  const used = new Map<string, number>();
  for (const i of m.instances) {
    const base = nodeName(i.model.split("/").pop()!.replace(/\.(glb|gltf)$/i, ""));
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const a = (i.rotY * Math.PI) / 180;
    const c = Math.cos(a) * i.scale, s = Math.sin(a) * i.scale, k = i.scale;
    const t = [c, 0, s, 0, k, 0, -s, 0, c, ...i.pos].map(num).join(", ");
    out.push(`[node name="${base}_${n}" parent="." instance=ExtResource("${idOf.get(i.model)}")]`, `transform = Transform3D(${t})`, "");
  }
  return out.join("\n");
}
