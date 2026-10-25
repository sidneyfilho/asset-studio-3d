// Tela principal: abrir a pasta de origem (ex.: doc-alvorland), navegar pelos modelos, ver cada um em 3D,
// abrir os mapas e sincronizar tudo com o projeto Godot.
import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openProject, listModels, listMaps, type ProjectInfo, type ModelEntry } from "./api";
import { loadConfig, resolveWorkspace, saveConfig, type Workspace, type WsConfig } from "./workspace";
import Card from "./Card";
import Viewer from "./Viewer";
import MapEditor from "./map/MapEditor";
import SyncDialog from "./SyncDialog";
import ConfigDialog from "./ConfigDialog";

const RECENT_KEY = "recentSources";
const HIDDEN_KEY = "hiddenFolders:";
const EXE_KEY = "godotExe";
const DEFAULT_EXE = "C:\\Program Files\\Godot_v4.7\\Godot_v4.7.2-stable_win64_console.exe";

// localStorage só guarda preferências desta janela (pastas recentes, executável do Godot)
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

/** Pasta do modelo, relativa à pasta de modelos (ex.: nature) */
const folderOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".");

/** mapa aberto no editor: null = nenhum; file null = mapa novo */
type Editing = { file: string | null } | null;

export default function App() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [godot, setGodot] = useState<ProjectInfo | null>(null);
  const [godotError, setGodotError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readJson(RECENT_KEY, []));
  const [godotExe, setGodotExe] = useState<string>(() => readJson(EXE_KEY, DEFAULT_EXE));
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [maps, setMaps] = useState<ModelEntry[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ModelEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [syncing, setSyncing] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  // pastas que não são peças (ex.: cenas inteiras do Blender): ficam fora de "Todos" e da paleta do mapa
  const [hidden, setHidden] = useState<string[]>([]);

  function toggleHidden(f: string) {
    if (!ws) return;
    const next = hidden.includes(f) ? hidden.filter((x) => x !== f) : [...hidden, f];
    setHidden(next);
    writeJson(HIDDEN_KEY + ws.root, next);
  }

  async function load(root: string, config?: WsConfig) {
    setError(null);
    setLoading(true);
    try {
      const w = resolveWorkspace(root, config ?? (await loadConfig(root)));
      const [list, mapList] = await Promise.all([listModels(w.assets, []), listMaps(w.maps, [])]);
      setWs(w);
      setModels(list);
      setMaps(mapList);
      setHidden(readJson(HIDDEN_KEY + root, []));
      setSelected((s) => (s && list.some((m) => m.abs === s.abs) ? s : null));
      // o projeto Godot de destino pode ainda não estar configurado: a origem abre mesmo assim
      openProject(w.godot)
        .then((g) => { setGodot(g); setGodotError(null); })
        .catch((e) => { setGodot(null); setGodotError(String(e)); });
      const r = [root, ...recent.filter((p) => p !== root)].slice(0, 8);
      setRecent(r);
      writeJson(RECENT_KEY, r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function reloadMaps() {
    if (ws) setMaps(await listMaps(ws.maps, []));
  }

  async function pickSource() {
    const dir = await open({ directory: true, title: "Escolha a pasta de origem (ex.: doc-alvorland)" });
    if (typeof dir === "string") load(dir);
  }

  async function saveSettings(c: WsConfig, exe: string) {
    if (!ws) return;
    await saveConfig(ws.root, c);
    setGodotExe(exe);
    writeJson(EXE_KEY, exe);
    setConfiguring(false);
    load(ws.root, c);
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

  if (!ws) {
    return (
      <div className="start">
        <h1>Alvorland Studio</h1>
        <p className="muted">
          Abra a pasta de origem (ex.: doc-alvorland). Os modelos ficam em <code>assets</code> e os mapas em <code>map</code>;
          o botão Sincronizar deixa o projeto Godot igual a ela.
        </p>
        <button className="primary" onClick={pickSource} disabled={loading}>Abrir pasta de origem…</button>
        {error && <div className="error">{error}</div>}
        {recent.length > 0 && (
          <div className="recent">
            <h4>Recentes</h4>
            {recent.map((p) => (
              <button key={p} className="link" onClick={() => load(p)} title={p}>{p}</button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (editing) {
    return (
      <MapEditor
        key={editing.file ?? "novo"}
        ws={ws}
        models={pieces}
        file={editing.file}
        onClose={() => { setEditing(null); reloadMaps(); }}
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
        <strong>{ws.root.split("\\").pop()}</strong>
        <span className="muted" title={ws.godot}>
          → {godot ? `Godot: ${godot.name}` : <span className="warn">projeto Godot não encontrado</span>}
        </span>
        <span className="spacer" />
        <button onClick={() => load(ws.root)} title="Ler as pastas de novo">Recarregar</button>
        <button onClick={() => setConfiguring(true)}>Configurar</button>
        <button className="primary" onClick={() => setSyncing(true)} disabled={!godot} title={godotError ?? ""}>Sincronizar com o Godot</button>
        <button onClick={() => { setWs(null); setFolder(null); setSelected(null); }}>Trocar pasta</button>
      </header>
      <aside>
        <h4>Mapas</h4>
        {maps.map((m) => (
          <div key={m.abs} className="folder">
            <button className="folder-name" onClick={() => setEditing({ file: m.abs })} title={m.rel}>
              {m.rel.replace(/\.map\.json$/i, "")}
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
          {visible.length === 0 && (
            <div className="muted">
              Nenhum modelo aqui. Coloque os arquivos .glb (e as texturas deles) em <code>{ws.assets}</code> e clique em Recarregar.
            </div>
          )}
        </div>
      </main>
      <section className="side">
        {selected ? <Viewer model={selected} /> : <div className="muted pad">Clique num modelo para ver em 3D.</div>}
      </section>
      {syncing && <SyncDialog ws={ws} maps={maps} godotExe={godotExe} onClose={() => setSyncing(false)} />}
      {configuring && (
        <ConfigDialog root={ws.root} config={ws.config} godotExe={godotExe} onSave={saveSettings} onClose={() => setConfiguring(false)} />
      )}
    </div>
  );
}
