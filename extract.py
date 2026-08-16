#!/usr/bin/env python3
"""Parse the Matcha Flavoured datapack into a food dependency graph.

Outputs food_tree.json with:
  nodes: every item (raw material, intermediate, stock, custom food)
  links: "made by" edges (source=result/child -> target=ingredient/parent)
The "made by" relation points UP the tree (result is made from its ingredients).

Extra data the viewer consumes:
  node.img        -> item texture filename (extracted to images/ from the
                     resource pack, falling back to the base item / model layer0)
  node.recipes    -> per-recipe ingredient diagram data: creation type, per-slot
                     ingredient counts, "any of" alternatives, cooking time / xp
  node.variants   -> member items for container nodes (items with identical
                     relations, e.g. egg/blue_egg/brown_egg -> "Eggs")
  link.types      -> creation method(s) for colour coding: shapeless / shaped
                     (crafted), smelting (furnace), smoking (smoker), campfire
"""

import argparse
import json
import os
import re
import tempfile
import urllib.request
import zipfile
from collections import defaultdict

DEFAULT_ZIP = "/home/kuno/Docker-Server/copyparty/data/minecraft/world/datapacks/Matcha_Flavoured_1_03.zip"
DEFAULT_RESPACK = "/home/kuno/Docker-Server/copyparty/data/temp/Matcha_Flavoured.zip"


def resolve_zip(path_or_url):
    """Return a local zip path. If given a http(s) URL, download it first."""
    if isinstance(path_or_url, str) and path_or_url.startswith(("http://", "https://")):
        print("downloading", path_or_url)
        fd, tmp = tempfile.mkstemp(suffix=".zip")
        os.close(fd)
        try:
            with urllib.request.urlopen(path_or_url, timeout=120) as r, open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1 << 16)
                    if not chunk:
                        break
                    f.write(chunk)
            return tmp
        except Exception:
            os.unlink(tmp)
            raise
    return path_or_url

RECIPE_TYPES = {
    "minecraft:smelting": "smelting",
    "minecraft:campfire_cooking": "campfire",
    "minecraft:smoking": "smoking",
    "minecraft:crafting_shapeless": "shapeless",
    "minecraft:crafting_shaped": "shaped",
}

# vanilla item tags referenced by the food recipes.  The pack relies on the base
# game's tag and extends it with its custom variants (blue_egg, brown_egg).
ITEM_TAGS = {
    "eggs": {"egg", "blue_egg", "brown_egg"},
}

DRINKS = {"mead", "honey_ginger_tea", "milk_bottle"}
GOLDEN = {"baked_golden_apple", "canned_golden_apples", "golden_apple",
          "golden_carrot", "golden_carrot_cupcake", "golden_pickled_carrots",
          "golden_steamed_carrots", "gilded_empanada", "gilded_empananda",
          "golden_apple_empanada", "steamed_golden_carrots"}
MEAT_FISH_IDS = {"cooked_beef", "cooked_chicken", "cooked_cod", "cooked_mutton",
                 "cooked_porkchop", "cooked_rabbit", "cooked_salmon",
                 "cooked_tropical_fish", "cooked_pufferfish",
                 "charred_meat", "charred_fish"}


def slugify(name):
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return s or "item"


def humanize(item_id):
    return re.sub(r"[\s_]+", " ", item_id.replace("minecraft:", "").replace("_", " ")).title()


def plural(word):
    if word.endswith(("s", "x", "z", "ch", "sh")):
        return word + "es"
    if len(word) > 1 and word.endswith("y") and word[-2] not in "aeiou":
        return word[:-1] + "ies"
    return word + "s"


def group_label(labels):
    """Pick a container name for a set of variant labels (e.g. eggs)."""
    labels = sorted(set(labels))
    if len(labels) == 1:
        return labels[0]
    words = [l.split() for l in labels]
    for tail in words[0]:
        if all(w and w[-1] == tail for w in words):
            if tail.endswith("s"):
                return tail
            return plural(tail)
    return " / ".join(labels)


class Pack:
    def __init__(self, zip_path):
        self.zip_path = zip_path
        self.tmpdir = tempfile.mkdtemp(prefix="matcha_")
        self._extract()

    def _extract(self):
        with zipfile.ZipFile(self.zip_path) as z:
            z.extractall(self.tmpdir)

    @property
    def lang(self):
        with open(os.path.join(self.tmpdir, "assets", "minecraft", "lang", "en_us.json")) as f:
            return json.load(f)

    def recipe_files(self):
        base = os.path.join(self.tmpdir, "data", "food", "recipe")
        for fn in sorted(os.listdir(base)):
            if fn.endswith(".json"):
                yield os.path.join(base, fn), fn


class ResPack:
    """Indexes the resource pack for item textures and custom item models."""

    def __init__(self, zip_path):
        self.zip_path = zip_path
        self.textures = set()
        self.models = {}
        self._ok = False
        if not zip_path or not os.path.exists(zip_path):
            return
        with zipfile.ZipFile(zip_path) as z:
            for n in z.namelist():
                if n.startswith("assets/minecraft/textures/item/") and n.endswith(".png"):
                    self.textures.add(n.split("/")[-1][:-4])
                elif n.startswith("assets/minecraft/models/item/") and n.endswith(".json"):
                    name = n.split("/")[-1][:-5]
                    try:
                        m = json.loads(z.read(n))
                        layer = (m.get("textures") or {}).get("layer0", "")
                        if layer.startswith("minecraft:item/"):
                            self.models[name] = layer[len("minecraft:item/"):]
                    except Exception:
                        pass
        self._ok = True

    def ok(self):
        return self._ok

    def texture(self, name):
        """Resolve an item id / model to a texture filename, or None."""
        if name and name in self.textures:
            return name
        if name and name in self.models and self.models[name] in self.textures:
            return self.models[name]
        return None

    def read_texture(self, name):
        with zipfile.ZipFile(self.zip_path) as z:
            return z.read("assets/minecraft/textures/item/%s.png" % name)


def resolve_name(pack, recipe, fallback_id):
    """Resolution order: item_name -> custom_name -> lang[base] -> humanize(base)."""
    comp = recipe.get("result", {}).get("components", {})
    for key in ("minecraft:item_name", "minecraft:custom_name"):
        nc = comp.get(key)
        if isinstance(nc, dict) and "translate" in nc:
            return pack.lang.get(nc["translate"], humanize(nc["translate"].split(".")[-1]))
        if isinstance(nc, str):
            return nc
    lang_key = "item.minecraft." + fallback_id
    if lang_key in pack.lang:
        return pack.lang[lang_key]
    return humanize(fallback_id)


def classify(pack, name_key, base_id, comp, recipe_type):
    is_food = "minecraft:food" in comp
    remainder = comp.get("minecraft:use_remainder", {}).get("id", "")
    animation = comp.get("minecraft:consumable", {}).get("animation")

    if not is_food:
        if base_id in ("splash_potion", "lingering_potion"):
            return "potion"
        if base_id in ("shulker_spawn_egg", "enderman_spawn_egg",
                       "magma_cube_spawn_egg", "strider_spawn_egg",
                       "zoglin_spawn_egg", "zombified_piglin_spawn_egg",
                       "wither_skeleton_spawn_egg"):
            return "stock"  # Dough / Flour / Flour Bag / Curry Stock etc.
        if base_id in ("sugar",):
            return "ingredient"
        if recipe_type == "shaped":
            return "crafted"
        return "ingredient"

    if remainder.endswith("bowl"):
        return "soup"
    if remainder.endswith("glass_bottle"):
        if name_key.lower() in DRINKS or animation == "drink":
            return "drink"
        return "preserve"
    if name_key.lower() in GOLDEN or slugify(name_key) in GOLDEN or base_id in GOLDEN:
        return "golden"
    if recipe_type in ("smelting", "campfire", "smoking"):
        if base_id in MEAT_FISH_IDS or any(m in base_id for m in ("cooked_", "charred_meat", "charred_fish")):
            return "meat_fish"
        return "produce"
    if recipe_type in ("shapeless", "shaped"):
        return "crafted"
    return "misc"


def parse_effects(pack, comp):
    """Return dict with applied effects and cleanse info."""
    effects = []
    cleanse = []
    clear_all = False
    consumable = comp.get("minecraft:consumable", {})
    for oc in consumable.get("on_consume_effects", []):
        t = oc.get("type", "")
        if t == "minecraft:apply_effects":
            for e in oc.get("effects", []):
                effects.append({
                    "id": e.get("id", "").replace("minecraft:", ""),
                    "level": e.get("amplifier", 0) + 1,
                    "seconds": e.get("duration", 0) / 20.0,
                    "hidden": not e.get("show_icon", True),
                })
        elif t == "minecraft:remove_effects":
            cleanse = [x.replace("minecraft:", "") for x in oc.get("effects", [])]
        elif t == "minecraft:clear_all_effects":
            clear_all = True
    return {"applied": effects, "cleanse": cleanse, "clear_all": clear_all}


def norm_slots(d):
    """Normalize a recipe's ingredient entries to [(kind, ids, count)]."""
    slots = []
    if "ingredient" in d:
        slots = [(d["ingredient"], 1)]
    elif "ingredients" in d:
        slots = [(x, 1) for x in d["ingredients"]]
    elif "key" in d and d["type"] == "minecraft:crafting_shaped":
        key_counts = defaultdict(int)
        for row in d.get("pattern", []):
            for ch in row:
                if ch in d["key"]:
                    key_counts[ch] += 1
        slots = [(d["key"][ch], key_counts[ch]) for ch in d["key"]]
    out = []
    for value, cnt in slots:
        if isinstance(value, dict) and "item" in value:
            value = value["item"]
        if isinstance(value, list):
            out.append(("alt", [x if isinstance(x, str) else x.get("item") for x in value], cnt))
        else:
            out.append(("one", [value], cnt))
    return out


def main():
    ap = argparse.ArgumentParser(description="Extract Matcha food graph")
    ap.add_argument("--zip", default=DEFAULT_ZIP,
                    help="Datapack zip: a file path or an http(s) URL")
    ap.add_argument("--respack", default=DEFAULT_RESPACK,
                    help="Resource pack zip (item textures): file path or http(s) URL")
    ap.add_argument("-o", "--out", default="food_tree.json")
    ap.add_argument("--images", default=None,
                    help="Directory to write item textures (default: <outdir>/images)")
    ap.add_argument("--dump-recipe-types", action="store_true", help="print recipe-type census")
    args = ap.parse_args()

    zip_path = resolve_zip(args.zip)
    respack_path = resolve_zip(args.respack) if args.respack else None

    pack = Pack(zip_path)
    lang = pack.lang
    respack = ResPack(respack_path)
    if not respack.ok():
        print("WARNING: resource pack not found at %r -> images skipped" % args.respack)

    images_dir = args.images or os.path.join(os.path.dirname(os.path.abspath(args.out)), "images")

    # ---- pass 1: parse recipes ------------------------------------------------
    result_recipes = defaultdict(list)   # name_key -> [rec]
    recipe_type_count = defaultdict(int)

    def node_name_key(comp, fallback_id):
        resolved = resolve_name(pack, {"result": {"id": "minecraft:" + fallback_id,
                                                  "components": comp}}, fallback_id)
        return resolved

    for path, fn in pack.recipe_files():
        with open(path) as f:
            d = json.load(f)
        rtype = d.get("type", "")
        recipe_type_count[rtype] += 1
        result = d.get("result", {})
        rid = result.get("id", "").replace("minecraft:", "")
        comp = result.get("components", {})
        count = result.get("count", 1)

        name_key = node_name_key(comp, rid)
        rec = {
            "file": fn,
            "type": RECIPE_TYPES.get(rtype, rtype),
            "category": d.get("category", "misc"),
            "result_id": rid,
            "count": count,
            "is_food": "minecraft:food" in comp,
            "has_consume": "minecraft:consumable" in comp,
            "item_model": comp.get("minecraft:item_model", "").replace("minecraft:", ""),
            "xp": d.get("experience"),
            "time": d.get("cookingtime"),
            "slots": norm_slots(d),
        }
        result_recipes[name_key].append(rec)

    # ---- ingredient item info -------------------------------------------------
    item_label = {}
    item_key = {}

    def item_info(raw_id):
        if raw_id.startswith("#"):
            return None
        iid = raw_id.replace("minecraft:", "")
        if iid not in item_label:
            item_label[iid] = lang.get("item.minecraft." + iid, humanize(iid))
            item_key[iid] = slugify(item_label[iid])
        return item_label[iid], iid

    # ---- pass 2: build result nodes -------------------------------------------
    nodes = {}   # key -> node dict

    for name_key, recs in result_recipes.items():
        base = recs[0]["result_id"]
        with open(os.path.join(pack.tmpdir, "data", "food", "recipe", recs[0]["file"])) as f:
            comps = json.load(f)["result"].get("components", {})
        cat = classify(pack, name_key, base, comps, recs[0]["type"])
        node = {
            "id": slugify(name_key),
            "label": name_key,
            "base": base,
            "category": cat,
            "is_food": recs[0]["is_food"],
            "made_by_recipes": [r["type"] for r in recs],
            "result_ids": list({r["result_id"] for r in recs}),
            "count": recs[0]["count"],
            "stack": comps.get("minecraft:max_stack_size", 64),
            "remainder": comps.get("minecraft:use_remainder", {}).get("id", "").replace("minecraft:", ""),
            "lore": [x["text"] for x in comps.get("minecraft:lore", []) if isinstance(x, dict)],
            "effects": parse_effects(pack, comps),
            "nutrition": comps.get("minecraft:food", {}).get("nutrition", 0),
            "can_always_eat": comps.get("minecraft:food", {}).get("can_always_eat", False),
            "recipes": [],
        }
        nodes[slugify(name_key)] = node

    # ---- pass 3: ingredient nodes + links -------------------------------------
    ing_nodes = {}
    link_types = defaultdict(set)   # (source, target) -> {recipe types}
    raw_links = []                  # (source_key, target_key)

    for name_key, recs in result_recipes.items():
        result_key = slugify(name_key)
        if result_key not in nodes:
            continue
        # types of the recipes that use a given parent
        for rec in recs:
            for kind, ids, cnt in rec["slots"]:
                for raw_id in ids:
                    if raw_id.startswith("#"):
                        tag = raw_id[1:].replace("minecraft:", "")
                        parent_key = "tag:" + tag
                        if parent_key not in ing_nodes:
                            ing_nodes[parent_key] = {
                                "id": parent_key,
                                "label": humanize(tag) + " (tag)",
                                "base": "#" + tag,
                                "category": "tag",
                                "is_food": False,
                                "raw": True,
                                "made_by_recipes": [],
                                "count": 1,
                                "recipes": [],
                            }
                        if parent_key != result_key:
                            raw_links.append((result_key, parent_key))
                            link_types[(result_key, parent_key)].add(rec["type"])
                    else:
                        label, iid = item_info(raw_id)
                        key = item_key[iid]
                        if key not in ing_nodes:
                            ing_nodes[key] = {
                                "id": key,
                                "label": label,
                                "base": iid,
                                "category": "raw",
                                "is_food": False,
                                "raw": True,
                                "made_by_recipes": [],
                                "count": 1,
                                "recipes": [],
                            }
                        if key != result_key:
                            raw_links.append((result_key, key))
                            link_types[(result_key, key)].add(rec["type"])

    # merge: an ingredient may also be a recipe result (e.g. Flour, Dough)
    for key, ing in ing_nodes.items():
        if key in nodes:
            nodes[key].setdefault("raw", False)
            continue
        nodes[key] = ing

    # classify intermediate nodes that ARE produced but have no food comp
    for node in nodes.values():
        if node["is_food"]:
            continue
        if node["made_by_recipes"] and node["category"] in ("raw", "tag"):
            if node["base"] in ("shulker_spawn_egg", "enderman_spawn_egg",
                                "magma_cube_spawn_egg", "strider_spawn_egg",
                                "zoglin_spawn_egg", "zombified_piglin_spawn_egg",
                                "wither_skeleton_spawn_egg"):
                node["category"] = "stock"
            elif node["category"] == "raw":
                node["category"] = "ingredient"

    # ---- pass 4: variant containers --------------------------------------------
    # A container groups items that the pack explicitly treats as interchangeable
    # (they co-occur in an ingredient alternative slot, or share an item tag) AND
    # that have identical relations (every recipe uses them the same way).  This
    # merges egg/blue_egg/brown_egg into "Eggs" but keeps e.g. beef vs chicken
    # separate (they feed different cooked recipes) and does not merge potion in
    # just because it happens to also make dough.
    children = defaultdict(set)
    parents = defaultdict(set)
    for s, t in raw_links:
        children[s].add(t)
        parents[t].add(s)

    sig_by_key = {}
    for key, node in nodes.items():
        if node["is_food"]:
            continue
        sig_by_key[key] = (tuple(sorted(parents.get(key, ()))),
                           tuple(sorted(children.get(key, ()))))

    def expand_variant(ids):
        out = set()
        for i in ids:
            if i.startswith("#"):
                out |= ITEM_TAGS.get(i[1:], set())
            else:
                out.add(i.replace("minecraft:", ""))
        return out

    variant_clusters = []
    for recs in result_recipes.values():
        for rec in recs:
            for kind, ids, _cnt in rec["slots"]:
                if kind != "alt":
                    continue
                expanded = expand_variant(ids)
                if not expanded:
                    continue
                merged = [c for c in variant_clusters if c & expanded]
                if merged:
                    base = set().union(*merged, expanded)
                    variant_clusters = [c for c in variant_clusters if c not in merged]
                    variant_clusters.append(base)
                else:
                    variant_clusters.append(expanded)

    def make_container(cid, label, member_keys):
        members = [nodes[k] for k in member_keys if k in nodes]
        node = {
            "id": cid,
            "label": label,
            "base": members[0]["base"] if members else "",
            "category": "tag" if all(m["category"] == "tag" for m in members) else "raw",
            "is_food": False,
            "raw": True,
            "made_by_recipes": [],
            "count": 1,
            "stack": 64,
            "remainder": "",
            "lore": [],
            "effects": {"applied": [], "cleanse": [], "clear_all": False},
            "nutrition": 0,
            "can_always_eat": False,
            "recipes": [],
            "variants": sorted({m["label"] for m in members}),
            "_members": list(member_keys),
        }
        return node

    container_of = {}   # node key -> container id
    containers = {}     # container id -> node dict
    for cluster in variant_clusters:
        keys = {item_key.get(i) for i in cluster if i in item_key}
        keys = {k for k in keys if k in sig_by_key}
        by_sig = defaultdict(list)
        for k in keys:
            by_sig[sig_by_key[k]].append(k)
        for sig, ks in by_sig.items():
            if len(ks) < 2:
                continue
            label = group_label([nodes[k]["label"] for k in ks])
            cid = "group:" + slugify(label)
            while cid in containers or cid in nodes:
                cid += "_x"
            containers[cid] = make_container(cid, label, ks)
            for k in ks:
                container_of[k] = cid

    # fold tag nodes whose members all belong to a single container
    for tag, members in ITEM_TAGS.items():
        tag_key = "tag:" + tag
        if tag_key not in nodes:
            continue
        member_keys = [item_key.get(m) for m in members if m in item_key]
        targets = {container_of.get(k, k) for k in member_keys if k}
        if len(targets) == 1:
            target = next(iter(targets))
            if target != tag_key:
                container_of[tag_key] = target

    # ---- pass 5: rebuild nodes + links with remapping -------------------------
    def remap(key):
        return container_of.get(key, key)

    new_nodes = {}
    for key, node in nodes.items():
        nk = remap(key)
        if nk == key:
            new_nodes[key] = node
        elif nk not in new_nodes:
            new_nodes[nk] = node
    new_nodes.update(containers)

    new_links = {}
    for s, t in raw_links:
        rs, rt = remap(s), remap(t)
        if rs == rt:
            continue
        key = (rs, rt)
        new_links.setdefault(key, set()).update(link_types.get((s, t), set()))
    links = [{"source": s, "target": t, "types": sorted(ts)}
             for (s, t), ts in sorted(new_links.items())]

    # ---- pass 6: images -------------------------------------------------------
    def resolve_img(node):
        if node.get("_members"):
            for mk in node["_members"]:
                t = respack.texture(nodes[mk]["base"])
                if t:
                    return t
            return None
        if node.get("made_by_recipes"):
            for cand in node.get("img_candidates") or []:
                t = respack.texture(cand)
                if t:
                    return t
            return None
        return respack.texture(node["base"])

    for name_key, recs in result_recipes.items():
        rk = remap(slugify(name_key))
        n = new_nodes.get(rk)
        if n is not None and n.get("made_by_recipes"):
            n["img_candidates"] = [r["item_model"] or r["result_id"] for r in recs] + [n["id"], n["base"]]
    for node in new_nodes.values():
        node["img"] = resolve_img(node)

    # ---- pass 7: recipe diagram data (resolve slots to node ids) --------------
    def resolve_slot(raw_id, cnt):
        if raw_id.startswith("#"):
            tag = raw_id[1:].replace("minecraft:", "")
            key = "tag:" + tag
        else:
            label, iid = item_info(raw_id)
            key = item_key[iid]
        rk = remap(key)
        n = new_nodes.get(rk)
        if not n:
            return None
        return {"id": rk, "label": n["label"], "img": n.get("img"), "count": cnt}

    def resolve_slot_any(ids, cnt):
        entries = []
        for raw_id in ids:
            e = resolve_slot(raw_id, 1)
            if e:
                entries.append(e)
        if not entries:
            return None
        # if every alternative maps to the same node -> a single slot
        if len({e["id"] for e in entries}) == 1:
            e = dict(entries[0])
            e["count"] = cnt
            return e
        return {"id": entries[0]["id"], "label": entries[0]["label"],
                "img": entries[0]["img"], "count": cnt, "any_of": entries}

    for name_key, recs in result_recipes.items():
        result_key = slugify(name_key)
        node = new_nodes.get(remap(result_key))
        if not node or not node.get("made_by_recipes"):
            continue
        node["recipes"] = []
        for rec in recs:
            ings = []
            for kind, ids, cnt in rec["slots"]:
                if kind == "one":
                    entry = resolve_slot(ids[0], cnt)
                else:
                    entry = resolve_slot_any(ids, cnt)
                if entry:
                    ings.append(entry)
            # merge repeated slots (e.g. 3x flour in dough)
            merged = {}
            for e in ings:
                key = ("any", tuple(x["id"] for x in e["any_of"])) if "any_of" in e else ("one", e["id"])
                if key in merged:
                    merged[key]["count"] += e["count"]
                else:
                    merged[key] = e
            ings = list(merged.values())
            recipe = {
                "type": rec["type"],
                "category": rec["category"],
                "count": rec["count"],
                "ingredients": ings,
            }
            if rec["time"]:
                recipe["time"] = rec["time"]
            if rec["xp"] is not None:
                recipe["xp"] = rec["xp"]
            node["recipes"].append(recipe)

    # ---- write output ---------------------------------------------------------
    used_in = defaultdict(int)
    for l in links:
        used_in[l["source"]] += 1
    for node in new_nodes.values():
        node["used_in_count"] = used_in.get(node["id"], 0)

    if respack.ok():
        os.makedirs(images_dir, exist_ok=True)
        copied = set()
        for node in new_nodes.values():
            if node.get("img"):
                copied.add(node["img"])
        for rec_list in [n.get("recipes") or [] for n in new_nodes.values()]:
            for r in rec_list:
                for ing in r.get("ingredients", []):
                    if ing.get("img"):
                        copied.add(ing["img"])
                    for a in ing.get("any_of") or []:
                        if a.get("img"):
                            copied.add(a["img"])
        for name in sorted(copied):
            with open(os.path.join(images_dir, name + ".png"), "wb") as f:
                f.write(respack.read_texture(name))
        # prune stale textures from previous runs
        for old in os.listdir(images_dir):
            if old.endswith(".png") and old[:-4] not in copied:
                os.remove(os.path.join(images_dir, old))
        print(f"wrote {len(copied)} textures -> {images_dir}")
    else:
        for node in new_nodes.values():
            node.pop("img", None)

    for node in new_nodes.values():
        node.pop("img_candidates", None)
        node.pop("_members", None)

    out = {"nodes": list(new_nodes.values()), "links": links,
           "stats": {"nodes": len(new_nodes), "links": len(links)}}
    with open(args.out, "w") as f:
        json.dump(out, f, indent=1)

    print(f"nodes: {len(new_nodes)}  links: {len(links)}")
    print("recipe types:", dict(recipe_type_count))
    cats = defaultdict(int)
    for n in new_nodes.values():
        cats[n["category"]] += 1
    print("categories:", dict(sorted(cats.items())))
    if containers:
        print("containers:", {cid: c["variants"] for cid, c in containers.items()})
    print("written ->", os.path.abspath(args.out))

    # clean up zips we downloaded from a URL
    for tmp in (zip_path, respack_path):
        if tmp != args.zip and tmp != args.respack and tmp and os.path.exists(tmp):
            os.unlink(tmp)


if __name__ == "__main__":
    main()
