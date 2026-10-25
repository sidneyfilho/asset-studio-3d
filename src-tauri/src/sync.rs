// Sincronização da pasta de origem (doc-alvorland) com o projeto Godot.
// A origem manda: a pasta de destino no Godot fica igual a ela. Arquivos que sumiram da origem são
// apagados no destino. Ficam só os arquivos que o próprio Godot cria ao importar: o ".import" de cada
// arquivo e as texturas que ele extrai de um .glb (nome começando com o nome do .glb + "_").
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Deserialize)]
pub struct MapOut {
    /// nome do arquivo da cena dentro da pasta de mapas do Godot (ex.: casa.tscn)
    name: String,
    content: String,
}

#[derive(Deserialize)]
pub struct SyncRequest {
    godot_project: String,
    src_assets: String,
    dst_assets: String,
    dst_maps: String,
    maps: Vec<MapOut>,
    /// false = só calcula o que vai acontecer (para mostrar antes de confirmar)
    apply: bool,
}

#[derive(Serialize, Default)]
pub struct SyncReport {
    copied: Vec<String>,
    unchanged: usize,
    removed: Vec<String>,
    maps_written: Vec<String>,
    maps_removed: Vec<String>,
}

/// Arquivos (caminho relativo com "/") debaixo de `root`, pulando pastas que começam com "."
fn files(root: &Path) -> Vec<String> {
    fn go(root: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                if !name.starts_with('.') {
                    go(root, &p, out);
                }
            } else if let Ok(r) = p.strip_prefix(root) {
                out.push(r.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = Vec::new();
    go(root, root, &mut out);
    out.sort();
    out
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(ma), Ok(mb)) if ma.len() == mb.len() => fs::read(a).ok() == fs::read(b).ok(),
        _ => false,
    }
}

/// O destino precisa ser uma subpasta do projeto Godot (nunca a raiz, nunca fora dele)
fn check_inside(project: &Path, dst: &Path) -> Result<(), String> {
    let p = project.canonicalize().map_err(|_| format!("Projeto Godot não encontrado: {}", project.display()))?;
    if !p.join("project.godot").exists() {
        return Err(format!("Não achei project.godot em {}", p.display()));
    }
    // o destino pode ainda não existir: confere pelo caminho do pai mais próximo que existe
    let mut probe = dst.to_path_buf();
    while !probe.exists() {
        match probe.parent() {
            Some(x) => probe = x.to_path_buf(),
            None => break,
        }
    }
    let probe = probe.canonicalize().map_err(|e| e.to_string())?;
    let rest = dst.strip_prefix(&probe).unwrap_or(Path::new(""));
    let full = probe.join(rest);
    if full == p || !full.starts_with(&p) {
        return Err(format!("A pasta de destino precisa ficar dentro do projeto Godot (e não pode ser a raiz): {}", dst.display()));
    }
    Ok(())
}

/// Arquivos que o Godot gera ao importar e que devem ficar no destino
fn godot_generated(rel: &str, keep: &HashSet<String>) -> bool {
    if let Some(base) = rel.strip_suffix(".import") {
        return keep.contains(base) || godot_generated(base, keep);
    }
    let lower = rel.to_lowercase();
    if [".png", ".jpg", ".jpeg", ".webp"].iter().any(|x| lower.ends_with(x)) {
        let (dir, name) = match rel.rfind('/') {
            Some(i) => (&rel[..=i], &rel[i + 1..]),
            None => ("", rel),
        };
        return keep.iter().any(|k| {
            let kl = k.to_lowercase();
            if !(kl.ends_with(".glb") || kl.ends_with(".gltf")) || !k.starts_with(dir) || k[dir.len()..].contains('/') {
                return false;
            }
            let stem = &k[dir.len()..k.rfind('.').unwrap()];
            name.starts_with(&format!("{stem}_"))
        });
    }
    false
}

fn remove_empty_dirs(dir: &Path, root: &Path) {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                remove_empty_dirs(&e.path(), root);
            }
        }
    }
    if dir != root && fs::read_dir(dir).map(|mut r| r.next().is_none()).unwrap_or(false) {
        let _ = fs::remove_dir(dir);
    }
}

#[tauri::command]
pub fn sync_godot(req: SyncRequest) -> Result<SyncReport, String> {
    let project = PathBuf::from(&req.godot_project);
    let src = PathBuf::from(&req.src_assets);
    let dst = PathBuf::from(&req.dst_assets);
    let dst_maps = PathBuf::from(&req.dst_maps);
    check_inside(&project, &dst)?;
    check_inside(&project, &dst_maps)?;
    if !src.is_dir() {
        return Err(format!("Pasta de origem não encontrada: {}", src.display()));
    }
    let mut rep = SyncReport::default();

    // 1) modelos e texturas: copia o que é novo ou mudou
    let keep: HashSet<String> = files(&src).into_iter().collect();
    let mut sorted: Vec<&String> = keep.iter().collect();
    sorted.sort();
    for rel in sorted {
        let (a, b) = (src.join(rel), dst.join(rel));
        if same_file(&a, &b) {
            rep.unchanged += 1;
            continue;
        }
        rep.copied.push(rel.clone());
        if req.apply {
            fs::create_dir_all(b.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::copy(&a, &b).map_err(|e| format!("Erro ao copiar {rel}: {e}"))?;
        }
    }
    // 2) apaga do destino o que não existe mais na origem
    for rel in files(&dst) {
        if keep.contains(&rel) || godot_generated(&rel, &keep) {
            continue;
        }
        rep.removed.push(rel.clone());
        if req.apply {
            fs::remove_file(dst.join(&rel)).map_err(|e| format!("Erro ao apagar {rel}: {e}"))?;
        }
    }
    if req.apply {
        remove_empty_dirs(&dst, &dst);
    }

    // 3) mapas: grava as cenas geradas e apaga as .tscn que não vêm mais de um mapa
    let names: HashSet<String> = req.maps.iter().map(|m| m.name.clone()).collect();
    for m in &req.maps {
        let p = dst_maps.join(&m.name);
        let changed = fs::read_to_string(&p).map(|t| t != m.content).unwrap_or(true);
        if changed {
            rep.maps_written.push(m.name.clone());
            if req.apply {
                fs::create_dir_all(&dst_maps).map_err(|e| e.to_string())?;
                fs::write(&p, &m.content).map_err(|e| format!("Erro ao gravar {}: {e}", m.name))?;
            }
        }
    }
    for rel in files(&dst_maps) {
        if rel.to_lowercase().ends_with(".tscn") && !names.contains(&rel) {
            rep.maps_removed.push(rel.clone());
            if req.apply {
                fs::remove_file(dst_maps.join(&rel)).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(rep)
}

/// Roda "godot --headless --import" para o Godot importar os arquivos novos sem abrir o editor.
#[tauri::command]
pub async fn godot_import(exe: String, project: String) -> Result<String, String> {
    if !Path::new(&exe).is_file() {
        return Err(format!("Executável do Godot não encontrado: {exe}"));
    }
    let out = tauri::async_runtime::spawn_blocking(move || {
        Command::new(&exe).args(["--headless", "--import", "--path", &project]).output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    // só as últimas linhas, sem as de progresso
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('[')).collect();
    Ok(lines[lines.len().saturating_sub(15)..].join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, s: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, s).unwrap();
    }

    #[test]
    fn mirror_keeps_godot_files_and_removes_orphans() {
        let base = std::env::temp_dir().join(format!("studio_sync_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (src, godot) = (base.join("doc/assets"), base.join("godot"));
        write(&godot.join("project.godot"), "config_version=5");
        let dst = godot.join("assets/items");
        write(&src.join("kit/wall.glb"), "wall-v2");
        write(&src.join("kit/new.glb"), "new");
        write(&dst.join("kit/wall.glb"), "wall-v1");
        write(&dst.join("kit/wall.glb.import"), "imp");
        write(&dst.join("kit/wall_tex_pedra.png"), "tex");
        write(&dst.join("kit/wall_tex_pedra.png.import"), "imp");
        write(&dst.join("kit/old.glb"), "old");
        write(&dst.join("kit/old.glb.import"), "imp");
        write(&dst.join("kit/old_tex.png"), "tex");
        write(&dst.join("gone/x.glb"), "x");
        write(&godot.join("maps/stale.tscn"), "s");
        let req = |apply| SyncRequest {
            godot_project: godot.to_string_lossy().into(),
            src_assets: src.to_string_lossy().into(),
            dst_assets: dst.to_string_lossy().into(),
            dst_maps: godot.join("maps").to_string_lossy().into(),
            maps: vec![MapOut { name: "casa.tscn".into(), content: "[gd_scene format=3]".into() }],
            apply,
        };
        let plan = sync_godot(req(false)).unwrap();
        assert_eq!(plan.copied, vec!["kit/new.glb", "kit/wall.glb"]);
        assert!(dst.join("kit/old.glb").exists(), "o plano não pode apagar nada");
        let r = sync_godot(req(true)).unwrap();
        let mut removed = r.removed.clone();
        removed.sort();
        assert_eq!(removed, vec!["gone/x.glb", "kit/old.glb", "kit/old.glb.import", "kit/old_tex.png"]);
        assert_eq!(fs::read_to_string(dst.join("kit/wall.glb")).unwrap(), "wall-v2");
        assert!(dst.join("kit/wall.glb.import").exists());
        assert!(dst.join("kit/wall_tex_pedra.png").exists());
        assert!(dst.join("kit/wall_tex_pedra.png.import").exists());
        assert!(!dst.join("gone").exists(), "pasta vazia sai");
        assert_eq!(r.maps_written, vec!["casa.tscn"]);
        assert_eq!(r.maps_removed, vec!["stale.tscn"]);
        let again = sync_godot(req(false)).unwrap();
        assert!(again.copied.is_empty() && again.removed.is_empty() && again.maps_written.is_empty());
        // destino na raiz do projeto ou fora dele é recusado
        let mut bad = req(true);
        bad.dst_assets = godot.to_string_lossy().into();
        assert!(sync_godot(bad).is_err());
        let mut out = req(true);
        out.dst_assets = base.join("outside").to_string_lossy().into();
        assert!(sync_godot(out).is_err());
        let _ = fs::remove_dir_all(&base);
    }
}
