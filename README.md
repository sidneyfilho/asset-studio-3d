# Alvorland Studio (asset-studio-3d)

Ferramenta separada do Godot para gerenciar os modelos 3D e os mapas do jogo, como o Sprite Manager fazia no 2D.
Feita com Tauri 2 + React + three.js, no mesmo jeito do Object Builder.

**A origem manda.** Tudo nasce numa pasta de origem (ex.: `doc-alvorland`):

```
doc-alvorland/
  assets/                 modelos .glb (e as texturas deles), em subpastas (kit, nature, chars...)
  map/                    mapas da ferramenta (*.map.json)
  alvorland-studio.json   configuração (criada na primeira vez)
```

O botão **Sincronizar com o Godot** deixa o projeto Godot igual à origem.

## Como abrir

Dê dois cliques em `studio.bat` (modo desenvolvimento: compila e abre a janela).
Para gerar o `.exe`: `npm run tauri build` (sai em `src-tauri/target/release/`).
Requer Node 20+ e Rust (cargo). Na primeira vez rode `npm install`.

## Tela principal

- **Abrir pasta de origem**: as últimas 8 ficam em "Recentes".
- **Modelos**: todos os `.glb`/`.gltf` de `assets`, separados por pasta, com miniatura e filtro por nome.
  As miniaturas usam a inclinação da câmera do jogo (30° de elevação, 30° de giro) e ficam no cache do app.
- **Visualizador 3D**: clique num modelo. Botão esquerdo gira, direito arrasta, roda dá zoom. A grade tem células de
  2 m. Mostra tamanho em metros e em células, se a base está no chão, triângulos, materiais e toca as animações.
- **Não são peças**: passe o mouse numa pasta e clique ↓ para tirá-la de "Todos" e da paleta do mapa (ex.: `scenes`, cenas
  inteiras feitas no Blender). ↑ volta. Fica guardado em `alvorland-studio.json` (`notPieces`).
- **Configurar**: projeto Godot de destino, pastas da origem e do Godot, executável do Godot.

## Editor de mapa

Na barra lateral, **Mapas** lista os mapas de `map/`; "+ Novo mapa" cria um.

- Paleta à esquerda: escolha a pasta, clique num modelo e clique no chão para colocar (pode clicar várias vezes).
  **R** gira 90° (Shift+R para o outro lado), **Esc** para de colocar.
- Clique num objeto para selecionar: arraste as setas para mover, **Delete** apaga, **Ctrl+D** duplica.
  À direita dá para digitar posição, giro e escala, e **travar** o objeto (ex.: a base do mapa), que aí não é mais
  selecionado clicando na vista; os travados aparecem numa lista à direita para destravar.
- **Ctrl+Z** desfaz, **Ctrl+S** salva (em `map/<nome>.map.json`).
- Vista: botão direito gira, botão do meio arrasta, roda dá zoom. Encaixe: centro da célula de 2 m, meio metro ou livre.

## Sincronizar com o Godot

Primeiro mostra o que vai acontecer (copiar, apagar, mapas gerados) e só muda algo depois de confirmar.

- `assets/` da origem → pasta de modelos no Godot (padrão `res://assets/`): copia o que é novo ou mudou e
  **apaga o que não existe mais na origem**. Ficam só os arquivos que o Godot cria ao importar (o `.import` de cada
  arquivo e as texturas que ele extrai de um `.glb`). Por isso essa pasta é só da ferramenta: não coloque nada à mão nela.
- cada `map/<nome>.map.json` → `res://maps/<nome>.tscn`, um nó por objeto instanciando o `.glb`. Cenas `.tscn` dessa
  pasta que não vêm mais de um mapa são apagadas.
- Depois roda `godot --headless --import` no projeto (se o executável estiver configurado).
- A pasta de destino precisa ficar dentro do projeto Godot e não pode ser a raiz dele.

## Estrutura

- `src-tauri/src/lib.rs`: lado Rust (ler `project.godot`, listar modelos e mapas, ler/gravar texto, miniaturas).
- `src-tauri/src/sync.rs`: sincronização com o Godot (com teste: `cargo test` em `src-tauri`).
- `src/workspace.ts`: pasta de origem e configuração (`alvorland-studio.json`).
- `src/App.tsx`: telas (inicial e da origem). `src/SyncDialog.tsx`, `src/ConfigDialog.tsx`: janelas.
- `src/Viewer.tsx`: visualizador 3D. `src/Card.tsx`: cartão com miniatura.
- `src/three/`: carregar GLB (com texturas externas), miniaturas, cache de modelos.
- `src/map/`: editor de mapa (`MapEditor.tsx`), parte 3D (`mapScene.ts`), formato e exportação `.tscn` (`mapFile.ts`).
