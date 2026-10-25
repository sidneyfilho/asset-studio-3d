// Ponte com o lado Rust (src-tauri/src/lib.rs)
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export type ProjectInfo = { path: string; name: string; features: string[] };
export type ModelEntry = { rel: string; abs: string; size: number; mtime: number };

export const openProject = (path: string) => invoke<ProjectInfo>("open_project", { path });
export const listModels = (root: string, ignore: string[]) => invoke<ModelEntry[]>("list_models", { root, ignore });
export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });

export type SyncReport = { copied: string[]; unchanged: number; removed: string[]; maps_written: string[]; maps_removed: string[] };
export type SyncRequest = {
  godot_project: string;
  src_assets: string;
  dst_assets: string;
  dst_maps: string;
  maps: { name: string; content: string }[];
  apply: boolean;
};
export const syncGodot = (req: SyncRequest) => invoke<SyncReport>("sync_godot", { req });
export const godotImport = (exe: string, project: string) => invoke<string>("godot_import", { exe, project });

export const listMaps =(root: string, ignore: string[]) => invoke<ModelEntry[]>("list_maps", { root, ignore });
export const readText = (path: string) => invoke<string>("read_text", { path });
export const writeText = (path: string, content: string) => invoke<void>("write_text", { path, content });
export const getThumb = (m: ModelEntry) => invoke<string | null>("get_thumb", { abs: m.abs, mtime: m.mtime });
export const saveThumb = (m: ModelEntry, png: Uint8Array) =>
  invoke<string>("save_thumb", { abs: m.abs, mtime: m.mtime, png: Array.from(png) });

/** Caminho do disco -> URL que a janela consegue carregar (protocolo asset do Tauri) */
export const fileUrl = (abs: string) => convertFileSrc(abs);
