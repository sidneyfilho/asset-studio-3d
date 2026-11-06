// Editor de mapa: paleta de modelos à esquerda, vista 3D no meio, dados do objeto selecionado à direita.
// Clique num modelo da paleta e clique no chão para colocar; clique num objeto para selecionar e arrastar.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pathExists, readText, writeText, type ModelEntry } from "../api";
import Card, { modelName } from "../Card";
import { joinPath, type Workspace } from "../workspace";
import { MapScene, type GizmoMode, type Snap } from "./mapScene";
import BlocksPanel, { type BlocksTab } from "../blocks/BlocksPanel";
import { useBlocksData } from "../blocks/useBlocksData";
import { BLOCK_TYPES, adjustPathOf, applyAdjust, blocksPathOf, parseAdjust, parseBlocks, serializeAdjust, type Adjust, type BlocksData } from "./blocks";
import { newId, newMap, parseMap, serializeMap, type MapData, type MapInstance, type ScatterLayer, type ScatterPoint } from "./mapFile";

type Props = {
  ws: Workspace;
  models: ModelEntry[];
  /** caminho do .map.json aberto; null = mapa novo */
  file: string | null;
  onClose: () => void;
  onSaved: () => void;
};

type Brush = { model: string | null; radius: number; density: number; min: number; max: number };

/** Um carimbo do pincel: põe cópias novas no círculo (sem encostar demais nas que já existem) ou apaga as de todas as camadas */
function paintScatter(list: ScatterLayer[], b: Brush, x: number, z: number, erase: boolean): ScatterLayer[] {
  const r2 = b.radius * b.radius;
  if (erase) {
    let changed = false;
    const out = list.map((l) => {
      const pts = l.points.filter((p) => (p[0] - x) ** 2 + (p[1] - z) ** 2 > r2);
      if (pts.length === l.points.length) return l;
      changed = true;
      return { ...l, points: pts };
    });
    return changed ? out : list;
  }
  if (!b.model) return list;
  const id = b.model.split("/").pop()!.replace(/\.(glb|gltf)$/i, "");
  const layer = list.find((l) => l.model === b.model) ?? { id, model: b.model, points: [] };
  const gap2 = (0.8 / Math.sqrt(b.density)) ** 2; // distância mínima entre cópias da mesma camada
  const near = layer.points.filter((p) => (p[0] - x) ** 2 + (p[1] - z) ** 2 < (b.radius + 1) ** 2);
  const added: ScatterPoint[] = [];
  const tries = Math.max(1, Math.round(b.density * Math.PI * r2 * 0.35));
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  for (let k = 0; k < tries; k++) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * b.radius;
    const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
    if ([...near, ...added].some((p) => (p[0] - px) ** 2 + (p[1] - pz) ** 2 < gap2)) continue;
    added.push([r3(px), r3(pz), Math.round(Math.random() * 3600) / 10, r3(b.min + Math.random() * (b.max - b.min))]);
  }
  if (!added.length) return list;
  const next = { ...layer, points: [...layer.points, ...added] };
  return list.some((l) => l.model === b.model) ? list.map((l) => (l.model === b.model ? next : l)) : [...list, next];
}

function BrushPanel({ brush, setBrush, layers, clearLayer }: {
  brush: Brush;
  setBrush: (b: Brush) => void;
  layers: ScatterLayer[];
  clearLayer: (id: string) => void;
}) {
  const num = (key: "radius" | "density" | "min" | "max", label: string, step: number) => (
    <label>
      {label}
      <input type="number" step={step} min={step} value={brush[key]} onChange={(e) => setBrush({ ...brush, [key]: Math.max(step, Number(e.target.value)) })} />
    </label>
  );
  return (
    <>
      <h3>Pincel</h3>
      <div className="muted">{brush.model ? modelName(brush.model) : "escolha um modelo na paleta"}</div>
      <div className="fields">
        {num("radius", "Raio (m)", 0.1)}
        {num("density", "Densidade (por m²)", 0.1)}
        {num("min", "Tamanho mín.", 0.05)}
        {num("max", "Tamanho máx.", 0.05)}
      </div>
      <div className="muted small brush-help">Arraste no chão para espalhar. Shift + arrastar apaga (todas as camadas). Ctrl+Z desfaz o traço.</div>
      <div className="locked-list">
        <h4>Camadas espalhadas</h4>
        {layers.map((l) => (
          <div key={l.id} className="layer-row">
            <button className="link" onClick={() => setBrush({ ...brush, model: l.model })}>{l.id} ({l.points.length})</button>
            <button className="link" onClick={() => clearLayer(l.id)} title="Apaga todas as cópias desta camada">apagar</button>
          </div>
        ))}
        {!layers.length && <div className="muted small">Nenhuma ainda.</div>}
      </div>
    </>
  );
}

/** Degrau máximo que a personagem sobe no jogo (STEP_H em scripts/main.gd) */
const STEP_H = 0.35;

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
  // escondidos só nesta sessão do editor (não vão para o arquivo nem para o jogo)
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // pincel: espalha cópias do modelo escolhido (grama, flores, pedrinhas); Shift + arrastar apaga
  const [brushOn, setBrushOn] = useState(false);
  const [brush, setBrush] = useState<Brush>({ model: null, radius: 1.5, density: 1.5, min: 0.85, max: 1.15 });
  const brushRef = useRef(brush);
  brushRef.current = brush;
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
      // um traço do pincel inteiro vira um passo só do Ctrl+Z
      onBrushStart: () => {
        historyRef.current = [...historyRef.current.slice(-99), mapRef.current];
        setHistory(historyRef.current);
      },
      onPaint: (x, z, erase) => {
        const m = mapRef.current;
        const scatter = paintScatter(m.scatter, brushRef.current, x, z, erase);
        if (scatter !== m.scatter) {
          setMapNow({ ...m, scatter });
          setDirty(true);
        }
      },
      onBrushEnd: () => undefined,
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
  useEffect(() => sceneRef.current?.setHidden(hidden), [hidden, map.instances]);
  useEffect(() => sceneRef.current?.setScatter(map.scatter), [map.scatter]);
  useEffect(() => sceneRef.current?.setBrush(brushOn ? brush.radius : 0), [brushOn, brush.radius]);
  useEffect(() => {
    if (brushOn) {
      setPlacing(null);
      setSelected(null);
    }
  }, [brushOn]);
  useEffect(() => void sceneRef.current?.setGhost(placing, placeRot), [placing, placeRot]);
  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.snap = snap;
    sceneRef.current.setMode(mode);
  }, [snap, mode]);

  const sel = map.instances.find((i) => i.id === selected) ?? null;
  // colisão: destaca o que é sólido no jogo; e a altura do objeto selecionado (o modelo carrega depois, por isso o atraso)
  const [showSolid, setShowSolid] = useState(false);
  // catálogo de colisão, áreas e validação (M4): a colisão desenhada vem dos perfis do catálogo, como no jogo
  // a validação só avisa dos modelos que este mapa usa (a biblioteca tem muitos que não entram nele)
  const modelRels = useMemo(() => [...new Set(map.instances.map((i) => i.model))].sort(), [map.instances]);
  const bdata = useBlocksData(ws, path, modelRels);
  const [showRules, setShowRules] = useState(false);
  const [rulesTab, setRulesTab] = useState<BlocksTab>("colisao");
  useEffect(() => sceneRef.current?.setCollisionView(showSolid ? bdata.resolver : null), [showSolid, bdata.resolver]);
  // bloqueios do jogo (T068): camada só de leitura, vinda de <mapa>.blocks.json (gerado pelo Godot ao sincronizar)
  const [blocks, setBlocks] = useState<BlocksData | null>(null);
  const [showBlocks, setShowBlocks] = useState(false);
  const [blockOn, setBlockOn] = useState<Record<string, boolean>>({});
  const [blockColor, setBlockColor] = useState<Record<string, string>>(() => Object.fromEntries(BLOCK_TYPES.map((t) => [t.id, t.color])));
  useEffect(() => {
    setBlocks(null);
    if (!path) return;
    const p = blocksPathOf(path);
    pathExists(p).then((ok) => (ok ? readText(p).then((t) => setBlocks(parseBlocks(t))) : undefined)).catch(() => undefined);
  }, [path]);
  // ajustes manuais (passo B): ficam em <mapa>.adjust.json; o desenho já mostra o valor ajustado
  const [adjust, setAdjust] = useState<Adjust>({});
  const [adjustDirty, setAdjustDirty] = useState(false);
  const [picking, setPicking] = useState<"rest_point" | "land_point" | null>(null);
  useEffect(() => {
    setAdjust({});
    setAdjustDirty(false);
    if (!path) return;
    const p = adjustPathOf(path);
    pathExists(p).then((ok) => (ok ? readText(p).then((t) => setAdjust(parseAdjust(t))) : undefined)).catch(() => undefined);
  }, [path]);
  const shown = useMemo(() => (blocks ? applyAdjust(blocks, adjust) : null), [blocks, adjust]);
  const patchAdjust = (patch: Adjust) => {
    setAdjust((a) => ({ ...a, ...patch }));
    setAdjustDirty(true);
  };
  const pickPoint = (key: "rest_point" | "land_point") => {
    setPicking(key);
    setPlacing(null);
    setBrushOn(false);
    sceneRef.current?.setPickPoint((x, z) => {
      patchAdjust({ [key]: [x, z] });
      setPicking(null);
    });
  };
  const cancelPick = () => {
    sceneRef.current?.setPickPoint(null);
    setPicking(null);
  };
  async function saveAdjust() {
    if (!path) return;
    try {
      await writeText(adjustPathOf(path), serializeAdjust(adjust));
      setAdjustDirty(false);
      setMessage("Ajustes salvos. Use Sincronizar na tela inicial para o jogo usar.");
    } catch (e) {
      setMessage(String(e));
    }
  }
  useEffect(() => sceneRef.current?.setBlocks(showBlocks ? shown : null, blockColor, blockOn), [shown, showBlocks]);
  useEffect(() => sceneRef.current?.setBlockStyle(blockColor, blockOn), [blockColor, blockOn]);
  const [selInfo, setSelInfo] = useState<{ top: number; base: number; solid: boolean } | null>(null);
  useEffect(() => {
    setSelInfo(null);
    if (!selected) return;
    const t = setTimeout(() => setSelInfo(sceneRef.current?.info(selected, bdata.resolver) ?? null), 400);
    return () => clearTimeout(t);
  }, [selected, sel?.pos[1], sel?.scale, bdata.resolver, sel?.collision]);
  const locked = map.instances.filter((i) => i.locked);
  const hiddenList = map.instances.filter((i) => hidden.has(i.id));
  // peças que o jogo esconde quando a personagem entra (telhado e paredes da frente)
  const isOuter = (i: MapInstance) => /(^|\/)(roof|front)[^/]*\.glb$/i.test(i.model);
  const outer = map.instances.filter(isOuter);
  const seeInside = outer.length > 0 && outer.every((i) => hidden.has(i.id));
  const setHiddenIds = (ids: string[], hide: boolean) =>
    setHidden((h) => {
      const n = new Set(h);
      for (const id of ids) hide ? n.add(id) : n.delete(id);
      return n;
    });
  const hide = (id: string) => {
    setHiddenIds([id], true);
    setSelected(null);
  };
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
  const keyState = { placing, sel, doSave, undo, hidden };
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
      if (key === "b") setBrushOn((v) => !v);
      if (key === "w") { setBrushOn(false); setMode("translate"); }
      if (key === "e") { setBrushOn(false); setMode("rotate"); }
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
      if (e.key === "Escape") { setPlacing(null); setSelected(null); setBrushOn(false); }
      // H esconde a peça selecionada; Alt+H mostra tudo de novo
      if (key === "h" && e.altKey) setHidden(new Set());
      else if (key === "h" && k.sel) hide(k.sel.id);
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
        <button className={showRules ? "on toggle" : "toggle"} onClick={() => setShowRules(!showRules)}
          title="Catálogo de colisão, áreas configuráveis e validação (os mesmos arquivos que o jogo lê)">
          Regras{bdata.catalogIssues.some((i) => i.level === "erro") ? " ⚠" : ""}
        </button>
        {outer.length > 0 && (
          <button className={showSolid ? "on toggle" : "toggle"} onClick={() => setShowSolid(!showSolid)}
            title="Mostra em vermelho as malhas que têm colisão no jogo (a personagem não atravessa; sobe degraus de até 35 cm)">
            Colisão
          </button>
        )}
        <button className={showBlocks ? "on toggle" : "toggle"} disabled={!blocks} onClick={() => setShowBlocks(!showBlocks)}
          title={blocks ? "Mostra por cima do mapa o que bloqueia a personagem, a mula e a voadora no jogo (só leitura)" : "Sem bloqueios deste mapa: sincronize com o Godot para gerar o arquivo .blocks.json"}>
          Bloqueios
        </button>
        {outer.length > 0 && (
          <button className={seeInside ? "on toggle" : "toggle"} onClick={() => setHiddenIds(outer.map((i) => i.id), !seeInside)}
            title="Esconde o telhado e as paredes da frente, como o jogo faz quando a personagem entra">
            {seeInside ? "Ver por fora" : "Ver dentro"}
          </button>
        )}
        <div className="modes">
          <button className={!brushOn && mode === "translate" ? "on" : ""} onClick={() => { setBrushOn(false); setMode("translate"); }} title="W: setas para mover; a verde sobe e desce">Mover (W)</button>
          <button className={!brushOn && mode === "rotate" ? "on" : ""} onClick={() => { setBrushOn(false); setMode("rotate"); }} title="E: anel para girar em volta do eixo vertical">Girar (E)</button>
          <button className={brushOn ? "on" : ""} onClick={() => setBrushOn(true)} title="B: espalha cópias (grama, flores, pedrinhas); Shift + arrastar apaga">Pincel (B)</button>
        </div>
        <span className="muted">{map.instances.length} objetos · {map.scatter.reduce((s, l) => s + l.points.length, 0)} espalhados</span>
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
              active={brushOn ? brush.model === m.rel : placing === m.rel}
              onClick={() => {
                if (brushOn) setBrush({ ...brush, model: m.rel });
                else { setPlacing(placing === m.rel ? null : m.rel); setSelected(null); }
              }}
            />
          ))}
        </div>
      </aside>
      <div className="editor-view">
        <div className="editor-canvas" ref={host} />
        <div className="help">
          {brushOn
            ? brush.model
              ? `Pincel com ${modelName(brush.model)}: arraste no chão para espalhar · Shift + arrastar apaga · Esc para sair`
              : "Pincel: escolha na paleta o que espalhar (ex.: grass_a, flower_w, pebble_a) · Shift + arrastar apaga"
            : placing
            ? `Colocando ${modelName(placing)}: clique no chão · R gira (${placeRot}°) · Esc para parar`
            : sel
              ? "W mover (seta verde sobe/desce) · E girar · R 90° · Q/T 15° · Page Up/Down altura · H esconde · Delete apaga · Ctrl+D duplica"
              : "Escolha um modelo na paleta · clique num objeto para selecionar · botão direito gira a vista · botão do meio arrasta · roda dá zoom"}
        </div>
      </div>
      <section className="inspector">
        {showRules && (
          <BlocksPanel data={bdata} instances={map.instances} selected={sel} scene={sceneRef.current} hasMapFile={Boolean(path)} tab={rulesTab} setTab={setRulesTab}
            setInstanceCollision={(id, profile) => update(id, { collision: profile })} setInstanceNoAreas={(id, value) => update(id, { noAreas: value || undefined })} setMessage={setMessage} />
        )}
        {showBlocks && blocks && (
          <div className="locked-list blocks-panel">
            <h4>Bloqueios do jogo (só leitura)</h4>
            {BLOCK_TYPES.map((t) => (
              <label key={t.id} className="block-row" title={t.hint}>
                <input type="checkbox" checked={blockOn[t.id] !== false} onChange={(e) => setBlockOn({ ...blockOn, [t.id]: e.target.checked })} />
                <input type="color" value={blockColor[t.id]} onChange={(e) => setBlockColor({ ...blockColor, [t.id]: e.target.value })} />
                {t.label}
              </label>
            ))}
            <div className="muted small">Cores e interruptores são só para ver. O arquivo de bloqueios é regerado ao sincronizar.</div>
            <h4>Ajustes manuais</h4>
            {shown && (
              <div className="fields">
                {(
                  [
                    ["Limite do mapa (m do centro)", "half_extent", shown.bounds.half_extent, 1],
                    ["Raio de passeio da mula (m)", "wander_radius", shown.mule.wander_radius, 0.5],
                    ["Folga das áreas proibidas (m)", "zone_margin", shown.mount_zones.margin, 0.05],
                    ["Altura máxima da voadora (m)", "max_altitude", shown.flyer.max_altitude, 0.5],
                  ] as const
                ).map(([label, key, value, step]) => (
                  <label key={key}>
                    {label}
                    <input type="number" step={step} min={0} value={Number(value.toFixed(3))}
                      onChange={(e) => patchAdjust({ [key]: Math.max(0, Number(e.target.value)) })} />
                  </label>
                ))}
                {(
                  [
                    ["Descanso da mula", "rest_point", shown.mule.rest_point],
                    ["Pouso da voadora", "land_point", shown.flyer.land_point],
                  ] as const
                ).map(([label, key, p]) => (
                  <div key={key} className="point-row">
                    <span>{label}</span>
                    {(["X", "Z"] as const).map((axis, k) => (
                      <input key={axis} type="number" step={0.5} title={axis} value={Number(p[k * 2].toFixed(2))}
                        onChange={(e) => {
                          const cur: [number, number] = [p[0], p[2]];
                          cur[k] = Number(e.target.value);
                          patchAdjust({ [key]: cur });
                        }} />
                    ))}
                    <button className={picking === key ? "on toggle" : "toggle"} onClick={() => (picking === key ? cancelPick() : pickPoint(key))}
                      title="Clique no chão para marcar o ponto">Marcar</button>
                  </div>
                ))}
              </div>
            )}
            <div className="actions">
              <button className="primary" onClick={saveAdjust} disabled={!adjustDirty || !path}>Salvar ajustes</button>
              <button onClick={() => { setAdjust({}); setAdjustDirty(true); }} title="Tira os ajustes: depois de salvar e sincronizar, o jogo volta aos valores do código">Voltar ao padrão</button>
            </div>
            <div className="muted small">Salve e depois sincronize com o Godot: o jogo lê os ajustes de o arquivo .adjust.json do mapa. {adjustDirty ? "Há ajustes não salvos." : ""}</div>
          </div>
        )}
        {brushOn ? (
          <BrushPanel brush={brush} setBrush={setBrush} layers={map.scatter}
            clearLayer={(id) => change((m) => ({ ...m, scatter: m.scatter.filter((l) => l.id !== id) }))} />
        ) : sel ? (
          <>
            <h3 title={sel.model}>{modelName(sel.model)}</h3>
            {selInfo && (
              <div className={selInfo.solid ? "solid-info yes" : "solid-info"}>
                {selInfo.solid ? "Sólido no jogo" : "Sem colisão no jogo"} · topo a {selInfo.top.toFixed(2).replace(".", ",")} m do chão
                {selInfo.solid ? ` (a personagem sobe degraus de até ${String(STEP_H).replace(".", ",")} m; ligue Colisão para ver o formato)` : ""}
              </div>
            )}
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
              <button onClick={() => hide(sel.id)} title="H: esconde só no editor, para ver o que está atrás ou dentro">Esconder</button>
            </div>
            <label className="check">
              <input type="checkbox" checked={Boolean(sel.locked)} onChange={(e) => update(sel.id, { locked: e.target.checked })} />
              Travado (não seleciona clicando na vista; bom para a base do mapa)
            </label>
          </>
        ) : (
          <div className="muted">Nenhum objeto selecionado.</div>
        )}
        {hiddenList.length > 0 && (
          <div className="locked-list">
            <h4>Escondidos no editor</h4>
            {hiddenList.map((i) => (
              <button key={i.id} className="link" onClick={() => setHiddenIds([i.id], false)} title="Mostrar de novo">
                {modelName(i.model)} (mostrar)
              </button>
            ))}
            <button className="link" onClick={() => setHidden(new Set())}>Mostrar todos (Alt+H)</button>
          </div>
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
