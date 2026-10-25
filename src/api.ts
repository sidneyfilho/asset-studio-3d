// Ponte com o lado Rust (src-tauri/src/lib.rs)
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export type ProjectInfo = { path: string; name: string; features: string[] };
export type ModelEntry = { rel: string; abs: string; size: number; mtime: number };

export const openProject = (path: string) => invoke<ProjectInfo>("open_project", { path });
export const listModels = (root: string, ignore: string[]) => invoke<ModelEntry[]>("list_models", { root, ignore });
export const listMaps = (root: string, ignore: string[]) => invoke<ModelEntry[]>("list_maps", { root, ignore });
export const readText = (path: string) => invoke<string>("read_text", { path });
export const writeText = (path: string, content: string) => invoke<void>("write_text", { path, content });
export const getThumb = (m: ModelEntry) => invoke<string | null>("get_thumb", { abs: m.abs, mtime: m.mtime });
export const saveThumb = (m: ModelEntry, png: Uint8Array) =>
  invoke<string>("save_thumb", { abs: m.abs, mtime: m.mtime, png: Array.from(png) });

/** Caminho do disco -> URL que a janela consegue carregar (protocolo asset do Tauri) */
export const fileUrl = (abs: string) => convertFileSrc(abs);
