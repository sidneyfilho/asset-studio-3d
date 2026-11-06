// Bloqueios do jogo (T068): o arquivo <mapa>.blocks.json é gravado pelo Godot (tools/export_blocks.gd) ao lado do
// .map.json. O Studio só lê e desenha; nunca grava nele, e os valores continuam no código do jogo.

export type Box3 = { min: [number, number, number]; max: [number, number, number] };
export type Rect2 = { min: [number, number]; max: [number, number] };

export type BlocksData = {
  version: 1;
  map: string;
  bounds: { half_extent: number; min: [number, number]; max: [number, number] };
  /** caixa que envolve cada malha com colisão; "kind" é o prefixo do nome (house, porch, garden...) */
  solids: (Box3 & { name: string; kind: string; /** pegada vista de cima: [x0, z0, x1, z1, topo] */ rects?: [number, number, number, number, number][] })[];
  trunks: { name: string; pos: [number, number]; radius: number; height: number }[];
  door: Box3;
  wardrobe: Box3;
  /** áreas proibidas da mula e da voadora, já com a folga */
  mount_zones: { margin: number; zones: Rect2[] };
  /** triângulos (x, z) vistos de cima */
  deep_water: [[number, number], [number, number], [number, number]][];
  mule: { rest_point: [number, number, number]; wander_radius: number };
  flyer: { land_point: [number, number, number]; max_altitude: number };
};

export type BlockType = { id: string; label: string; hint: string; color: string };

/** Um tipo de bloqueio = uma cor e um interruptor no painel */
export const BLOCK_TYPES: BlockType[] = [
  { id: "bounds", label: "Limites do mapa", hint: "Paredes invisíveis a 36 m do centro", color: "#e0453a" },
  { id: "house", label: "Casa", hint: "Paredes, telhado e frente da casa", color: "#ff7a45" },
  { id: "porch", label: "Varanda", hint: "Deck, grades e degraus", color: "#f5a524" },
  { id: "garden", label: "Canteiros", hint: "Horta e canteiros", color: "#7bc043" },
  { id: "interior", label: "Interior", hint: "Móveis e paredes de dentro", color: "#e56fa8" },
  { id: "fence", label: "Cerca", hint: "Só o contorno: a cerca cerca o terreno", color: "#b08968" },
  { id: "kennel", label: "Casinha do cachorro", hint: "Casinha", color: "#c084fc" },
  { id: "rock", label: "Pedras", hint: "Pedras grandes", color: "#9aa5b1" },
  { id: "trunks", label: "Troncos", hint: "Árvores e pinheiros (cilindro de 0,32 m)", color: "#8b5a2b" },
  { id: "door", label: "Porta e guarda-roupa", hint: "Bloqueio da porta e do guarda-roupa", color: "#ffd24d" },
  { id: "deep_water", label: "Água funda", hint: "Só exibição: o jogo não deixa entrar", color: "#2f7de1" },
  { id: "mount_zones", label: "Áreas da mula e da voadora", hint: "Interior, varanda, canteiros e casinha, com folga de 0,45 m", color: "#2ec4b6" },
  { id: "mule", label: "Descanso e passeio da mula", hint: "Ponto de descanso e raio de passeio (9 m)", color: "#4cc9f0" },
  { id: "landing", label: "Ponto de pouso da voadora", hint: "Ponto de pouso e altura máxima (8 m)", color: "#b8f2e6" },
];

/** O tipo de uma malha sólida: "front" faz parte da casa; os outros prefixos têm tipo próprio */
export const solidType = (kind: string) => (kind === "front" ? "house" : kind);

export const blocksPathOf = (mapFile: string) => mapFile.replace(/\.map\.json$/i, ".blocks.json");

export function parseBlocks(text: string): BlocksData {
  const d = JSON.parse(text);
  if (!d || !d.bounds || !Array.isArray(d.solids)) throw new Error("arquivo de bloqueios inválido");
  return d as BlocksData;
}
