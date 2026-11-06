// Janela do "Sincronizar com o Godot": primeiro mostra o que vai mudar, depois aplica e manda o Godot importar.
import { useEffect, useState } from "react";
import { adjustPathOf } from "./map/blocks";
import { godotExportBlocks, godotImport, pathExists, readText, syncGodot, type ModelEntry, type SyncReport, type SyncRequest } from "./api";
import { parseMap, toTscn, SCATTER_SCRIPT, SCATTER_SCRIPT_NAME } from "./map/mapFile";
import type { Workspace } from "./workspace";

type Props = { ws: Workspace; maps: ModelEntry[]; godotExe: string; onClose: () => void };

const LIST_MAX = 40;

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="sync-list">
      <h4>{title} ({items.length})</h4>
      <ul>
        {items.slice(0, LIST_MAX).map((i) => <li key={i}>{i}</li>)}
        {items.length > LIST_MAX && <li className="muted">… e mais {items.length - LIST_MAX}</li>}
      </ul>
    </div>
  );
}

export default function SyncDialog({ ws, maps, godotExe, onClose }: Props) {
  const [req, setReq] = useState<SyncRequest | null>(null);
  const [plan, setPlan] = useState<SyncReport | null>(null);
  const [stage, setStage] = useState<"planning" | "ready" | "applying" | "importing" | "done">("planning");
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);

  // monta o pedido (com as cenas .tscn geradas a partir de cada mapa) e calcula o que vai mudar
  useEffect(() => {
    (async () => {
      try {
        // script das camadas espalhadas (grama, flores...): vai junto com as cenas dos mapas
        const scenes = [{ name: SCATTER_SCRIPT_NAME, content: SCATTER_SCRIPT }];
        for (const m of maps) {
          const data = parseMap(await readText(m.abs));
          // ajustes manuais dos bloqueios (T068, passo B): vão junto com a cena, e o jogo os lê
          if (await pathExists(adjustPathOf(m.abs))) scenes.push({ name: m.rel.replace(/\.map\.json$/i, ".adjust.json"), content: await readText(adjustPathOf(m.abs)) });
          // regiões jogáveis do mapa (M2 da arquitetura de bloqueios): o jogo lê <mapa>.regions.json
          const regionsFile = m.abs.replace(/\.map\.json$/i, ".regions.json");
          if (await pathExists(regionsFile)) scenes.push({ name: m.rel.replace(/\.map\.json$/i, ".regions.json"), content: await readText(regionsFile) });
          // áreas configuráveis (M3/M4): o jogo lê <mapa>.areas.json
          const areasFile = m.abs.replace(/\.map\.json$/i, ".areas.json");
          if (await pathExists(areasFile)) scenes.push({ name: m.rel.replace(/\.map\.json$/i, ".areas.json"), content: await readText(areasFile) });
          scenes.push({ name: m.rel.replace(/\.map\.json$/i, ".tscn"), content: toTscn(data, ws.resPrefix, ws.mapsRes + SCATTER_SCRIPT_NAME) });
        }
        const r: SyncRequest = {
          godot_project: ws.godot,
          src_assets: ws.assets,
          dst_assets: ws.godotAssets,
          dst_maps: ws.godotMaps,
          maps: scenes,
          apply: false,
        };
        setReq(r);
        setPlan(await syncGodot(r));
        setStage("ready");
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [ws, maps]);

  async function apply() {
    if (!req) return;
    setError(null);
    try {
      setStage("applying");
      const done = await syncGodot({ ...req, apply: true });
      setPlan(done);
      if (godotExe) {
        setStage("importing");
        let text = await godotImport(godotExe, ws.godot);
        // regrava os bloqueios (<mapa>.blocks.json) ao lado de cada mapa; se falhar, só avisa
        for (const m of maps) {
          const name = m.rel.replace(/.map.json$/i, "").split("/").pop()!;
          try {
            await godotExportBlocks(godotExe, ws.godot, name, ws.maps);
          } catch (e) {
            text += `
Bloqueios de ${name} não regravados: ${String(e)}`;
          }
        }
        setLog(text);
      } else {
        setLog("Importação do Godot pulada (defina o executável do Godot em Configurar).");
      }
      setStage("done");
    } catch (e) {
      setError(String(e));
      setStage("ready");
    }
  }

  const nothing = plan && !plan.copied.length && !plan.removed.length && !plan.maps_written.length && !plan.maps_removed.length;
  return (
    <div className="modal-back">
      <div className="modal">
        <h3>Sincronizar com o Godot</h3>
        <div className="muted small">
          {ws.assets} → {ws.godotAssets}
          <br />
          {ws.maps} → {ws.godotMaps}
        </div>
        {stage === "planning" && !error && <p>Comparando as pastas…</p>}
        {plan && (
          <>
            <p>
              {stage === "done" ? "Feito: " : "Vai acontecer: "}
              {plan.copied.length} arquivo(s) copiado(s), {plan.removed.length} apagado(s) no Godot, {plan.unchanged} sem mudança;
              {" "}{plan.maps_written.length} mapa(s) gerado(s), {plan.maps_removed.length} cena(s) de mapa apagada(s).
            </p>
            {nothing && stage !== "done" && <p className="muted">O Godot já está igual à origem.</p>}
            <List title="Apagar no Godot" items={plan.removed.concat(plan.maps_removed.map((m) => `mapa: ${m}`))} />
            <List title="Copiar" items={plan.copied} />
            <List title="Mapas" items={plan.maps_written} />
          </>
        )}
        {stage === "importing" && <p>O Godot está importando os arquivos…</p>}
        {log && <pre className="log">{log}</pre>}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={stage === "applying" || stage === "importing"}>{stage === "done" ? "Fechar" : "Cancelar"}</button>
          {stage === "ready" && !nothing && (
            <button className="primary" onClick={apply}>
              {plan && plan.removed.length + plan.maps_removed.length > 0 ? "Sincronizar (apagando o que saiu)" : "Sincronizar"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
