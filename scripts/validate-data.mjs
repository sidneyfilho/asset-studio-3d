// Valida os dados de bloqueios da origem com os schemas (Ajv), sem abrir o Studio nem o Godot. Serve para rodar na
// linha de comando ou numa checagem automática (CI):  npm run validate:data -- --root=<pasta doc-alvorland>
//   1. os casos compartilhados (schemas/fixtures/fixtures.json): o Ajv precisa concordar com "schema_valid";
//   2. os arquivos reais: collision_catalog.json, server_shapes.json e, de cada mapa, .areas.json e .regions.json.
// Sai com código 0 se tudo passar e 1 se algo falhar.
import Ajv from "ajv";
import fs from "node:fs";
import path from "node:path";

const arg = process.argv.find((a) => a.startsWith("--root="));
const root = path.resolve(arg ? arg.slice(7) : path.join("..", "..", "Projeto", "Alvorland", "doc-alvorland"));
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const exists = (p) => fs.existsSync(p);

const schemaDir = path.join(root, "schemas");
const names = { catalog: "collision_catalog", areas: "areas", regions: "regions", server_shapes: "server_shapes" };
if (!exists(schemaDir)) {
  console.error(`Pasta de schemas não encontrada: ${schemaDir} (use --root=<doc-alvorland>)`);
  process.exit(1);
}
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = Object.fromEntries(Object.entries(names).map(([k, n]) => [k, ajv.compile(read(path.join(schemaDir, `${n}.schema.json`)))]));

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FALHOU  ${msg}`);
};
const ok = (msg) => console.log(`  ok  ${msg}`);
const fmt = (v) => (v.errors ?? []).map((e) => `${e.instancePath || "(raiz)"} ${e.message}`).join("; ");

// 1. casos compartilhados com o Godot
const fixtures = read(path.join(schemaDir, "fixtures", "fixtures.json"));
let cases = 0;
for (const [kind, list] of Object.entries(fixtures)) {
  if (!Array.isArray(list)) continue;
  for (const c of list) {
    cases++;
    const v = validators[kind];
    const got = v(c.data);
    if (got !== c.schema_valid) fail(`${kind}: "${c.name}": o schema ${got ? "aceitou" : "recusou"} (esperado ${c.schema_valid ? "aceitar" : "recusar"}) ${got ? "" : fmt(v)}`);
  }
}
if (!failures) ok(`${cases} casos compartilhados: o Ajv concorda com o esperado`);

// 2. arquivos reais
const check = (kind, file) => {
  const v = validators[kind];
  if (v(read(file))) ok(path.relative(root, file));
  else fail(`${path.relative(root, file)}: ${fmt(v)}`);
};
const cat = path.join(root, "assets", "collision_catalog.json");
if (exists(cat)) check("catalog", cat);
const shapes = path.join(root, "assets", "server_shapes.json");
if (exists(shapes)) check("server_shapes", shapes);
const mapDir = path.join(root, "map");
if (exists(mapDir)) {
  for (const f of fs.readdirSync(mapDir)) {
    if (f.endsWith(".areas.json")) check("areas", path.join(mapDir, f));
    if (f.endsWith(".regions.json")) check("regions", path.join(mapDir, f));
  }
}
console.log(failures ? `validate-data: ${failures} falha(s)` : "validate-data: OK");
process.exit(failures ? 1 : 0);
