// Editor de mapa: paleta de modelos à esquerda, vista 3D no meio, dados do objeto selecionado à direita.
// Clique num modelo da paleta e clique no chão para colocar; clique num objeto para selecionar e arrastar.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pathExists, readText, writeText, type ModelEntry } from "../api";
import Card, { modelName } from "../Card";
import { joinPath, type Workspace } from "../workspace";
import { MapScene, type GizmoMode, type Snap } from "./mapScene";
import { newId, newMap, parseMap, serializeMap, type MapData, type MapInstance } from "./mapFile";

type Props = {
  ws: Workspace;
  models: ModelEntry[];
  /** caminho do .map.json aberto; null = mapa novo */
  file: string | null;
  onClose: () => void;
  onSaved: () => void;
};

/** Ângulo em graus entre 0 e 360, com duas casas */
const normDeg = (d: number) => Math.round((((d % 360) + 360) % 360) * 100) / 100;
/** Posição com precisão de milímetro (evita 0,30000000004 no arquivo) */
const roundPos = (p: [number, number, number]): [number, number, number] => p.map((v) => Math.round(v * 1000) / 1000) as [number, number, number];

const folderOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".");

export default function MapEditor({ ws, models, file, onClose, onSaved }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MapScene | null>(null);
  const [map, setMap] = useState<MapData>(() => newMap("mapa_novo"));
  const [path, setPath] = useState<string | null>(file);
  const [history, setHistory] = useState<MapData[]>([]);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [placeRot, setPlaceRot] = useState(0);
  const [snap, setSnap] = useState<Snap>("cell");
  const [mode, setMode] = useState<GizmoMode>("translate");
  const [folder, setFolder] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [message, setMessage] = useState<string>("");

  const absOf = useCallback((rel: string) => joinPath(ws.assets, rel), [ws.assets]);

  // mapRef sempre tem o mapa atual, assim as mudanças vindas do mouse não usam um estado velho
  const mapRef = useRef(map);
  const historyRef = useRef(history);
  const setMapNow = (m: MapData) => {
    mapRef.current = m;
    setMap(m);
  };

  // muda o mapa guardando o estado anterior para o Ctrl+Z
  const change = useCallback((fn: (m: MapData) => MapData) => {
    historyRef.current = [...historyRef.current.slice(-99), mapRef.current];
    setHistory(historyRef.current);
    setMapNow(fn(mapRef.current));
    setDirty(true);
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.length) return;
    historyRef.current = h.slice(0, -1);
    setHistory(historyRef.current);
    setMapNow(h[h.length - 1]);
    setDirty(true);
  }, []);

  // abre o arquivo do mapa
  useEffect(() => {
    if (!file) return;
    readText(file)
      .then((t) => setMapNow(parseMap(t)))
      .catch((e) => setMessage(String(e)));
  }, [file]);

  // cria a cena 3D uma vez; os avisos do mouse viram mudanças no mapa
  const placingRef = useRef(placing);
  const placeRotRef = useRef(placeRot);
  placingRef.current = placing;
  placeRotRef.current = placeRot;
  useEffect(() => {
    const s = new MapScene(host.current!, absOf, {
      onPlace: (pos) => {
        const model = placingRef.current;
        if (!model) return;
        const inst: MapInstance = { id: newId(), model, pos, rotY: placeRotRef.current, scale: 1 };
        change((m) => ({ ...m, instances: [...m.instances, inst] }));
      },
      onPick: (id) => setSelected(id),
      onMove: (id, pos, rotY) =>
        change((m) => ({ ...m, instances: m.instances.map((i) => (i.id === id ? { ...i, pos: roundPos(pos), rotY: normDeg(rotY) } : i)) })),
    });
    sceneRef.current = s;
    s.setInstances(mapRef.current.instances);
    return () => {
      s.dispose();
      sceneRef.current = null;
    };
  }, [absOf, change]);

  useEffect(() => sceneRef.current?.setInstances(map.instances), [map.instances]);
  useEffect(() => sceneRef.current?.setSelected(selected), [selected]);
  useEffect(() => void sceneRef.current?.setGhost(placing, placeRot), [placing, placeRot]);
  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.snap = snap;
    sceneRef.current.setMode(mode);
  }, [snap, mode]);

  const sel = map.instances.find((i) => i.id === selected) ?? null;
  const locked = map.instances.filter((i) => i.locked);
  const update = (id: string, patch: Partial<MapInstance>) =>
    change((m) => ({ ...m, instances: m.instances.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
  const remove = (id: string) => {
    change((m) => ({ ...m, instances: m.instances.filter((i) => i.id !== id) }));
    setSelected(null);
  };
  const duplicate = (i: MapInstance) => {
    const copy = { ...i, id: newId(), pos: [i.pos[0] + map.cell, i.pos[1], i.pos[2]] as [number, number, number] };
    change((m) => ({ ...m, instances: [...m.instances, copy] }));
    setSelected(copy.id);
  };

  // o mapa é gravado na pasta de mapas da origem com o nome dele; a cena do Godot só sai ao sincronizar
  async function doSave() {
    let p = path;
    if (!p) {
      const name = map.name.trim().replace(/[^A-Za-z0-9_-]/g, "_") || "mapa";
      p = joinPath(ws.maps, `${name}.map.json`);
      if ((await pathExists(p)) && !confirm(`Já existe um mapa chamado ${name}. Substituir?`)) return;
    }
    try {
      await writeText(p, serializeMap(map));
      setPath(p);
      setDirty(false);
      setMessage("Salvo. Use Sincronizar na tela inicial para mandar ao Godot.");
      onSaved();
    } catch (e) {
      setMessage(String(e));
    }
  }

  // atalhos de teclado (fora das caixas de texto)
  const keyState = { placing, sel, doSave, undo };
  const keyRef = useRef(keyState);
  keyRef.current = keyState;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, select, textarea")) return;
      const k = keyRef.current;
      if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); k.doSave(); return; }
      if (e.ctrlKey && e.key.toLowerCase() === "z") { e.preventDefault(); k.undo(); return; }
      if (e.ctrlKey && e.key.toLowerCase() === "d" && k.sel) { e.preventDefault(); duplicate(k.sel); return; }
      if (e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === "w") setMode("translate");
      if (key === "e") setMode("rotate");
      // R gira 90°; Q e T giram 15° (com Shift, 1°)
      const turn = key === "r" ? (e.shiftKey ? -90 : 90) : key === "q" ? (e.shiftKey ? -1 : -15) : key === "t" ? (e.shiftKey ? 1 : 15) : 0;
      if (turn) {
        if (k.placing) setPlaceRot((r) => normDeg(r + turn));
        else if (k.sel) update(k.sel.id, { rotY: normDeg(k.sel.rotY + turn) });
      }
      // Page Up / Page Down sobem e descem 10 cm (com Shift, 1 cm)
      if ((e.key === "PageUp" || e.key === "PageDown") && k.sel) {
        e.preventDefault();
        const dy = (e.key === "PageUp" ? 1 : -1) * (e.shiftKey ? 0.01 : 0.1);
        update(k.sel.id, { pos: roundPos([k.sel.pos[0], k.sel.pos[1] + dy, k.sel.pos[2]]) });
      }
      if ((e.key === "Delete" || e.key === "Backspace") && k.sel) remove(k.sel.id);
      if (e.key === "Escape") { setPlacing(null); setSelected(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const folders = useMemo(() => [...new Set(models.map((m) => folderOf(m.rel)))].sort(), [models]);
  const palette = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return models.filter((m) => (!folder || folderOf(m.rel) === folder) && (!q || m.rel.toLowerCase().includes(q)));
  }, [models, folder, filter]);

  const fileName = path ? path.split(/[\\/]/).pop() : "(não salvo)";
  return (
    <div className="editor">
      <header>
        <button onClick={() => (!dirty || confirm("Sair sem salvar as mudanças?")) && onClose()}>← Voltar</button>
        <label>
          Nome <input value={map.name} onChange={(e) => change((m) => ({ ...m, name: e.target.value }))} />
        </label>
        <span className="muted">{fileName}{dirty ? " •" : ""}</span>
        <label>
          Encaixe
          <select value={snap} onChange={(e) => setSnap(e.target.value as Snap)}>
            <option value="cell">Centro da célula ({map.cell} m)</option>
            <option value="half">Meio metro</option>
            <option value="free">Livre</option>
          </select>
        </label>
        <div className="modes">
          <button className={mode === "translate" ? "on" : ""} onClick={() => setMode("translate")} title="W: setas para mover; a verde sobe e desce">Mover (W)</button>
          <button className={mode === "rotate" ? "on" : ""} onClick={() => setMode("rotate")} title="E: anel para girar em volta do eixo vertical">Girar (E)</button>
        </div>
        <span className="muted">{map.instances.length} objetos</span>
        <span className="spacer" />
        <span className="muted msg">{message}</span>
        <button onClick={undo} disabled={!history.length} title="Ctrl+Z">Desfazer</button>
        <button className="primary" onClick={doSave} title="Ctrl+S">Salvar</button>
      </header>
      <aside className="palette">
        <select value={folder} onChange={(e) => setFolder(e.target.value)}>
          <option value="">Todas as pastas</option>
          {folders.map((f) => <option key={f}>{f}</option>)}
        </select>
        <input placeholder="Filtrar…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="grid small">
          {palette.map((m) => (
            <Card
              key={m.abs}
              model={m}
              small
              active={placing === m.rel}
              onClick={() => { setPlacing(placing === m.rel ? null : m.rel); setSelected(null); }}
            />
          ))}
        </div>
      </aside>
      <div className="editor-view">
        <div className="editor-canvas" ref={host} />
        <div className="help">
          {placing
            ? `Colocando ${modelName(placing)}: clique no chão · R gira (${placeRot}°) · Esc para parar`
            : sel
              ? "W mover (seta verde sobe/desce) · E girar · R 90° · Q/T 15° · Page Up/Down altura · Delete apaga · Ctrl+D duplica"
              : "Escolha um modelo na paleta · clique num objeto para selecionar · botão direito gira a vista · botão do meio arrasta · roda dá zoom"}
        </div>
      </div>
      <section className="inspector">
        {sel ? (
          <>
            <h3 title={sel.model}>{modelName(sel.model)}</h3>
            <div className="muted">{sel.model}</div>
            <div className="fields">
              {(["X", "Y", "Z"] as const).map((axis, k) => (
                <label key={axis}>
                  {axis} (m)
                  <input
                    type="number"
                    step={0.5}
                    value={Number(sel.pos[k].toFixed(3))}
                    onChange={(e) => {
                      const pos = [...sel.pos] as [number, number, number];
                      pos[k] = Number(e.target.value);
                      update(sel.id, { pos });
                    }}
                  />
                </label>
              ))}
              <label>
                Giro (°)
                <input type="number" step={15} value={sel.rotY} onChange={(e) => update(sel.id, { rotY: Number(e.target.value) })} />
              </label>
              <label>
                Escala
                <input type="number" step={0.1} min={0.1} value={sel.scale} onChange={(e) => update(sel.id, { scale: Math.max(0.01, Number(e.target.value)) })} />
              </label>
            </div>
            <div className="actions">
              <button onClick={() => update(sel.id, { rotY: (sel.rotY + 90) % 360 })} title="R">Girar 90°</button>
              <button onClick={() => duplicate(sel)} title="Ctrl+D">Duplicar</button>
              <button onClick={() => remove(sel.id)} title="Delete">Apagar</button>
            </div>
            <label className="check">
              <input type="checkbox" checked={Boolean(sel.locked)} onChange={(e) => update(sel.id, { locked: e.target.checked })} />
              Travado (não seleciona clicando na vista; bom para a base do mapa)
            </label>
          </>
        ) : (
          <div className="muted">Nenhum objeto selecionado.</div>
        )}
        {locked.length > 0 && (
          <div className="locked-list">
            <h4>Travados</h4>
            {locked.map((i) => (
              <button key={i.id} className="link" onClick={() => { setPlacing(null); setSelected(i.id); }}>
                {modelName(i.model)}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
