// Carrega e guarda os dados de bloqueios de um mapa aberto no editor (M4): o catálogo de colisão (na pasta de modelos),
// as áreas e as regiões (ao lado do .map.json) e os schemas (na pasta schemas/ da origem). Tudo é lido e gravado nos
// mesmos arquivos que o jogo usa; nada é guardado só no Studio.
import { useCallback, useEffect, useMemo, useState } from "react";
import { pathExists, readText, writeText } from "../api";
import { joinPath, type Workspace } from "../workspace";
import { emptyCatalog, parseCatalog, resolveProfile, serializeCatalog, lintCatalog, validateWithSchema, type Catalog, type Issue } from "./catalog";
import { areasPathOf, emptyAreas, parseAreas, regionsPathOf, serializeAreas, lintAreas, shapeIssues, type Area, type AreasFile, type RegionRect, type WorldBox } from "./areas";
import type { Profile } from "./catalog";

export const catalogPath = (ws: Workspace) => joinPath(ws.assets, "collision_catalog.json");
const schemaPath = (ws: Workspace, name: string) => joinPath(ws.root, `schemas\\${name}`);

async function readJson(p: string): Promise<unknown | null> {
  try {
    return (await pathExists(p)) ? JSON.parse(await readText(p)) : null;
  } catch {
    return null;
  }
}

export function useBlocksData(ws: Workspace, mapFile: string | null, modelRels: string[]) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogDirty, setCatalogDirty] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [areas, setAreasState] = useState<AreasFile>(emptyAreas());
  const [areasDirty, setAreasDirty] = useState(false);
  const [regions, setRegions] = useState<RegionRect[]>([]);
  const [schemas, setSchemas] = useState<{ catalog: unknown | null; areas: unknown | null }>({ catalog: null, areas: null });

  // catálogo e schemas (valem para todos os mapas da origem)
  useEffect(() => {
    (async () => {
      setCatalogError(null);
      const p = catalogPath(ws);
      try {
        if (await pathExists(p)) setCatalog(parseCatalog(await readText(p)));
        else setCatalog(emptyCatalog());
      } catch (e) {
        setCatalog(null);
        setCatalogError(`${p}: ${String(e)}`);
      }
      setCatalogDirty(false);
      setSchemas({ catalog: await readJson(schemaPath(ws, "collision_catalog.schema.json")), areas: await readJson(schemaPath(ws, "areas.schema.json")) });
    })();
  }, [ws.assets, ws.root]);

  // áreas e regiões do mapa aberto
  useEffect(() => {
    setAreasState(emptyAreas());
    setAreasDirty(false);
    setRegions([]);
    if (!mapFile) return;
    (async () => {
      try {
        const ap = areasPathOf(mapFile);
        if (await pathExists(ap)) setAreasState(parseAreas(await readText(ap)));
      } catch {
        /* arquivo inválido: o erro aparece na validação ao tentar salvar */
      }
      const r = (await readJson(regionsPathOf(mapFile))) as { regions?: { id: string; bounds?: { min?: [number, number]; max?: [number, number] } }[] } | null;
      setRegions(
        (r?.regions ?? []).filter((x) => x.bounds?.min && x.bounds?.max).map((x) => ({ id: x.id, min: x.bounds!.min!, max: x.bounds!.max! })),
      );
    })();
  }, [mapFile]);

  const changeCatalog = useCallback((fn: (c: Catalog) => Catalog) => {
    setCatalog((c) => (c ? fn(c) : c));
    setCatalogDirty(true);
  }, []);
  const changeAreas = useCallback((fn: (a: Area[]) => Area[]) => {
    setAreasState((f) => ({ ...f, areas: fn(f.areas) }));
    setAreasDirty(true);
  }, []);

  /** Perfil que o jogo vai aplicar a um modelo (com override da instância), para o aramado e a informação do objeto */
  const resolver = useMemo(() => (catalog ? (model: string, override?: string): Profile | null => resolveProfile(catalog, model, override).profile : null), [catalog]);

  const catalogIssues = useMemo<Issue[]>(() => {
    if (!catalog) return [];
    const out = schemas.catalog ? validateWithSchema(schemas.catalog, catalog) : [{ level: "aviso" as const, where: "schemas", message: `não achei ${schemaPath(ws, "collision_catalog.schema.json")}: validação do schema desligada` }];
    return [...out, ...lintCatalog(catalog, modelRels)];
  }, [catalog, schemas.catalog, modelRels.join("|")]);

  async function saveCatalog(): Promise<string> {
    if (!catalog) return "sem catálogo para salvar";
    const errs = catalogIssues.filter((i) => i.level === "erro");
    if (errs.length) return `Catálogo com ${errs.length} erro(s): corrija na aba Validação antes de salvar.`;
    await writeText(catalogPath(ws), serializeCatalog(catalog));
    setCatalogDirty(false);
    return "Catálogo salvo. Sincronize com o Godot para o jogo usar.";
  }

  async function saveAreas(derived: Area[], boxes: { id: string; model: string; box: WorldBox }[]): Promise<string> {
    if (!mapFile) return "salve o mapa antes de salvar as áreas";
    const errs = areaIssues(areas.areas, derived, boxes).filter((i) => i.level === "erro");
    if (errs.length) return `Áreas com ${errs.length} erro(s): corrija na aba Validação antes de salvar.`;
    await writeText(areasPathOf(mapFile), serializeAreas(areas));
    setAreasDirty(false);
    return "Áreas salvas. Sincronize com o Godot para o jogo usar.";
  }

  function areaIssues(list: Area[], derived: Area[], boxes: { id: string; model: string; box: WorldBox }[]): Issue[] {
    const out: Issue[] = [];
    if (schemas.areas) out.push(...validateWithSchema(schemas.areas, { version: 1, areas: list }, (p) => /\.shape(\.|$)/.test(p) || p.includes("oneOf")));
    out.push(...lintAreas(list, derived, regions, boxes));
    return dedupe(out);
  }

  return { catalog, catalogDirty, catalogError, areas, areasDirty, regions, resolver, catalogIssues, changeCatalog, changeAreas, saveCatalog, saveAreas, areaIssues, shapeIssues };
}

function dedupe(list: Issue[]): Issue[] {
  const seen = new Set<string>();
  return list.filter((i) => {
    const k = `${i.level}|${i.where}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
