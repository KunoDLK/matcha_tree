# Matcha Flavoured Food Tree

Interactive dependency tree of the "Matcha Flavoured" Minecraft datapack's
recipe-driven food system. Every custom food (and its ingredients) is shown as
a node; edges are **"made by"** relations pointing **upward** to raw materials.

## What it does

- Parses the datapack zip (`Matcha_Flavoured_1_03.zip`) — 122 recipe JSONs —
  into a dependency graph (`food_tree.json`): 126 nodes, 254 relations.
- Pulls item icons from the resource pack zip into `images/`.
- Renders the graph on an **infinite pan/zoom canvas** (D3 force simulation).
- Nodes **fan out by relation**: raw materials sit on top, dishes below,
  "made by" edges point upward.
- **Edges are colour-coded by creation method** (craft = green, furnace =
  blue, smoker = orange, campfire = amber; dashed = multiple methods).
- **Select any node** → every item that isn't a recursive ancestor (all the way
  to raw materials) or a recursive descendant ("used in" dishes) is **hidden**;
  the focused chain stays **exactly where it is** (positions are pinned, no
  re-layout) and the view centres on it.
- **Drag** any node to move it; the tree adapts around it.

## Usage

```bash
# 1. Extract the graph from the datapack zip (default paths in extract.py)
python3 extract.py -o viewer/food_tree.json --images viewer/images
cp food_tree.json viewer/food_tree.json   # keep the repo-root copy in sync

# 2. Launch the viewer (window if pywebview+backend available, else browser)
.venv/bin/python app.py          # or: python3 app.py --browser
```

`extract.py` defaults to the datapack at
`/home/kuno/Docker-Server/copyparty/data/minecraft/world/datapacks/Matcha_Flavoured_1_03.zip`
and the resource pack at
`/home/kuno/Docker-Server/copyparty/data/temp/Matcha_Flavoured.zip`
(override either with `--zip` / `--respack`).

## Controls

| Action | Effect |
|---|---|
| Wheel | zoom |
| Drag empty space | pan |
| Drag node | move node (tree adapts) |
| Click node | isolate its ancestry + descendants, re-layout |
| Esc / click empty canvas | clear selection, restore full tree |
| Reset / Fit | reset zoom & selection / fit all nodes |
| Detail panel | effects, lore, **graphical recipe** (ingredient icons → result), variants |

## Layout algorithm

Simple D3 force simulation (link/charge/collide/center) plus a **score pull**:
every edible item is scored from its lore and effects (lore amount = ❤ hearts,
extra lore amount = ❣ over-heal hearts, extra lore time = max `(m:ss)` in the
lore text, effect level, effect duration). Each factor is raised to a
**weight** (dialed with sliders) and the factors are multiplied; the lowest
scoring food is pulled up hardest and the highest is pulled down hardest
(non-edible items get no pull). The Tune panel also exposes log-scale
repulsion (up to 10k), link strength/distance, and node padding. Selecting a
node hides unrelated items and re-lays-out the subgraph while the camera glides
to follow it.

## Known quirks

- Flour ⇄ Flour Bag is a genuine 2-cycle in the pack (9 flour ⇄ 1 bag). The
  traversal guards against infinite loops, so it renders fine.
- Campfire twins (each smelting recipe has a `_campfire` twin) are merged
  during parsing; edges keep both creation types (drawn dashed).
- "Made by" edges are collapsed when a recipe repeats an ingredient (e.g.
  3× wheat → flour becomes one edge).
- Interchangeable variants with identical relations collapse into a single
  **container node** (egg / blue egg / brown egg → "Eggs"), shown with a "×N"
  badge and a variant list in the detail panel.
- Items the resource pack doesn't texture (vanilla cake, raw meats, sugar…)
  fall back to a lettered chip instead of an icon.

## Requirements

- Python 3.10+
- Optional: `pywebview` in a venv for a native window
  (`.venv/bin/pip install pywebview`), plus a GTK or Qt backend on Linux.
- Otherwise any modern browser (opens automatically).
