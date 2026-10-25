// Tela principal: escolher o projeto Godot, navegar pelas pastas de modelos, ver cada um em 3D e abrir os mapas.
import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openProject, listModels, listMaps, type ProjectInfo, type ModelEntry } from "./api";
import Card from "./Card";
import Viewer from "./Viewer";
import MapEditor from "./map/MapEditor";

const RECENT_KEY = "recentProjects";
const IGNORE_KEY = "ignoredFolders";
const DEFAULT_IGNORE = "backups, node_modules, addons";
const HIDDEN_KEY = "mapFolders:";

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

/** mapa aberto no editor: null = nenhum; file null = mapa novo */
type Editing = { file: string | null } | null;

export default function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readJson(RECENT_KEY, []));
  const [ignore, setIgnore] = useState<string>(() => readJson(IGNORE_KEY, DEFAULT_IGNORE));
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [maps, setMaps] = useState<ModelEntry[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ModelEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  // pastas que não são peças (ex.: cenas inteiras do Blender): ficam fora de "Todos" e da paleta do mapa
  const [hidden, setHidden] = useState<string[]>([]);

  const ignoreList = () => ignore.split(",").map((s) => s.trim()).filter(Boolean);

  function toggleHidden(f: string) {
    if (!project) return;
    const next = hidden.includes(f) ? hidden.filter((x) => x !== f) : [...hidden, f];
    setHidden(next);
    writeJson(HIDDEN_KEY + project.path, next);
  }

  async function load(path: string) {
    setError(null);
    setLoading(true);
    try {
      const info = await openProject(path);
      const [list, mapList] = await Promise.all([listModels(info.path, ignoreList()), listMaps(info.path, ignoreList())]);
      setProject(info);
      setModels(list);
      setMaps(mapList);
      setHidden(readJson(HIDDEN_KEY + info.path, []));
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

  async function reloadMaps() {
    if (project) setMaps(await listMaps(project.path, ignoreList()));
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

  const pieces = useMemo(() => models.filter((m) => !hidden.includes(folderOf(m.rel))), [models, hidden]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = folder === null ? pieces : models.filter((m) => folderOf(m.rel) === folder);
    return base.filter((m) => !q || m.rel.toLowerCase().includes(q));
  }, [models, pieces, folder, filter]);

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

  if (editing) {
    return (
      <MapEditor
        key={editing.file ?? "novo"}
        project={project}
        models={pieces}
        file={editing.file}
        onClose={() => setEditing(null)}
        onSaved={reloadMaps}
      />
    );
  }

  const shownFolders = folders.filter(([f]) => !hidden.includes(f));
  const hiddenFolders = folders.filter(([f]) => hidden.includes(f));
  const folderRow = ([f, n]: [string, number]) => (
    <div key={f} className={folder === f ? "folder active" : "folder"}>
      <button className="folder-name" onClick={() => setFolder(f)} title={f}>
        {f} <span>{n}</span>
      </button>
      <button
        className="folder-move"
        onClick={() => toggleHidden(f)}
        title={hidden.includes(f) ? "Voltar a usar como peças" : "Não são peças (ex.: cena inteira): tirar de Todos e da paleta do mapa"}
      >
        {hidden.includes(f) ? "↑" : "↓"}
      </button>
    </div>
  );

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
        <h4>Mapas</h4>
        {maps.map((m) => (
          <div key={m.abs} className="folder">
            <button className="folder-name" onClick={() => setEditing({ file: m.abs })} title={m.rel}>
              {m.rel.split("/").pop()!.replace(/\.map\.json$/i, "")} <span>{folderOf(m.rel)}</span>
            </button>
          </div>
        ))}
        <button className="new-map" onClick={() => setEditing({ file: null })}>+ Novo mapa</button>
        <h4>Modelos</h4>
        <div className={folder === null ? "folder active" : "folder"}>
          <button className="folder-name" onClick={() => setFolder(null)}>
            Todos <span>{pieces.length}</span>
          </button>
        </div>
        {shownFolders.map(folderRow)}
        {hiddenFolders.length > 0 && <h4>Não são peças</h4>}
        {hiddenFolders.map(folderRow)}
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
