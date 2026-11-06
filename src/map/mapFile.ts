// Formato do mapa da ferramenta (.map.json) e a exportação para cena do Godot (.tscn).
// O .map.json fica na pasta de origem (doc-alvorland/map) e é o que a ferramenta abre e edita; o .tscn
// é gerado no Godot ao sincronizar e é o que o jogo usa. Cada objeto vira um nó que instancia o .glb;
// cada camada espalhada (grama, flores, pedrinhas) vira um nó que desenha todas as cópias com MultiMesh.

export type MapInstance = {
  id: string;
  /** caminho do modelo relativo à pasta de modelos da origem (ex.: nature/tree_oak.glb) */
  model: string;
  /** posição em metros (x, y, z do Godot: y para cima) */
  pos: [number, number, number];
  /** giro em torno do eixo vertical, em graus */
  rotY: number;
  scale: number;
  /** travado: não dá para selecionar nem mover clicando (ex.: a base do mapa) */
  locked?: boolean;
  /** perfil de colisão desta instância (override do catálogo de colisão; vazio = vale a regra do catálogo) */
  collision?: string;
};

/** Uma cópia espalhada: x, z (no chão), giro em graus, escala */
export type ScatterPoint = [number, number, number, number];

/** Muitas cópias de um modelo, pintadas com o pincel */
export type ScatterLayer = {
  id: string;
  model: string;
  points: ScatterPoint[];
};

export type MapData = {
  version: 1;
  name: string;
  /** tamanho da célula da grade, em metros */
  cell: number;
  instances: MapInstance[];
  scatter: ScatterLayer[];
};

export const newMap = (name: string): MapData => ({ version: 1, name, cell: 2, instances: [], scatter: [] });

export const newId = () => Math.random().toString(36).slice(2, 10);

export function parseMap(text: string): MapData {
  const d = JSON.parse(text);
  if (!d || !Array.isArray(d.instances)) throw new Error("arquivo de mapa inválido");
  return { version: 1, name: d.name ?? "mapa", cell: d.cell ?? 2, instances: d.instances, scatter: Array.isArray(d.scatter) ? d.scatter : [] };
}

export const serializeMap = (m: MapData) => JSON.stringify(m, null, 2) + "\n";

// número curto e sem notação científica para o .tscn
const num = (n: number) => {
  const v = Math.abs(n) < 1e-6 ? 0 : n;
  return String(Number(v.toFixed(5)));
};

/** Nome de nó válido no Godot (letras, números e _) */
const nodeName = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_") || "Node";

/** Script que o Godot usa para desenhar uma camada espalhada; a sincronização grava ao lado das cenas dos mapas */
export const SCATTER_SCRIPT_NAME = "scatter.gd";
export const SCATTER_SCRIPT = `extends Node3D
## Gerado pelo Asset Studio 3D ao sincronizar (não edite: é regravado).
## Desenha muitas cópias de um modelo (grama, flores, pedrinhas) com MultiMesh, numa chamada só.
## points: 4 números por cópia = x, z (no chão), giro em graus, escala.

@export var model: PackedScene
@export var points: PackedFloat32Array


func _ready() -> void:
	if model == null or points.size() < 4:
		return
	var src := model.instantiate() as Node3D
	var n := points.size() / 4
	for mi: MeshInstance3D in src.find_children("*", "MeshInstance3D", true, false):
		var local := Transform3D.IDENTITY
		var cur: Node = mi
		while cur != src and cur is Node3D:
			local = (cur as Node3D).transform * local
			cur = cur.get_parent()
		var mm := MultiMesh.new()
		mm.transform_format = MultiMesh.TRANSFORM_3D
		mm.mesh = mi.mesh
		mm.instance_count = n
		for i in n:
			var b := Basis(Vector3.UP, deg_to_rad(points[i * 4 + 2])).scaled(Vector3.ONE * points[i * 4 + 3])
			mm.set_instance_transform(i, Transform3D(b, Vector3(points[i * 4], 0.0, points[i * 4 + 1])) * local)
		var mmi := MultiMeshInstance3D.new()
		mmi.name = String(mi.name)
		mmi.multimesh = mm
		mmi.material_override = mi.material_override
		add_child(mmi)
	src.free()
`;

/**
 * Gera a cena do Godot. O Godot grava a base (Basis) do Transform3D linha por linha, e a rotação em torno de Y
 * tem as linhas [cos, 0, sin], [0, 1, 0], [-sin, 0, cos] — a mesma convenção do three.js.
 * scriptPath: caminho res:// do scatter.gd (usado só se o mapa tiver camadas espalhadas).
 */
export function toTscn(m: MapData, resPrefix: string, scriptPath = "res://maps/" + SCATTER_SCRIPT_NAME): string {
  const layers = (m.scatter ?? []).filter((l) => l.points.length);
  const models = [...new Set([...m.instances.map((i) => i.model), ...layers.map((l) => l.model)])];
  const idOf = new Map(models.map((p, k) => [p, String(k + 1)]));
  const out: string[] = ["[gd_scene format=3]", ""];
  for (const p of models) out.push(`[ext_resource type="PackedScene" path="${resPrefix}${p}" id="${idOf.get(p)}"]`);
  if (layers.length) out.push(`[ext_resource type="Script" path="${scriptPath}" id="scatter"]`);
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
    out.push(`[node name="${base}_${n}" parent="." instance=ExtResource("${idOf.get(i.model)}")]`, `transform = Transform3D(${t})`, ...(i.collision ? [`metadata/collision_profile = "${i.collision.replace(/[\\"]/g, "")}"`] : []), "");
  }
  for (const l of layers) {
    out.push(
      `[node name="scatter_${nodeName(l.id)}" type="Node3D" parent="."]`,
      `script = ExtResource("scatter")`,
      `model = ExtResource("${idOf.get(l.model)}")`,
      `points = PackedFloat32Array(${l.points.flat().map(num).join(", ")})`,
      "",
    );
  }
  return out.join("\n");
}
