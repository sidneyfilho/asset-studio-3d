# Alvorland Studio (asset-studio-3d)

Ferramenta separada do Godot para gerenciar os modelos 3D (e, na próxima etapa, os mapas) de qualquer
projeto Godot. Feita com Tauri 2 + React + three.js, no mesmo jeito do Object Builder.

## Como abrir

Dê dois cliques em `studio.bat` (modo desenvolvimento: compila e abre a janela).
Para gerar o instalador `.exe`: `npm run tauri build` (sai em `src-tauri/target/release/bundle/nsis`).

Requer Node 20+ e Rust (cargo). Na primeira vez rode `npm install`.

## O que já faz (etapa 1)

- **Abrir projeto**: escolha qualquer pasta com `project.godot`. Os últimos 8 projetos ficam em "Recentes".
- **Pastas ignoradas**: na tela inicial (padrão: `backups, node_modules, addons`); pastas que começam com `.` (ex.: `.godot`) são sempre puladas.
- **Lista de modelos**: todos os `.glb`/`.gltf` do projeto, separados por pasta, com miniatura e filtro por nome.
  As miniaturas usam a mesma inclinação da câmera do jogo (30° de elevação, 30° de giro) e ficam guardadas no
  cache do app; só são refeitas quando o arquivo muda.
- **Visualizador 3D**: clique num modelo. Botão esquerdo gira, direito arrasta, roda dá zoom.
  A grade do chão tem células de 2 m (padrão do kit). Mostra tamanho em metros e em células, se a base está no
  chão (y = 0), triângulos, malhas, materiais, tamanho do arquivo e toca as animações.

- **Não são peças**: passe o mouse numa pasta e clique ↓ para tirá-la de "Todos" e da paleta do mapa
  (ex.: `assets/ref`, que tem a cena inteira feita no Blender). ↑ volta. Fica guardado por projeto.

## Editor de mapa (etapa 2)

Na barra lateral, **Mapas** lista os mapas do projeto (`*.map.json`); "+ Novo mapa" cria um.

- Paleta à esquerda: escolha a pasta, clique num modelo e clique no chão para colocar (pode clicar várias vezes).
  **R** gira 90° (Shift+R para o outro lado), **Esc** para de colocar.
- Clique num objeto para selecionar: arraste as setas para mover, **Delete** apaga, **Ctrl+D** duplica.
  À direita dá para digitar posição, giro e escala.
- **Ctrl+Z** desfaz, **Ctrl+S** salva.
- Vista: botão direito gira, botão do meio arrasta, roda dá zoom.
- Encaixe: centro da célula de 2 m (peças do kit), meio metro, ou livre.

Salvar grava dois arquivos lado a lado (padrão: pasta `maps/` do projeto):
- `nome.map.json`: o arquivo de trabalho, que a ferramenta abre de novo;
- `nome.tscn`: a cena do Godot, com um nó por objeto instanciando o `.glb` (posição, giro e escala). É o que o jogo usa.

## Estrutura

- `src-tauri/src/lib.rs`: lado Rust (ler `project.godot`, listar modelos, guardar miniaturas).
- `src/App.tsx`: telas (inicial e do projeto).
- `src/Viewer.tsx`: visualizador 3D.
- `src/three/loadModel.ts`: carrega GLB do disco (inclusive texturas externas, como as da Kenney).
- `src/three/thumbnails.ts`: fila de miniaturas.
- `src/three/modelCache.ts`: lê cada modelo uma vez e faz cópias para o mapa.
- `src/map/MapEditor.tsx`: tela do editor de mapa.
- `src/map/mapScene.ts`: parte 3D do editor (chão, grade, colocar, selecionar, mover).
- `src/map/mapFile.ts`: formato `.map.json` e exportação `.tscn`.
