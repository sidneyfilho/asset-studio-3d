// Tela principal: escolher o projeto Godot, navegar pelas pastas de modelos e ver cada um em 3D.
import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openProject, listModels, type ProjectInfo, type ModelEntry } from "./api";
import { thumbnailFor } from "./three/thumbnails";
import Viewer from "./Viewer";

const RECENT_KEY = "recentProjects";
const IGNORE_KEY = "ignoredFolders";
const DEFAULT_IGNORE = "backups, node_modules, addons";

// localStorage só guarda preferências desta janela (projetos recentes, pastas ignoradas)
function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // sem armazenamento: só não lembra
  }
}

/** Pasta do modelo, relativa ao projeto (ex.: assets/nature) */
const folderOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".");

export default function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readJson(RECENT_KEY, []));
  const [ignore, setIgnore] = useState<string>(() => readJson(IGNORE_KEY, DEFAULT_IGNORE));
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ModelEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(path: string) {
    setError(null);
    setLoading(true);
    try {
      const info = await openProject(path);
      const ign = ignore.split(",").map((s) => s.trim()).filter(Boolean);
      const list = await listModels(info.path, ign);
      setProject(info);
      setModels(list);
      setSelected((s) => (s && list.some((m) => m.abs === s.abs) ? s : null));
      const r = [path, ...recent.filter((p) => p !== path)].slice(0, 8);
      setRecent(r);
      writeJson(RECENT_KEY, r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function pickProject() {
    const dir = await open({ directory: true, title: "Escolha a pasta do projeto Godot (com project.godot)" });
    if (typeof dir === "string") load(dir);
  }

  // pastas com a contagem de modelos em cada uma
  const folders = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of models) m.set(folderOf(x.rel), (m.get(folderOf(x.rel)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return models.filter((m) => (folder === null || folderOf(m.rel) === folder) && (!q || m.rel.toLowerCase().includes(q)));
  }, [models, folder, filter]);

  if (!project) {
    return (
      <div className="start">
        <h1>Alvorland Studio</h1>
        <p className="muted">Gerencia os modelos 3D e os mapas de um projeto Godot.</p>
        <button className="primary" onClick={pickProject} disabled={loading}>Abrir projeto…</button>
        {error && <div className="error">{error}</div>}
        {recent.length > 0 && (
          <div className="recent">
            <h4>Recentes</h4>
            {recent.map((p) => (
              <button key={p} className="link" onClick={() => load(p)} title={p}>{p}</button>
            ))}
          </div>
        )}
        <label className="ignore">
          Pastas ignoradas (separadas por vírgula)
          <input value={ignore} onChange={(e) => { setIgnore(e.target.value); writeJson(IGNORE_KEY, e.target.value); }} />
        </label>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <strong>{project.name}</strong>
        <span className="muted">{project.path}</span>
        <span className="muted">Godot {project.features.join(" · ")}</span>
        <span className="spacer" />
        <button onClick={() => load(project.path)} title="Ler as pastas de novo">Recarregar</button>
        <button onClick={() => { setProject(null); setFolder(null); setSelected(null); }}>Trocar projeto</button>
      </header>
      <aside>
        <button className={folder === null ? "folder active" : "folder"} onClick={() => setFolder(null)}>
          Todos <span>{models.length}</span>
        </button>
        {folders.map(([f, n]) => (
          <button key={f} className={folder === f ? "folder active" : "folder"} onClick={() => setFolder(f)} title={f}>
            {f} <span>{n}</span>
          </button>
        ))}
      </aside>
      <main>
        <input className="search" placeholder="Filtrar por nome…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="grid">
          {visible.map((m) => (
            <Card key={m.abs} model={m} active={selected?.abs === m.abs} onClick={() => setSelected(m)} />
          ))}
          {visible.length === 0 && <div className="muted">Nenhum modelo aqui.</div>}
        </div>
      </main>
      <section className="side">
        {selected ? <Viewer model={selected} /> : <div className="muted pad">Clique num modelo para ver em 3D.</div>}
      </section>
    </div>
  );
}

function Card({ model, active, onClick }: { model: ModelEntry; active: boolean; onClick: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // ao sair da tela o pedido é cancelado, assim a fila atende primeiro o que está sendo visto
    const ctl = new AbortController();
    thumbnailFor(model, ctl.signal)
      .then((u) => !ctl.signal.aborted && setSrc(u))
      .catch(() => !ctl.signal.aborted && setFailed(true));
    return () => ctl.abort();
  }, [model.abs, model.mtime]);
  const name = model.rel.split("/").pop()!.replace(/\.(glb|gltf)$/i, "");
  return (
    <button className={active ? "card active" : "card"} onClick={onClick} title={model.rel}>
      <div className="thumb">{src ? <img src={src} alt="" /> : <span className="muted">{failed ? "erro" : "…"}</span>}</div>
      <div className="name">{name}</div>
    </button>
  );
}
