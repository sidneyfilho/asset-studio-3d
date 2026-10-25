// Pasta de origem (ex.: doc-alvorland): de onde vêm os modelos e os mapas.
// A configuração fica num arquivo dentro dela (alvorland-studio.json), então vale para qualquer
// computador que abrir a mesma pasta. Os caminhos ali são relativos à própria pasta de origem.
import { pathExists, readText, writeText } from "./api";

export const CONFIG_FILE = "alvorland-studio.json";

export type WsConfig = {
  /** projeto Godot que recebe a sincronização */
  godotProject: string;
  /** pasta dos modelos na origem */
  assetsDir: string;
  /** pasta dos mapas na origem */
  mapsDir: string;
  /** pasta do Godot (dentro do projeto) que fica igual à pasta de modelos da origem */
  godotAssetsDir: string;
  /** pasta do Godot onde as cenas .tscn dos mapas são geradas */
  godotMapsDir: string;
  /** subpastas de modelos que não são peças (ex.: cenas inteiras): ficam fora de "Todos" e da paleta do mapa */
  notPieces: string[];
};

export const DEFAULT_CONFIG: WsConfig = {
  godotProject: "../godot-alvorland",
  assetsDir: "assets",
  mapsDir: "map",
  godotAssetsDir: "assets",
  godotMapsDir: "maps",
  notPieces: ["scenes"],
};

/** Junta caminhos e resolve "." e ".." (Windows, com "\") */
export function joinPath(base: string, rel: string): string {
  const absRel = /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("\\\\");
  const parts = (absRel ? rel : `${base}\\${rel}`).split(/[\\/]+/);
  const out: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("\\");
}

export type Workspace = {
  root: string;
  config: WsConfig;
  /** caminhos absolutos já resolvidos */
  assets: string;
  maps: string;
  godot: string;
  godotAssets: string;
  godotMaps: string;
  /** prefixo res:// dos modelos no Godot (ex.: res://assets/items/) */
  resPrefix: string;
  /** prefixo res:// da pasta dos mapas no Godot (ex.: res://maps/) */
  mapsRes: string;
};

export function resolveWorkspace(root: string, config: WsConfig): Workspace {
  const godot = joinPath(root, config.godotProject);
  const clean = (s: string) => s.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return {
    root,
    config,
    assets: joinPath(root, config.assetsDir),
    maps: joinPath(root, config.mapsDir),
    godot,
    godotAssets: joinPath(godot, config.godotAssetsDir),
    godotMaps: joinPath(godot, config.godotMapsDir),
    resPrefix: `res://${clean(config.godotAssetsDir)}/`,
    mapsRes: `res://${clean(config.godotMapsDir)}/`,
  };
}

/** Lê a configuração da pasta de origem; na primeira vez cria o arquivo com os valores padrão */
export async function loadConfig(root: string): Promise<WsConfig> {
  const file = joinPath(root, CONFIG_FILE);
  if (await pathExists(file)) return { ...DEFAULT_CONFIG, ...JSON.parse(await readText(file)) };
  await saveConfig(root, DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

export const saveConfig = (root: string, c: WsConfig) => writeText(joinPath(root, CONFIG_FILE), JSON.stringify(c, null, 2) + "\n");
