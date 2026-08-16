# Matcha Flavoured Food Tree

**Live demo: [matcha.kunodlk.com](https://matcha.kunodlk.com/)**

Interactive crafting tree for the "Matcha Flavoured" Minecraft datapack. Nodes are
items; edges point **upward** from a dish to its ingredients ("made by").
Dishes fan out below raw materials, colour-coded by how they're made (craft,
furnace, smoker, campfire).

## How it works

- `extract.py` unzips the datapack, parses every recipe, and emits a dependency
  graph (`food_tree.json`) plus item textures — all pulled fresh from the modrinth
  URL on startup, so nothing is committed to the repo.
- The viewer runs a **D3 force simulation** that lays the tree out and lets you
  pan/zoom/drag.
- **Food mode** scores each edible from its lore and effects, pulling the best
  foods to the top and the worst to the bottom. **All mode** shows every
  craftable item with a **Progress** slider that reveals items as you advance
  through the datapack's progression stages.
- Click any node to inspect it (effects, recipe, raw-material cost); select its
  ancestors/descendants and press **Return to full view** (or `Esc`) to go back.

## Run locally

```bash
python3 extract.py --zip <datapack.zip-or-url> -o viewer/food_tree.json --images viewer/images
python3 app.py --server-port 8080   # serves viewer/ on 0.0.0.0:8080
```

Or via Docker:

```bash
docker build -t matcha-tree . && docker run -d -p 8325:8080 matcha-tree
```

## Requirements

Python 3.10+ and a browser. `pywebview` (plus a GTK/Qt backend) is optional for a
native window instead of the browser.
