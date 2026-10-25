// Janela "Configurar": pastas da origem, projeto Godot de destino e executável do Godot.
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { joinPath, type WsConfig } from "./workspace";

type Props = {
  root: string;
  config: WsConfig;
  godotExe: string;
  onSave: (c: WsConfig, godotExe: string) => void;
  onClose: () => void;
};

/** Caminho relativo de `to` a partir de `from` (os dois absolutos), para guardar na configuração */
function relativeTo(from: string, to: string): string {
  const a = from.split(/[\\/]+/), b = to.split(/[\\/]+/);
  if (a[0].toLowerCase() !== b[0].toLowerCase()) return to;
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/") || ".";
}

export default function ConfigDialog({ root, config, godotExe, onSave, onClose }: Props) {
  const [c, setC] = useState(config);
  const [exe, setExe] = useState(godotExe);
  const field = (key: keyof WsConfig, label: string, hint: string) => (
    <label>
      {label}
      <input value={c[key]} onChange={(e) => setC({ ...c, [key]: e.target.value })} />
      <span className="muted small">{hint}</span>
    </label>
  );

  async function pickGodot() {
    const dir = await open({ directory: true, title: "Pasta do projeto Godot (com project.godot)", defaultPath: joinPath(root, c.godotProject) });
    if (typeof dir === "string") setC({ ...c, godotProject: relativeTo(root, dir) });
  }

  return (
    <div className="modal-back">
      <div className="modal config">
        <h3>Configurar</h3>
        <div className="muted small">Pasta de origem: {root} (salvo em alvorland-studio.json, dentro dela)</div>
        <h4>Origem</h4>
        {field("assetsDir", "Pasta dos modelos", "relativa à origem; os .glb e as texturas deles")}
        {field("mapsDir", "Pasta dos mapas", "relativa à origem; os .map.json")}
        <h4>Godot</h4>
        <label>
          Projeto Godot
          <div className="row">
            <input value={c.godotProject} onChange={(e) => setC({ ...c, godotProject: e.target.value })} />
            <button onClick={pickGodot}>Escolher…</button>
          </div>
          <span className="muted small">relativo à origem (ex.: ../godot-alvorland)</span>
        </label>
        {field("godotAssetsDir", "Pasta dos modelos no Godot", "dentro do projeto (ex.: assets); fica IGUAL à pasta de modelos da origem: o que não existe na origem é apagado")}
        {field("godotMapsDir", "Pasta dos mapas no Godot", "dentro do projeto; recebe uma cena .tscn por mapa")}
        <label>
          Executável do Godot (para importar depois de sincronizar)
          <input value={exe} onChange={(e) => setExe(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={() => onSave(c, exe)}>Salvar</button>
        </div>
      </div>
    </div>
  );
}
