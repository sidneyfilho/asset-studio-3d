// Comandos do Alvorland Studio chamados pela interface (React).
// A interface lê os arquivos pelo protocolo "asset" do Tauri; aqui ficam só as operações de disco:
// ler o projeto Godot, listar modelos e mapas da pasta de origem, guardar miniaturas e sincronizar (sync.rs).
mod sync;

use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Manager;

#[derive(Serialize)]
struct ProjectInfo {
    path: String,
    name: String,
    features: Vec<String>,
}

#[derive(Serialize)]
struct ModelEntry {
    /// caminho relativo à raiz do projeto, com "/" (ex.: assets/nature/tree.glb)
    rel: String,
    /// caminho absoluto no disco
    abs: String,
    size: u64,
    /// data de modificação (segundos desde 1970), usada para invalidar a miniatura
    mtime: u64,
}

/// Lê o project.godot da pasta e devolve o nome e as features (versão do Godot).
#[tauri::command]
fn open_project(path: String) -> Result<ProjectInfo, String> {
    let file = Path::new(&path).join("project.godot");
    let text = fs::read_to_string(&file)
        .map_err(|_| format!("Não achei project.godot em {path}"))?;
    let mut name = Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut features = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("config/name=") {
            name = v.trim_matches('"').to_string();
        } else if let Some(v) = line.strip_prefix("config/features=") {
            // formato: PackedStringArray("4.7", "Forward Plus")
            features = v
                .split('"')
                .enumerate()
                .filter(|(i, _)| i % 2 == 1)
                .map(|(_, s)| s.to_string())
                .collect();
        }
    }
    Ok(ProjectInfo { path, name, features })
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Procura todos os .glb/.gltf do projeto. Pastas que começam com "." e as da lista `ignore` são puladas.
#[tauri::command]
fn list_models(root: String, ignore: Vec<String>) -> Result<Vec<ModelEntry>, String> {
    let is_model = |n: &str| {
        let n = n.to_lowercase();
        n.ends_with(".glb") || n.ends_with(".gltf")
    };
    Ok(collect(&root, &ignore, &is_model))
}

/// Procura os mapas da ferramenta (*.map.json) no projeto.
#[tauri::command]
fn list_maps(root: String, ignore: Vec<String>) -> Result<Vec<ModelEntry>, String> {
    Ok(collect(&root, &ignore, &|n: &str| n.to_lowercase().ends_with(".map.json")))
}

/// Lê um arquivo de texto (mapa .map.json).
#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Não consegui ler {path}: {e}"))
}

/// Grava um arquivo de texto, criando as pastas que faltarem (mapa .map.json e cena .tscn).
#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    if let Some(dir) = Path::new(&path).parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| format!("Não consegui gravar {path}: {e}"))
}

fn collect(root: &str, ignore: &[String], accept: &dyn Fn(&str) -> bool) -> Vec<ModelEntry> {
    let root = PathBuf::from(root);
    let mut out = Vec::new();
    walk(&root, &root, ignore, accept, &mut out);
    out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    out
}

fn walk(root: &Path, dir: &Path, ignore: &[String], accept: &dyn Fn(&str) -> bool, out: &mut Vec<ModelEntry>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if name.starts_with('.') || ignore.iter().any(|i| i.eq_ignore_ascii_case(&name)) {
                continue;
            }
            walk(root, &p, ignore, accept, out);
            continue;
        }
        if !accept(&name) {
            continue;
        }
        let meta = e.metadata().ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
        out.push(ModelEntry { rel, abs: p.to_string_lossy().to_string(), size, mtime });
    }
}

/// Arquivo da miniatura no cache do app; a chave junta caminho e data, então um modelo alterado ganha miniatura nova.
fn thumb_file(app: &tauri::AppHandle, abs: &str, mtime: u64) -> Result<PathBuf, String> {
    let mut h = DefaultHasher::new();
    abs.hash(&mut h);
    mtime.hash(&mut h);
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("thumbs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{:016x}.png", h.finish())))
}

/// Devolve o caminho da miniatura se ela já foi gerada.
#[tauri::command]
fn get_thumb(app: tauri::AppHandle, abs: String, mtime: u64) -> Result<Option<String>, String> {
    let f = thumb_file(&app, &abs, mtime)?;
    Ok(f.exists().then(|| f.to_string_lossy().to_string()))
}

/// Grava a miniatura (PNG gerado pela interface) e devolve o caminho dela.
#[tauri::command]
fn save_thumb(app: tauri::AppHandle, abs: String, mtime: u64, png: Vec<u8>) -> Result<String, String> {
    let f = thumb_file(&app, &abs, mtime)?;
    fs::write(&f, png).map_err(|e| e.to_string())?;
    Ok(f.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_project,
            path_exists,
            list_models,
            list_maps,
            read_text,
            write_text,
            get_thumb,
            save_thumb,
            sync::sync_godot,
            sync::godot_import
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Alvorland Studio");
}
