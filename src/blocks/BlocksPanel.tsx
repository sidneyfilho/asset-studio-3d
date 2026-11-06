// Painel de colisão, áreas e validação do editor de mapa (M4). Edita o catálogo de colisão e as áreas do mapa nos
// mesmos arquivos JSON que o jogo lê, valida com o schema e mostra os problemas com o caminho do campo.
import { useEffect, useMemo, useState } from "react";
import type { MapInstance } from "../map/mapFile";
import type { MapScene } from "../map/mapScene";
import { globMatch, resolveProfile, SHAPES, BLOCK_LAYERS, type Issue, type Profile, type Vec3 } from "./catalog";
import type { Region } from "./regions";
import { deriveAreas, KNOWN_TAGS, tagColor, type Area, type AreaShape, type WorldBox } from "./areas";
import type { useBlocksData } from "./useBlocksData";

export type BlocksTab = "colisao" | "areas" | "regioes" | "validacao";
type Data = ReturnType<typeof useBlocksData>;

type Props = {
  data: Data;
  instances: MapInstance[];
  selected: MapInstance | null;
  scene: MapScene | null;
  hasMapFile: boolean;
  tab: BlocksTab;
  setTab: (t: BlocksTab) => void;
  setInstanceCollision: (id: string, profile: string | undefined) => void;
  setInstanceNoAreas: (id: string, value: boolean) => void;
  setMessage: (m: string) => void;
};

const num = (v: string, fallback: number) => (v.trim() === "" || Number.isNaN(Number(v)) ? fallback : Number(v));
const FROM_LABEL = { instância: "override desta instância", modelo: "perfil do modelo", categoria: "categoria", padrão: "perfil padrão", ausente: "nenhum" };

function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) return <div className="muted small">Nenhum problema encontrado.</div>;
  return (
    <ul className="issues">
      {issues.map((i, k) => (
        <li key={k} className={i.level === "erro" ? "issue erro" : "issue aviso"}>
          <b>{i.level === "erro" ? "Erro" : "Aviso"}</b> <code>{i.where}</code>: {i.message}
        </li>
      ))}
    </ul>
  );
}

export default function BlocksPanel({ data, instances, selected, scene, hasMapFile, tab, setTab, setInstanceCollision, setInstanceNoAreas, setMessage }: Props) {
  const { catalog } = data;
  const [profileId, setProfileId] = useState<string>("");
  const [newProfile, setNewProfile] = useState("");
  const [areaId, setAreaId] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<Map<string, WorldBox>>(new Map());
  const [picking, setPicking] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [propsText, setPropsText] = useState("");
  const [propsError, setPropsError] = useState<string | null>(null);
  const [regionId, setRegionId] = useState<string | null>(null);
  const [showServer, setShowServer] = useState(false);
  const [regionProps, setRegionProps] = useState("");
  const [regionPropsError, setRegionPropsError] = useState<string | null>(null);

  useEffect(() => {
    if (catalog && (!profileId || !catalog.profiles[profileId])) setProfileId(Object.keys(catalog.profiles)[0] ?? "");
  }, [catalog, profileId]);

  // caixas dos objetos no mundo: base das áreas derivadas (os modelos carregam aos poucos, por isso o atraso)
  const refreshBoxes = () => scene && setBoxes(scene.worldBoxes());
  useEffect(() => {
    const timers = [700, 2000, 5000, 10000].map((ms) => setTimeout(refreshBoxes, ms));
    return () => timers.forEach(clearTimeout);
  }, [instances, scene]);

  const derived = useMemo(() => (catalog ? deriveAreas(catalog, instances, boxes, data.serverShapes) : []), [catalog, instances, boxes, data.serverShapes]);
  const authored = data.areas.areas;
  const area = authored.find((a) => a.id === areaId) ?? null;

  // desenho no mapa: só na aba Áreas
  useEffect(() => {
    if (tab !== "areas") {
      scene?.setAreas([]);
      return;
    }
    scene?.setAreas([
      ...derived.map((a) => ({ area: a, derived: true, selected: false })),
      ...authored.map((a) => ({ area: a, derived: false, selected: a.id === areaId })),
    ]);
    return () => scene?.setAreas([]);
  }, [tab, derived, authored, areaId, scene]);

  // contorno das regiões: só na aba Regiões
  useEffect(() => {
    if (tab !== "regioes") {
      scene?.setRegions([]);
      return;
    }
    scene?.setRegions(data.regionsFile.regions.filter((r) => r.bounds?.min && r.bounds?.max).map((r) => ({ id: r.id, min: r.bounds.min, max: r.bounds.max, selected: r.id === regionId })));
    return () => scene?.setRegions([]);
  }, [tab, data.regionsFile, regionId, scene]);

  // caixas que o servidor usa para o objeto selecionado (do server_shapes.json gerado ao sincronizar)
  useEffect(() => {
    const entry = selected ? data.serverShapes?.models[selected.model] : undefined;
    if (tab !== "colisao" || !showServer || !selected || !entry?.boxes) {
      scene?.setServerBoxes(null, [0, 0, 0], 0, 1);
      return;
    }
    scene?.setServerBoxes(entry.boxes, selected.pos, selected.rotY, selected.scale);
    return () => scene?.setServerBoxes(null, [0, 0, 0], 0, 1);
  }, [tab, showServer, selected, data.serverShapes, scene]);

  useEffect(() => {
    setRegionProps(data.regionsFile.regions.find((r) => r.id === regionId)?.properties ? JSON.stringify(data.regionsFile.regions.find((r) => r.id === regionId)!.properties) : "");
    setRegionPropsError(null);
  }, [regionId]);

  useEffect(() => {
    setPropsText(area?.properties ? JSON.stringify(area.properties) : "");
    setPropsError(null);
  }, [areaId]);

  const instanceBoxes = useMemo(() => instances.filter((i) => boxes.has(i.id)).map((i) => ({ id: i.id, model: i.model, box: boxes.get(i.id)! })), [instances, boxes]);
  const areaIssues = useMemo(() => data.areaIssues(authored, derived, instanceBoxes), [authored, derived, instanceBoxes, data.areaIssues]);
  const allIssues = useMemo(() => [...data.catalogIssues, ...areaIssues, ...data.regionIssues], [data.catalogIssues, areaIssues, data.regionIssues]);
  const errors = allIssues.filter((i) => i.level === "erro").length;

  const modelRels = useMemo(() => [...new Set(instances.map((i) => i.model))].sort(), [instances]);

  async function run(p: Promise<string>) {
    try {
      setMessage(await p);
    } catch (e) {
      setMessage(String(e));
    }
  }

  // ---------- aba Colisão

  const patchProfile = (id: string, patch: Partial<Profile>) =>
    data.changeCatalog((c) => ({ ...c, profiles: { ...c.profiles, [id]: { ...c.profiles[id], ...patch } } }));
  const vec3Input = (label: string, key: "size" | "offset", p: Profile, id: string) => {
    const v: Vec3 = p[key] ?? [0, 0, 0];
    return (
      <div className="point-row wide">
        <span>{label}</span>
        {[0, 1, 2].map((k) => (
          <input key={k} type="number" step={0.05} value={v[k]} onChange={(e) => { const n = [...v] as Vec3; n[k] = num(e.target.value, 0); patchProfile(id, { [key]: n }); }} />
        ))}
      </div>
    );
  };

  function colisao() {
    if (data.catalogError) return <div className="error">{data.catalogError}</div>;
    if (!catalog) return <div className="muted small">Carregando o catálogo…</div>;
    const p = catalog.profiles[profileId];
    const used = (id: string) => Object.values(catalog.models ?? {}).includes(id) || (catalog.categories ?? []).some((c) => c.profile === id) || catalog.default_profile === id;
    const res = selected ? resolveProfile(catalog, selected.model, selected.collision) : null;
    return (
      <>
        {selected && res ? (
          <div className="blocks-sec">
            <h4>Objeto selecionado</h4>
            <div className="muted small" title={selected.model}>{selected.model}</div>
            <div className="small">Vale o perfil <b>{res.id}</b> ({res.profile.shape ?? "none"}), vindo de: {FROM_LABEL[res.from]}.</div>
            <label>
              Perfil do modelo (vale para todas as cópias)
              <select value={catalog.models?.[selected.model] ?? ""} onChange={(e) => data.changeCatalog((c) => {
                const models = { ...(c.models ?? {}) };
                if (e.target.value) models[selected.model] = e.target.value; else delete models[selected.model];
                return { ...c, models };
              })}>
                <option value="">(usar a categoria ou o padrão)</option>
                {Object.keys(catalog.profiles).map((id) => <option key={id}>{id}</option>)}
              </select>
            </label>
            <label>
              Override só desta instância
              <select value={selected.collision ?? ""} onChange={(e) => setInstanceCollision(selected.id, e.target.value || undefined)}>
                <option value="">(nenhum)</option>
                {Object.keys(catalog.profiles).map((id) => <option key={id}>{id}</option>)}
              </select>
            </label>
            <div className="blocks-sec">
              <h4>Áreas geradas por este modelo</h4>
              {Object.entries(catalog.area_tags ?? {}).filter(([glob]) => globMatch(glob, selected.model)).map(([glob, tags]) => (
                <div key={glob} className="blocks-sec">
                  <div className="muted small" title={glob}>{glob === selected.model ? "Só este modelo" : `Vale para todos que casam com ${glob}`}</div>
                  <div className="tag-grid">
                    {KNOWN_TAGS.map((k) => (
                      <label key={k.tag} className="check">
                        <input type="checkbox" checked={tags.includes(k.tag)} onChange={(e) => data.changeCatalog((c) => ({ ...c, area_tags: { ...(c.area_tags ?? {}), [glob]: e.target.checked ? [...tags, k.tag] : tags.filter((t) => t !== k.tag) } }))} />
                        <span className="swatch-dot" style={{ background: k.color }} /> {k.label}
                      </label>
                    ))}
                  </div>
                  <button onClick={() => data.changeCatalog((c) => { const a = { ...(c.area_tags ?? {}) }; delete a[glob]; return { ...c, area_tags: a }; })}
                    title="Tira a regra: nenhuma instância desses modelos gera zona">Remover esta regra (sem zona para {glob === selected.model ? "este modelo" : "esses modelos"})</button>
                </div>
              ))}
              {!Object.keys(catalog.area_tags ?? {}).some((glob) => globMatch(glob, selected.model)) && (
                <div className="actions">
                  <span className="muted small">Este modelo não gera zona.</span>
                  <button onClick={() => data.changeCatalog((c) => ({ ...c, area_tags: { ...(c.area_tags ?? {}), [selected.model]: ["no_mount"] } }))}>Gerar zona (montaria não entra)</button>
                </div>
              )}
              <label className="check" title="Só esta cópia do objeto fica sem a zona; as outras continuam com ela">
                <input type="checkbox" checked={Boolean(selected.noAreas)} onChange={(e) => setInstanceNoAreas(selected.id, e.target.checked)} />
                Sem zona só nesta instância (salve o mapa)
              </label>
              <div className="muted small">As regras ficam no catálogo (Salvar catálogo) e valem para todas as cópias do modelo. Depois, sincronize com o Godot.</div>
            </div>
            <label className="check">
              <input type="checkbox" checked={showServer} onChange={(e) => setShowServer(e.target.checked)} />
              Ver as caixas que o servidor usa para este objeto
            </label>
            {showServer && (
              <div className="muted small">
                {data.serverShapes?.models[selected.model]?.boxes
                  ? `${data.serverShapes.models[selected.model].boxes!.length} caixa(s), tolerância do servidor ${data.serverShapes.tolerance} m.`
                  : data.serverShapes?.models[selected.model]
                    ? "Este perfil não tem caixas de servidor (as formas primitivas o servidor calcula com o perfil e a caixa do modelo)."
                    : res && (res.profile.shape === "none" || res.profile.shape === "terrain" || !res.profile.shape)
                      ? "Este objeto não tem colisão (perfil sem forma): o servidor também não o bloqueia."
                      : "Sem dados para este modelo: sincronize com o Godot para gerar o server_shapes.json."}
              </div>
            )}
            <div className="muted small">Precedência: instância, depois modelo, categoria (o primeiro glob que casa) e padrão. O override vai para o mapa (salve o mapa).</div>
          </div>
        ) : (
          <div className="muted small">Selecione um objeto para ver e mudar o perfil dele. Ligue o botão Colisão no topo para ver as formas.</div>
        )}
        <div className="blocks-sec">
          <h4>Perfis do catálogo</h4>
          <div className="actions">
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {Object.keys(catalog.profiles).map((id) => <option key={id}>{id}</option>)}
            </select>
            <button disabled={!p || used(profileId) || profileId === "none"} title={used(profileId) ? "Em uso: tire do modelo, da categoria ou do padrão antes" : "Apaga o perfil"}
              onClick={() => data.changeCatalog((c) => { const profiles = { ...c.profiles }; delete profiles[profileId]; return { ...c, profiles }; })}>Apagar</button>
          </div>
          <div className="actions">
            <input placeholder="id do novo perfil" value={newProfile} onChange={(e) => setNewProfile(e.target.value.replace(/[^A-Za-z0-9_]/g, "_"))} />
            <button disabled={!newProfile || Boolean(catalog.profiles[newProfile])}
              onClick={() => { data.changeCatalog((c) => ({ ...c, profiles: { ...c.profiles, [newProfile]: { shape: "box", fit: "auto", blocks: ["world"] } } })); setProfileId(newProfile); setNewProfile(""); }}>Criar</button>
          </div>
          {p && (
            <div className="fields">
              <label>Forma
                <select value={p.shape ?? "none"} onChange={(e) => patchProfile(profileId, { shape: e.target.value as Profile["shape"] })}>
                  {SHAPES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </label>
              {(p.shape === "trimesh" || p.shape === "convex") && (
                <label>Servidor (autoritativo)
                  <select value={p.server ?? ""} onChange={(e) => patchProfile(profileId, { server: (e.target.value || undefined) as Profile["server"] })}>
                    <option value="">(nenhum: o servidor não reproduz)</option>
                    <option value="boxes">caixas geradas do modelo</option>
                  </select>
                </label>
              )}
              <label>Tamanho
                <select value={p.fit ?? "auto"} onChange={(e) => patchProfile(profileId, { fit: e.target.value as Profile["fit"] })}>
                  <option value="auto">auto (mede o modelo)</option>
                  <option value="explicit">explicit (metros do mundo)</option>
                </select>
              </label>
              {(p.fit ?? "auto") === "auto" ? (
                <>
                  <label>Escala<input type="number" step={0.05} min={0.05} value={p.scale ?? 1} onChange={(e) => patchProfile(profileId, { scale: Math.max(0.05, num(e.target.value, 1)) })} /></label>
                  <label>Folga (box, m)<input type="number" step={0.05} value={p.margin ?? 0} onChange={(e) => patchProfile(profileId, { margin: num(e.target.value, 0) })} /></label>
                  <label>Escala do raio<input type="number" step={0.05} min={0.05} value={p.radius_scale ?? 1} onChange={(e) => patchProfile(profileId, { radius_scale: Math.max(0.05, num(e.target.value, 1)) })} /></label>
                </>
              ) : (
                <>
                  <label>Raio (m)<input type="number" step={0.05} min={0.01} value={p.radius ?? 0} onChange={(e) => patchProfile(profileId, { radius: num(e.target.value, 0) })} /></label>
                  <label>Altura (m)<input type="number" step={0.05} min={0.01} value={p.height ?? 0} onChange={(e) => patchProfile(profileId, { height: num(e.target.value, 0) })} /></label>
                </>
              )}
              {(p.fit ?? "auto") === "explicit" && p.shape === "box" && vec3Input("Tamanho x y z", "size", p, profileId)}
              {vec3Input("Deslocamento x y z", "offset", p, profileId)}
              <label className="check wide">Bloqueia
                {BLOCK_LAYERS.map((b) => (
                  <span key={b}><input type="checkbox" checked={(p.blocks ?? ["world"]).includes(b)} onChange={(e) => patchProfile(profileId, { blocks: e.target.checked ? [...new Set([...(p.blocks ?? []), b])] : (p.blocks ?? []).filter((x) => x !== b) })} /> {b}</span>
                ))}
              </label>
            </div>
          )}
        </div>
        <div className="actions">
          <button className="primary" disabled={!data.catalogDirty} onClick={() => run(data.saveCatalog())}>Salvar catálogo</button>
          <span className="muted small">{data.catalogDirty ? "Há mudanças não salvas." : "collision_catalog.json"}</span>
        </div>
        <div className="muted small">Passo (degrau) não faz parte do perfil: a subida de degraus é da movimentação do jogo.</div>
      </>
    );
  }

  // ---------- aba Áreas

  const patchArea = (id: string, patch: Partial<Area>) => data.changeAreas((l) => l.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const setShape = (id: string, shape: AreaShape) => patchArea(id, { shape });
  const newId = () => {
    let n = 1;
    while (authored.some((a) => a.id === `area_${n}`) || derived.some((a) => a.id === `area_${n}`)) n++;
    return `area_${n}`;
  };
  function pickNew() {
    if (!scene) return;
    setPicking(true);
    scene.setPickPoint((x, z) => {
      const id = newId();
      data.changeAreas((l) => [...l, { id, shape: { type: "box", center: [x, 1, z], size: [4, 2, 4], yaw: 0 }, tags: [], priority: 0 }]);
      setAreaId(id);
      setPicking(false);
    });
  }
  const vec = (label: string, v: Vec3, onChange: (v: Vec3) => void) => (
    <div className="point-row wide">
      <span>{label}</span>
      {[0, 1, 2].map((k) => (
        <input key={k} type="number" step={0.5} value={Number(v[k].toFixed(3))} onChange={(e) => { const n = [...v] as Vec3; n[k] = num(e.target.value, v[k]); onChange(n); }} />
      ))}
    </div>
  );

  function areasTab() {
    const mine = areaIssues.filter((i) => area && i.where.includes(`areas[${area.id}]`));
    return (
      <>
        <div className="actions">
          <button className={picking ? "on toggle" : "toggle"} disabled={!scene} onClick={() => (picking ? (scene?.setPickPoint(null), setPicking(false)) : pickNew())}>
            {picking ? "Clique no chão…" : "Nova área (clique no chão)"}
          </button>
          <button className="primary" disabled={!data.areasDirty || !hasMapFile} title={hasMapFile ? "" : "Salve o mapa primeiro"} onClick={() => run(data.saveAreas(derived, instanceBoxes))}>Salvar áreas</button>
        </div>
        <div className="muted small">{data.areasDirty ? "Há mudanças não salvas. " : ""}As áreas ficam em &lt;mapa&gt;.areas.json. As desenhadas fora de escala vêm do modelo (derivadas).</div>
        <div className="blocks-sec">
          <h4>Áreas do mapa ({authored.length})</h4>
          {authored.map((a) => (
            <button key={a.id} className={a.id === areaId ? "link sel" : "link"} onClick={() => setAreaId(a.id)}>
              <span className="swatch-dot" style={{ background: tagColor(a.tags) }} /> {a.id} <span className="muted">{a.tags.join(", ") || "sem tags"}</span>
            </button>
          ))}
          {!authored.length && <div className="muted small">Nenhuma ainda.</div>}
          <h4>Derivadas dos modelos ({derived.length}, só leitura)</h4>
          {derived.map((a) => (
            <div key={a.id} className="muted small"><span className="swatch-dot" style={{ background: tagColor(a.tags) }} /> {a.id}: {a.tags.join(", ")}</div>
          ))}
        </div>
        {area && (
          <div className="blocks-sec">
            <h4>Área {area.id}</h4>
            <div className="fields">
              <label>Id<input value={area.id} onChange={(e) => { const nid = e.target.value.replace(/\s/g, "_"); patchArea(area.id, { id: nid }); setAreaId(nid); }} /></label>
              <label>Prioridade<input type="number" step={1} value={area.priority ?? 0} onChange={(e) => patchArea(area.id, { priority: Math.round(num(e.target.value, 0)) })} /></label>
              <label>Região
                <select value={area.region ?? ""} onChange={(e) => patchArea(area.id, { region: e.target.value || undefined })}>
                  <option value="">(qualquer)</option>
                  {data.regions.map((r) => <option key={r.id}>{r.id}</option>)}
                </select>
              </label>
              <label>Forma
                <select value={area.shape.type} onChange={(e) => {
                  const c = area.shape.center;
                  const t = e.target.value;
                  setShape(area.id, t === "box" ? { type: "box", center: c, size: [4, 2, 4], yaw: 0 } : t === "sphere" ? { type: "sphere", center: c, radius: 3 } : { type: "cylinder", center: c, radius: 3, height: 3 });
                }}>
                  <option value="box">box (caixa)</option>
                  <option value="sphere">sphere (esfera)</option>
                  <option value="cylinder">cylinder (cilindro)</option>
                </select>
              </label>
              {vec("Centro x y z", area.shape.center, (v) => setShape(area.id, { ...area.shape, center: v } as AreaShape))}
              {area.shape.type === "box" && (
                <>
                  {vec("Tamanho x y z", area.shape.size, (v) => setShape(area.id, { ...(area.shape as Extract<AreaShape, { type: "box" }>), size: v }))}
                  <label>Giro (°)<input type="number" step={15} value={area.shape.yaw ?? 0} onChange={(e) => setShape(area.id, { ...(area.shape as Extract<AreaShape, { type: "box" }>), yaw: num(e.target.value, 0) })} /></label>
                </>
              )}
              {area.shape.type !== "box" && (
                <label>Raio (m)<input type="number" step={0.5} value={area.shape.radius} onChange={(e) => setShape(area.id, { ...area.shape, radius: num(e.target.value, 1) } as AreaShape)} /></label>
              )}
              {area.shape.type === "cylinder" && (
                <label>Altura (m)<input type="number" step={0.5} value={area.shape.height} onChange={(e) => setShape(area.id, { ...area.shape, height: num(e.target.value, 1) } as AreaShape)} /></label>
              )}
            </div>
            <h4>Tags</h4>
            <div className="tag-grid">
              {KNOWN_TAGS.map((k) => (
                <label key={k.tag} className="check" title={k.tag}>
                  <input type="checkbox" checked={area.tags.includes(k.tag)} onChange={(e) => patchArea(area.id, { tags: e.target.checked ? [...area.tags, k.tag] : area.tags.filter((t) => t !== k.tag) })} />
                  <span className="swatch-dot" style={{ background: k.color }} /> {k.label}
                </label>
              ))}
              {area.tags.filter((t) => !KNOWN_TAGS.some((k) => k.tag === t)).map((t) => (
                <button key={t} className="link" onClick={() => patchArea(area.id, { tags: area.tags.filter((x) => x !== t) })} title="Tirar a tag">{t} ✕</button>
              ))}
            </div>
            <div className="actions">
              <input placeholder="outra tag" value={tagDraft} onChange={(e) => setTagDraft(e.target.value.replace(/[^a-z0-9_]/g, ""))} />
              <button disabled={!tagDraft || area.tags.includes(tagDraft)} onClick={() => { patchArea(area.id, { tags: [...area.tags, tagDraft] }); setTagDraft(""); }}>Adicionar tag</button>
            </div>
            <label>Propriedades (JSON, opcional)
              <textarea rows={2} value={propsText} placeholder='{"crop_slots": 12}' onChange={(e) => {
                setPropsText(e.target.value);
                if (!e.target.value.trim()) { setPropsError(null); patchArea(area.id, { properties: undefined }); return; }
                try {
                  const v = JSON.parse(e.target.value);
                  if (v && typeof v === "object" && !Array.isArray(v)) { setPropsError(null); patchArea(area.id, { properties: v }); } else setPropsError("esperado um objeto {…}");
                } catch (er) { setPropsError(`JSON inválido: ${String((er as Error).message)}`); }
              }} />
            </label>
            {propsError && <div className="error">{propsError}</div>}
            {mine.length > 0 && <IssueList issues={mine} />}
            <div className="actions">
              <button onClick={() => { data.changeAreas((l) => l.filter((a) => a.id !== area.id)); setAreaId(null); }}>Apagar área</button>
            </div>
          </div>
        )}
      </>
    );
  }

  const patchRegion = (id: string, patch: Partial<Region>) => data.changeRegions((l) => l.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  function regioesTab() {
    const region = data.regionsFile.regions.find((r) => r.id === regionId) ?? null;
    const nextId = () => {
      let n = 1;
      while (data.regionsFile.regions.some((r) => r.id === `regiao_${n}`)) n++;
      return `regiao_${n}`;
    };
    const mine = data.regionIssues.filter((i) => region && i.where.includes(`regions[${region.id}`));
    return (
      <>
        <div className="actions">
          <button onClick={() => {
            const id = nextId();
            data.changeRegions((l) => [...l, { id, bounds: { type: "rect", min: [-36, -36], max: [36, 36] } }]);
            setRegionId(id);
          }}>Nova região</button>
          <button className="primary" disabled={!data.regionsDirty || !hasMapFile} title={hasMapFile ? "" : "Salve o mapa primeiro"} onClick={() => run(data.saveRegions())}>Salvar regiões</button>
        </div>
        <div className="muted small">{data.regionsDirty ? "Há mudanças não salvas. " : ""}A área jogável é a união das regiões; o jogo cria as paredes nas bordas. Sem regiões vale 36 m.</div>
        <div className="blocks-sec">
          <h4>Regiões ({data.regionsFile.regions.length})</h4>
          {data.regionsFile.regions.map((r) => (
            <button key={r.id} className={r.id === regionId ? "link sel" : "link"} onClick={() => setRegionId(r.id)}>{r.id}</button>
          ))}
        </div>
        {region && (
          <div className="blocks-sec">
            <h4>Região {region.id}</h4>
            <div className="fields">
              <label>Id<input value={region.id} onChange={(e) => { const nid = e.target.value.replace(/\s/g, "_"); patchRegion(region.id, { id: nid }); setRegionId(nid); }} /></label>
              {([["min", 0, "Canto mínimo x (m)"], ["min", 1, "Canto mínimo z (m)"], ["max", 0, "Canto máximo x (m)"], ["max", 1, "Canto máximo z (m)"]] as const).map(([k, i, label]) => (
                <label key={label}>{label}
                  <input type="number" step={1} value={region.bounds[k][i]} onChange={(e) => {
                    const b = { ...region.bounds, [k]: [...region.bounds[k]] as [number, number] };
                    b[k][i] = num(e.target.value, region.bounds[k][i]);
                    patchRegion(region.id, { bounds: b });
                  }} />
                </label>
              ))}
              <label>Altura máxima da voadora (m)
                <input type="number" step={0.5} value={Number(region.properties?.flyer_max_altitude ?? 8)} onChange={(e) => patchRegion(region.id, { properties: { ...(region.properties ?? {}), flyer_max_altitude: num(e.target.value, 8) } })} />
              </label>
            </div>
            <label>Outras propriedades (JSON)
              <textarea rows={2} value={regionProps} placeholder='{"imposto": 3}' onChange={(e) => {
                setRegionProps(e.target.value);
                try {
                  const v = e.target.value.trim() ? JSON.parse(e.target.value) : {};
                  if (v && typeof v === "object" && !Array.isArray(v)) { setRegionPropsError(null); patchRegion(region.id, { properties: v }); } else setRegionPropsError("esperado um objeto {…}");
                } catch (er) { setRegionPropsError(`JSON inválido: ${String((er as Error).message)}`); }
              }} />
            </label>
            {regionPropsError && <div className="error">{regionPropsError}</div>}
            {mine.length > 0 && <IssueList issues={mine} />}
            <div className="actions"><button onClick={() => { data.changeRegions((l) => l.filter((r) => r.id !== region.id)); setRegionId(null); }}>Apagar região</button></div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="blocks-panel2">
      <div className="tabs">
        <button className={tab === "colisao" ? "on" : ""} onClick={() => setTab("colisao")}>Colisão</button>
        <button className={tab === "areas" ? "on" : ""} onClick={() => setTab("areas")}>Áreas</button>
        <button className={tab === "regioes" ? "on" : ""} onClick={() => setTab("regioes")}>Regiões</button>
        <button className={tab === "validacao" ? "on" : ""} onClick={() => setTab("validacao")}>Validação{allIssues.length ? ` (${errors ? errors + " erro(s)" : allIssues.length})` : ""}</button>
      </div>
      {tab === "colisao" && colisao()}
      {tab === "areas" && areasTab()}
      {tab === "regioes" && regioesTab()}
      {tab === "validacao" && (
        <>
          <div className="muted small">Confere o catálogo e as áreas com o schema (pasta schemas/ da origem) e com as regras de configuração. Erros impedem salvar.</div>
          <div className="actions"><button onClick={refreshBoxes}>Atualizar medidas dos objetos</button></div>
          <h4>Catálogo de colisão</h4>
          <IssueList issues={data.catalogIssues} />
          <h4>Áreas</h4>
          <IssueList issues={areaIssues} />
          <h4>Regiões</h4>
          <IssueList issues={data.regionIssues} />
          <div className="muted small">Objetos neste mapa: {modelRels.length} modelo(s) diferentes, {instances.length} instância(s).</div>
        </>
      )}
    </div>
  );
}
