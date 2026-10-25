// Cartão de um modelo com a miniatura (usado na grade de modelos e na paleta do editor de mapa)
import { useEffect, useState } from "react";
import type { ModelEntry } from "./api";
import { thumbnailFor } from "./three/thumbnails";

export const modelName = (rel: string) => rel.split("/").pop()!.replace(/\.(glb|gltf)$/i, "");

export default function Card({ model, active, onClick, small }: { model: ModelEntry; active: boolean; onClick: () => void; small?: boolean }) {
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
  return (
    <button className={`card${active ? " active" : ""}${small ? " small" : ""}`} onClick={onClick} title={model.rel}>
      <div className="thumb">{src ? <img src={src} alt="" /> : <span className="muted">{failed ? "erro" : "…"}</span>}</div>
      <div className="name">{modelName(model.rel)}</div>
    </button>
  );
}
