"use strict";

const CAT_COLORS = {
  raw: "#aab3c5",
  tag: "#aab3c5",
  ingredient: "#7a8598",
  stock: "#9b6bff",
  soup: "#4fc3f7",
  preserve: "#ff8a65",
  drink: "#4dd0e1",
  meat_fish: "#ef5350",
  produce: "#66bb6a",
  crafted: "#ffb74d",
  golden: "#ffd54f",
  potion: "#ba68c8",
  misc: "#90a4ae",
};

const CAT_LABELS = {
  raw: "Raw material",
  tag: "Item tag",
  ingredient: "Ingredient",
  stock: "Stock / intermediate",
  soup: "Soup / stew",
  preserve: "Jam / pickle / preserve",
  drink: "Drink",
  meat_fish: "Cooked meat & fish",
  produce: "Cooked produce",
  crafted: "Crafted main",
  golden: "Crafted golden",
  potion: "Potion",
  misc: "Other",
};

// edge colour by creation method
const TYPE_COLORS = {
  shaped: "#7fb069",    // crafted (shaped)
  shapeless: "#7fb069", // crafted (shapeless)
  smelting: "#4fc3f7",  // furnace
  smoking: "#ff8a65",   // smoker
  campfire: "#ffb74d",  // campfire
};
const TYPE_ORDER = ["shaped", "shapeless", "smelting", "smoking", "campfire"];
const TYPE_LABELS = {
  shaped: "Crafting (shaped)",
  shapeless: "Crafting (shapeless)",
  smelting: "Furnace / smelting",
  smoking: "Smoker",
  campfire: "Campfire",
};
const DEFAULT_LINK = "#3a4456";

function linkColor(l) {
  const ts = l.types || [];
  if (!ts.length) return DEFAULT_LINK;
  for (const t of TYPE_ORDER) if (ts.includes(t)) return TYPE_COLORS[t];
  return DEFAULT_LINK;
}
function linkDash(l) {
  return (l.types || []).length > 1 ? "5 4" : null;
}

let graph;
let svg, g, linkLayer, nodeLayer, labelLayer;
let simulation;
let zoom;
let nodesById = new Map();
let linkById = new Map();

let selectedId = null;      // current focus node
let visibleIds = new Set(); // ids currently in the simulation
let follow = false;         // camera follows the visible nodes while they settle

const state = {
  allNodes: [],
  allLinks: [],     // pristine string links (never given to d3.forceLink)
  rawLinks: [],     // immutable copies used for relation queries
};

/* ---------- scoring for the up/down pull force ---------- */
// weight (exponent) for each factor; 0 = factor ignored
const SCORE_WEIGHTS = {
  loreAmount: 1,
  extraLore: 1,
  extraTime: 1,
  effectLevel: 1,
  effectDuration: 1,
};
let scoreStrength = 30;     // max pull magnitude (applied to vy per tick)

// debuff effects flip the score negative (invisibility is a buff, not a debuff)
const BAD_EFFECTS = new Set(["weakness", "poison", "levitation"]);

function hasBadEffect(n) {
  return (n.effects && n.effects.applied || []).some(e => BAD_EFFECTS.has(e.id));
}

function nodeFactors(n) {
  const loreText = (n.lore || []).join(" ");
  const times = [];
  for (const m of loreText.matchAll(/\((\d+):(\d+)\)/g)) times.push(+m[1] * 60 + +m[2]);
  const effs = (n.effects && n.effects.applied) || [];
  return {
    loreAmount: (loreText.match(/❤/g) || []).length,
    extraLore: (loreText.match(/❣/g) || []).length,
    extraTime: times.length ? Math.max(...times) : 0,
    effectLevel: effs.length ? Math.max(...effs.map(e => e.level)) : 0,
    effectDuration: effs.length ? Math.max(...effs.map(e => e.seconds)) : 0,
  };
}

function computeScore(n) {
  const f = nodeFactors(n);
  let s = 1;
  for (const k in SCORE_WEIGHTS) {
    const w = SCORE_WEIGHTS[k];
    if (w === 0) continue;
    s *= Math.pow(1 + f[k], w);   // +1 so a missing factor stays neutral
  }
  if (hasBadEffect(n)) s *= -1;   // debuffs make the score negative
  return s;
}

// symmetric log scale so negative (bad) scores work: sign(x) * ln(1 + |x|)
function signedLog(x) {
  return Math.sign(x) * Math.log(1 + Math.abs(x));
}

// _pull in [-1, 1]: best item -> -1 (pulled up/top), worst item -> +1 (pulled down).
// Normalised linearly over the LOG of the score so a few huge scores don't
// crush the rest of the foods to the extremes.
function computePulls() {
  const foods = state.allNodes.filter(n => n.is_food);
  if (foods.length < 2) { state.allNodes.forEach(n => n._pull = 0); return; }
  const logs = foods.map(n => signedLog(computeScore(n)));
  const minL = Math.min(...logs), maxL = Math.max(...logs);
  const range = maxL - minL;
  const pullById = new Map();
  foods.forEach((n, i) => {
    const up = range > 0 ? 1 - 2 * (logs[i] - minL) / range : 0;  // +1 up, -1 down
    pullById.set(n.id, up);
  });
  state.allNodes.forEach(n => n._pull = pullById.get(n.id) || 0);
}

// constant-direction pull scaled by the node's score-derived value
function scoreForce(alpha) {
  for (const node of simulation.nodes()) {
    if (!node.is_food || !node._pull) continue;
    node.vy += alpha * node._pull * scoreStrength;
  }
}

/* ---------- load ---------- */
function load() {
  setupSvg();
  setupSimulation();
  renderLegend();
  fetch("food_tree.json")
    .then(r => r.json())
    .then(data => {
      graph = data;
      state.allNodes = graph.nodes.map(n => ({ ...n }));
      state.allLinks = graph.links.map(l => ({ ...l }));
      // keep string-only copies for ancestor/descendant queries; d3.forceLink
      // mutates the links it is given (source/target become object refs)
      state.rawLinks = graph.links.map(l => ({ source: l.source, target: l.target }));

      nodesById = new Map(state.allNodes.map(n => [n.id, n]));
      linkById = new Map(state.allLinks.map(l => [l.source + "|" + l.target, l]));

      computePulls();
      showAll();
    })
    .catch(err => {
      document.getElementById("counts").textContent = "ERROR loading food_tree.json: " + err;
    });
}

/* ---------- svg ---------- */
function setupSvg() {
  svg = d3.select("#canvas");
  g = svg.append("g");
  linkLayer = g.append("g").attr("class", "links");
  nodeLayer = g.append("g").attr("class", "nodes");
  labelLayer = g.append("g").attr("class", "labels");

  zoom = d3.zoom()
    .scaleExtent([0.05, 4])
    .on("start", (event) => {
      if (!event.sourceEvent) return;   // ignore programmatic transforms
      svg.classed("panning", true);
      follow = false;   // user takes control of the camera
    })
    .on("end", () => svg.classed("panning", false))
    .on("zoom", (event) => {
      g.attr("transform", event.transform);
      d3.selectAll(".label-text").attr("opacity", event.transform.k > 0.35 ? 1 : 0);
    });
  svg.call(zoom);

  svg.on("click", (event) => {
    // clicking empty canvas clears selection
    if (event.target === svg.node()) clearSelection();
  });
}

/* ---------- simulation ---------- */
let collidePadding = 0;

function setupSimulation() {
  simulation = d3.forceSimulation()
    // slow the cooling so the layout has time to organise (default 0.0228
    // stops after ~290 ticks, which is too soon once nodes must travel)
    .alphaDecay(0.008)
    .alphaMin(0.0002)
    .force("link", d3.forceLink().id(d => d.id)
      .distance(65)
      .strength(0.1))
    .force("charge", d3.forceManyBody().strength(-273))
    .force("collide", d3.forceCollide().radius(d => nodeRadius(d) + collidePadding).iterations(2))
    .force("center", d3.forceCenter(0, 0))
    .force("score", scoreForce)
    .on("tick", ticked);
}

function nodeRadius(n) {
  const k = Math.max(1, (n.label ? n.label.length : 8));
  return 16 + Math.min(10, k / 4);
}

function ticked() {
  linkLayer.selectAll("line")
    .attr("x1", d => d.source.x)
    .attr("y1", d => d.source.y)
    .attr("x2", d => d.target.x)
    .attr("y2", d => d.target.y);

  nodeLayer.selectAll("g")
    .attr("transform", d => `translate(${d.x},${d.y})`);
}

// ease the camera toward the centre of the visible nodes so it glides along
// while the subgraph re-lays itself out
function followCentroid() {
  const nodes = simulation.nodes();
  if (!nodes.length) return;
  const cx = d3.mean(nodes, d => d.x);
  const cy = d3.mean(nodes, d => d.y);
  const t = d3.zoomTransform(svg.node());
  const k = t.k;
  const w = window.innerWidth, h = window.innerHeight;
  const targetX = w / 2 - cx * k, targetY = h / 2 - cy * k;
  const tx = t.x + (targetX - t.x) * 0.25;
  const ty = t.y + (targetY - t.y) * 0.25;
  svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
}

let followTimer = null;

function startFollow() {
  follow = true;
  if (followTimer) clearInterval(followTimer);
  followTimer = setInterval(() => {
    if (!follow) { clearInterval(followTimer); followTimer = null; return; }
    if (simulation.alpha() <= 0.005) { follow = false; clearInterval(followTimer); followTimer = null; return; }
    followCentroid();
  }, 33);
}

/* ---------- data binding ---------- */
function showAll() {
  selectedId = null;
  visibleIds = new Set(state.allNodes.map(n => n.id));
  setMode();
  bind(state.allNodes, state.allLinks);
  fitView();
}

// d3.forceLink mutates link.source/target into node object refs, so keys must
// survive both string (pristine) and object (post-mutation) forms.
function linkKey(l) {
  const s = typeof l.source === "object" ? l.source.id : l.source;
  const t = typeof l.target === "object" ? l.target.id : l.target;
  return s + "|" + t;
}

function bind(nodes, links) {
  // merge sim state into fresh node objects
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  nodes.forEach(n => {
    const old = nodesById.get(n.id);
    if (old && old.x != null) { n.x = old.x; n.y = old.y; }
  });

  // fresh string-keyed copies so forceLink's mutation never corrupts state.allLinks
  const bindLinks = links.map(l => ({
    source: l.source, target: l.target,
    types: l.types, highlighted: !!l.highlighted,
  }));

  const link = linkLayer.selectAll("line")
    .data(bindLinks, linkKey);
  link.exit().remove();
  link.enter().append("line")
    .attr("class", "link");

  const node = nodeLayer.selectAll("g.node")
    .data(nodes, d => d.id);
  node.exit().remove();

  const nodeEnter = node.enter().append("g")
    .attr("class", "node")
    .call(d3.drag()
      .on("start", dragStarted)
      .on("drag", dragged)
      .on("end", dragEnded));

  nodeEnter.append("circle")
    .attr("r", d => nodeRadius(d))
    .attr("class", "nucleus");

  nodeEnter.append("image")
    .attr("class", "item-img")
    .attr("x", d => -nodeRadius(d) + 3)
    .attr("y", d => -nodeRadius(d) + 3)
    .attr("width", d => 2 * (nodeRadius(d) - 3))
    .attr("height", d => 2 * (nodeRadius(d) - 3))
    .attr("preserveAspectRatio", "xMidYMid meet");

  nodeEnter.append("text")
    .attr("class", "item-letter")
    .attr("text-anchor", "middle")
    .attr("y", d => nodeRadius(d) * 0.4)
    .attr("font-size", d => nodeRadius(d) * 1.1)
    .attr("fill", "rgba(255,255,255,0.85)");

  nodeEnter.append("text")
    .attr("class", "variant-badge")
    .attr("text-anchor", "middle")
    .attr("x", d => nodeRadius(d) - 5)
    .attr("y", d => nodeRadius(d) - 3)
    .attr("font-size", 9)
    .attr("fill", "#ffd166");

  nodeEnter.append("text")
    .attr("class", "label-text")
    .attr("y", d => nodeRadius(d) + 14)
    .attr("text-anchor", "middle")
    .text(d => d.label);

  const merged = node.merge(nodeEnter);

  // styling
  merged.select(".nucleus")
    .attr("fill", d => CAT_COLORS[d.category] || CAT_COLORS.misc)
    .attr("stroke", d => d.id === selectedId ? "#ffffff" : "#0d1117")
    .attr("stroke-width", d => d.id === selectedId ? 3 : 1.5);

  merged.selectAll("image.item-img")
    .attr("href", d => d.img ? `images/${d.img}.png` : "")
    .classed("noimg", d => !d.img)
    .on("error", function () { d3.select(this).classed("noimg", true); });

  merged.selectAll("text.item-letter")
    .text(d => (d.label || " ").trim().charAt(0).toUpperCase());

  merged.selectAll("text.variant-badge")
    .text(d => (d.variants && d.variants.length > 1) ? "×" + d.variants.length : "")
    .style("display", d => (d.variants && d.variants.length > 1) ? null : "none");

  linkLayer.selectAll("line")
    .attr("stroke", d => d.highlighted ? "#ffd166" : linkColor(d))
    .attr("stroke-opacity", d => d.highlighted ? 1 : 0.85)
    .attr("stroke-width", d => d.highlighted ? 2.2 : 1.6)
    .attr("stroke-dasharray", d => d.highlighted ? null : linkDash(d));

  simulation.nodes(nodes);
  simulation.force("link").links(bindLinks);
  simulation.alpha(1).restart();
}

function setMode() {
  const label = document.getElementById("mode-label");
  const counts = document.getElementById("counts");
  if (!selectedId) {
    label.textContent = "";
    counts.textContent = `${state.allNodes.length} items · ${state.allLinks.length} relations`;
  } else {
    const n = nodesById.get(selectedId);
    label.textContent = `focus: ${n ? n.label : ""}`;
    counts.textContent = `${visibleIds.size} shown`;
  }
}

/* ---------- relations ---------- */
// parents = "made by" ingredients (up) — query the immutable string links
function parentsOf(id) {
  return state.rawLinks.filter(l => l.source === id).map(l => l.target);
}
// children = "used in" dishes (down)
function childrenOf(id) {
  return state.rawLinks.filter(l => l.target === id).map(l => l.source);
}

function ancestorsOf(id) {
  const out = new Set();
  const stack = [...parentsOf(id)];
  while (stack.length) {
    const p = stack.pop();
    if (out.has(p)) continue;
    out.add(p);
    stack.push(...parentsOf(p));
  }
  return out;
}

function descendantsOf(id) {
  const out = new Set();
  const stack = [...childrenOf(id)];
  while (stack.length) {
    const c = stack.pop();
    if (out.has(c)) continue;
    out.add(c);
    stack.push(...childrenOf(c));
  }
  return out;
}

function isAncestorOf(nodeId, of) {
  const a = ancestorsOf(of);
  return a.has(nodeId);
}
function isDescendantOf(nodeId, of) {
  const a = descendantsOf(of);
  return a.has(nodeId);
}

/* ---------- selection ---------- */
function selectNode(id) {
  if (id === selectedId) { clearSelection(); return; }
  selectedId = id;

  const ancestors = ancestorsOf(id);
  const descendants = descendantsOf(id);

  const keep = new Set([id, ...ancestors, ...descendants]);
  visibleIds = keep;

  const nodes = state.allNodes.filter(n => keep.has(n.id));
  const links = state.allLinks.filter(l => keep.has(l.source) && keep.has(l.target));

  // highlight the direct made-by chain
  links.forEach(l => { l.highlighted = l.source === id || ancestors.has(l.source); });

  setMode();
  bind(nodes, links);   // re-layouts the remaining subgraph
  showDetail(id);
  startFollow();        // camera glides to follow the nodes as they settle
}

function clearSelection() {
  selectedId = null;
  visibleIds = new Set(state.allNodes.map(n => n.id));
  state.allLinks.forEach(l => l.highlighted = false);
  document.getElementById("detail").classList.add("hidden");
  bind(state.allNodes, state.allLinks);
  setMode();
}

/* ---------- zoom / fit ---------- */
function fitView() {
  const nodes = simulation.nodes();
  if (!nodes.length) return;
  const xExt = d3.extent(nodes, d => d.x);
  const yExt = d3.extent(nodes, d => d.y);
  if (xExt[0] === undefined) return;
  const w = window.innerWidth, h = window.innerHeight;
  const dx = xExt[1] - xExt[0] + 80, dy = yExt[1] - yExt[0] + 80;
  const scale = Math.max(0.05, Math.min(1, Math.min(w / dx, h / dy)));
  const tx = w / 2 - (xExt[0] + xExt[1]) / 2 * scale;
  const ty = h / 2 - (yExt[0] + yExt[1]) / 2 * scale;
  svg.transition().duration(600).call(
    zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

/* ---------- drag ---------- */
function dragStarted(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  follow = false;
  d.fx = d.x; d.fy = d.y;
  d3.select(this).classed("dragging", true);
}
function dragged(event, d) {
  d.fx = event.x; d.fy = event.y;
}
function dragEnded(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null; d.fy = null;   // release the node back to the simulation
  d3.select(this).classed("dragging", false);
}

/* ---------- click ---------- */
// node click via delegation
document.addEventListener("click", (e) => {
  const g = e.target.closest?.("g.node");
  if (g) {
    const id = d3.select(g).datum().id;
    selectNode(id);
  }
});

/* ---------- score tooltip (always shown on hover) ---------- */
document.addEventListener("mousemove", (e) => {
  const tip = document.getElementById("scoretip");
  const g = e.target.closest?.("g.node");
  if (!g) {
    tip.classList.add("hidden");
    return;
  }
  const d = d3.select(g).datum();
  const f = nodeFactors(d);
  const score = computeScore(d);
  const pull = d._pull || 0;
  const foods = state.allNodes.filter(n => n.is_food);
  const rank = 1 + foods.filter(n => computeScore(n) < score).length;
  const upPct = -pull * 100;   // + = up, - = down
  const sign = upPct > 0 ? "+" : "";
  const bad = hasBadEffect(d) ? ` <span class="st-bad">⚠ debuff</span>` : "";
  tip.innerHTML =
    `<div class="st-name">${esc(d.label)}${bad}</div>` +
    `<div class="st-rank">rank ${rank}/${foods.length} of foods</div>` +
    `<div class="st-row"><span>Score</span><b>${signedLog(score).toFixed(2)}</b></div>` +
    `<div class="st-row"><span>Pull</span><b>${sign}${Math.round(upPct)}% up</b></div>` +
    `<div class="st-sec">Factors</div>` +
    `<div class="st-row"><span>Lore (❤)</span><b>${f.loreAmount}</b></div>` +
    `<div class="st-row"><span>Extra lore (❣)</span><b>${f.extraLore}</b></div>` +
    `<div class="st-row"><span>Extra lore time</span><b>${f.extraTime}s</b></div>` +
    `<div class="st-row"><span>Effect level</span><b>${f.effectLevel}</b></div>` +
    `<div class="st-row"><span>Effect duration</span><b>${f.effectDuration}s</b></div>`;
  tip.classList.remove("hidden");
  tip.style.left = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 12) + "px";
  tip.style.top = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 12) + "px";
});

/* ---------- raw material cost ---------- */
// cost of the minimum craft amount: one full recipe execution (its yield).
// Cycles (flour ⇄ flour bag) are handled by rejecting cyclic paths: a node
// already on the recursion path returns null (unresolvable), which propagates
// upward so the parent recipe is skipped in favour of an acyclic one. Only the
// top-level call falls back to treating the item as an opaque material.
function rawCostMap(id, qty, visiting) {
  const n = nodesById.get(id);
  if (!n || n.raw) {
    const out = new Map();
    out.set(id, { label: n ? n.label : id, img: n && n.img, count: qty });
    return out;
  }
  if (visiting.has(id)) return null;
  visiting.add(id);

  let best = null, bestTotal = Infinity;
  for (const r of n.recipes) {
    const crafts = Math.ceil(qty / (r.count || 1));
    const cost = new Map();
    let cyclic = false;
    for (const ing of r.ingredients) {
      const sub = rawCostMap(ing.id, ing.count * crafts, visiting);
      if (sub === null) { cyclic = true; break; }
      for (const [mid, m] of sub) {
        const prev = cost.get(mid);
        if (prev) prev.count += m.count;
        else cost.set(mid, { label: m.label, img: m.img, count: m.count });
      }
    }
    if (cyclic) continue;
    const total = [...cost.values()].reduce((s, m) => s + m.count, 0);
    if (total < bestTotal) { best = { recipe: r, cost }; bestTotal = total; }
  }
  visiting.delete(id);

  if (!best) return null;
  return best.cost;
}

function computeRawCost(id) {
  const n = nodesById.get(id);
  if (!n) return null;
  let cost = rawCostMap(id, 1, new Set());
  if (cost === null) {
    cost = new Map([[id, { label: n.label, img: n.img, count: 1 }]]);
  }
  const rows = [...cost.entries()].sort((a, b) => b[1].count - a[1].count);
  const total = rows.reduce((s, r) => s + r[1].count, 0);
  return { rows, total, recipes: n.recipes };
}

/* ---------- detail panel ---------- */
function showDetail(id) {
  const n = nodesById.get(id);
  if (!n) return;
  const panel = document.getElementById("detail");
  const header = document.getElementById("detail-header");
  const body = document.getElementById("detail-body");
  panel.classList.remove("hidden");

  header.innerHTML = "";
  header.appendChild(document.createTextNode(n.label));
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.style.background = CAT_COLORS[n.category] + "33";
  tag.style.color = CAT_COLORS[n.category];
  tag.textContent = CAT_LABELS[n.category] || n.category;
  header.appendChild(tag);

  let html = "";
  const cost = n.raw ? null : computeRawCost(id);
  if (cost) {
    const craftNote = n.recipes && n.recipes.length > 1
      ? " (cheapest recipe)" : "";
    html += `<div class="sec">Raw materials<span class="dim"> · min craft${craftNote}</span></div>`;
    if (cost.rows.length) {
      html += `<div class="rawcost">` + cost.rows.map(r =>
        `<div class="rawrow">${itemIconHtml({ label: r[1].label, img: r[1].img })}` +
        `<span class="rawname">${esc(r[1].label)}</span>` +
        `<span class="rawcount">×${r[1].count}</span></div>`
      ).join("") + `</div>`;
      html += `<div class="kv dim">${cost.rows.length} distinct · ${cost.total} items</div>`;
    }
  }
  if (n.is_food) {
    html += `<div class="kv"><b>Effects:</b></div><ul>`;
    for (const e of n.effects.applied) {
      const nm = prettyEffect(e.id);
      html += `<li>${nm} Lv${e.level} · ${fmtDur(e.seconds)}${e.hidden ? ' (hidden)' : ''}</li>`;
    }
    if (n.effects.cleanse.length) html += `<li>✨ Cleanses: ${n.effects.cleanse.map(x => x.replace(/_/g, ' ')).join(', ')}</li>`;
    if (n.effects.clear_all) html += `<li>✨ Cleanses all effects</li>`;
    html += `</ul>`;
    html += `<div class="kv">Nutrition: ${n.nutrition}${n.can_always_eat ? ' (always eatable)' : ''}</div>`;
    if (n.remainder) html += `<div class="kv">Returns: ${n.remainder.replace(/_/g, ' ')}</div>`;
    html += `<div class="kv">Stack: ${n.stack}</div>`;
  } else {
    html += `<div class="kv">Intermediate ingredient${n.made_by_recipes.length ? '' : ' / raw material'}.</div>`;
  }
  if (n.lore && n.lore.length) {
    html += `<div class="sec">Lore</div><div class="kv">${n.lore.map(x => x.replace(/§[0-9a-fk-or]/g, '')).join(' · ')}</div>`;
  }
  if (n.variants && n.variants.length > 1) {
    html += `<div class="sec">Variants (interchangeable)</div><ul>`;
    for (const v of n.variants) html += `<li>${v}</li>`;
    html += `</ul>`;
  }
  if (n.recipes && n.recipes.length) {
    html += `<div class="sec">Recipe</div>`;
    for (const r of n.recipes) html += recipeHtml(r, n);
  } else {
    html += `<div class="sec">Made by</div><ul>`;
    html += (n.made_by_recipes.length ? n.made_by_recipes.map(r => `<li>${r}</li>`).join("") : `<li>raw / obtained directly</li>`);
    html += `</ul><div class="sec">Recipe</div>`;
    html += `<div class="kv">${(n.result_ids || [n.base]).join(", ")}</div>`;
  }
  body.innerHTML = html;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function itemIconHtml(entry) {
  if (entry.img) return `<img src="images/${esc(entry.img)}.png" alt="">`;
  return `<span class="noimg">${esc((entry.label || " ").trim().charAt(0).toUpperCase())}</span>`;
}

function slotHtml(entry) {
  const opts = entry.any_of;
  let icons;
  let title = entry.label || "";
  if (opts && opts.length) {
    icons = `<span class="anyicons">${opts.slice(0, 4).map(itemIconHtml).join("")}</span>`;
    title = "any of: " + opts.map(o => o.label).join(", ");
  } else {
    icons = itemIconHtml(entry);
  }
  const count = entry.count > 1 ? `<span class="count">×${entry.count}</span>` : "";
  return `<div class="ing-slot" title="${esc(title)}">${icons}${count}<span class="slot-label">${esc(entry.label || "")}</span></div>`;
}

function recipeHtml(r, node) {
  const head = TYPE_LABELS[r.type] || r.type;
  const extra = [];
  if (r.time) extra.push(`${r.time}t`);
  if (r.xp != null) extra.push(`${r.xp} xp`);
  const meta = extra.length ? ` <span class="dim">· ${extra.join(" · ")}</span>` : "";
  const slots = (r.ingredients || []).map(slotHtml).join("");
  const result = slotHtml({
    id: node.id, label: node.label, count: r.count, img: node.img,
  });
  return `<div class="recipe">
    <div class="recipe-head">${esc(head)}<span class="dim">×${r.count}</span>${meta}</div>
    <div class="recipe-grid">${slots}<span class="recipe-arrow">→</span>${result}</div>
  </div>`;
}

function prettyEffect(id) {
  const map = {
    regeneration: "❤ Regeneration", absorption: "♥ Absorption",
    speed: "🏃 Speed", haste: "⛏ Haste", night_vision: "👁 Night Vision",
    health_boost: "❣ Max Health +", water_breathing: "🐟 Gills",
    fire_resistance: "🔥 Fire Resist", resistance: "🛡 Resistance",
    strength: "🗡 Strength", weakness: "🥀 Weakness", poison: "💀 Poison",
    invisibility: "👻 Invisibility", levitation: "🕴 Levitation",
    conduit_power: "🐟 Conduit Power", saturation: "🍔 Saturation",
  };
  return map[id] || id.replace(/_/g, " ");
}
function fmtDur(secs) {
  if (secs >= 60) {
    const m = Math.floor(secs / 60), s = Math.round(secs % 60);
    return s ? `${m}:${String(s).padStart(2, "0")}` : `${m}:00`;
  }
  return `${Math.round(secs)}s`;
}

/* ---------- legend ---------- */
function renderLegend() {
  const el = document.getElementById("legend");
  el.innerHTML = "";
  for (const cat of ["raw", "stock", "soup", "preserve", "drink", "meat_fish",
                     "produce", "crafted", "golden", "potion", "ingredient"]) {
    const div = document.createElement("div");
    const sw = document.createElement("span");
    sw.className = "sw";
    sw.style.background = CAT_COLORS[cat];
    div.appendChild(sw);
    div.appendChild(document.createTextNode(CAT_LABELS[cat]));
    el.appendChild(div);
  }
  const hr = document.createElement("div");
  hr.className = "legend-divider";
  hr.textContent = "made by";
  el.appendChild(hr);
  const typeKeys = ["shapeless", "shaped", "smelting", "smoking", "campfire"];
  for (const t of typeKeys) {
    const div = document.createElement("div");
    const sw = document.createElement("span");
    sw.className = "sw line";
    sw.style.background = TYPE_COLORS[t];
    div.appendChild(sw);
    div.appendChild(document.createTextNode(TYPE_LABELS[t]));
    el.appendChild(div);
  }
  const multi = document.createElement("div");
  const msw = document.createElement("span");
  msw.className = "sw line dashed";
  multi.appendChild(msw);
  multi.appendChild(document.createTextNode("multiple methods"));
  el.appendChild(multi);
}

/* ---------- toolbar ---------- */
document.getElementById("btn-reset").addEventListener("click", () => {
  clearSelection();
  fitView();
});
document.getElementById("btn-fit").addEventListener("click", fitView);
document.getElementById("btn-tune").addEventListener("click", () => {
  document.getElementById("tune").classList.toggle("hidden");
});
document.getElementById("btn-deselect").addEventListener("click", clearSelection);
document.getElementById("btn-focus-made-by").addEventListener("click", () => {
  if (selectedId) selectNode(selectedId);
});
document.getElementById("btn-focus-used-in").addEventListener("click", () => {
  if (selectedId) selectNode(selectedId);
});

/* ---------- force tuning sliders ---------- */
function rehearSim() {
  simulation.alpha(0.8).restart();
}
function wireTune() {
  const set = (id, fmt, apply) => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => {
      const v = +el.value;
      document.getElementById("v-" + id.slice(2)).textContent = fmt(v);
      apply(v);
      rehearSim();
    });
  };

  // logarithmic repulsion: slider 0..100 maps to 30..10000
  const CHARGE_MIN = 30, CHARGE_MAX = 10000;
  const logCharge = p => Math.round(CHARGE_MIN * Math.pow(CHARGE_MAX / CHARGE_MIN, p / 100));
  set("s-charge", v => logCharge(+v), v => simulation.force("charge").strength(-logCharge(v)));

  set("s-links", v => v.toFixed(2), v => simulation.force("link").strength(v));
  set("s-linkd", v => v, v => simulation.force("link").distance(v));
  set("s-pad", v => v, v => {
    collidePadding = v;
    simulation.force("collide").radius(d => nodeRadius(d) + collidePadding);
  });
  set("s-pull", v => v.toFixed(2), v => { scoreStrength = v; });
  const weightSliders = {
    "s-f-lore": "loreAmount",
    "s-f-extra": "extraLore",
    "s-f-time": "extraTime",
    "s-f-level": "effectLevel",
    "s-f-dur": "effectDuration",
  };
  for (const id in weightSliders) {
    set(id, v => v.toFixed(1), v => {
      SCORE_WEIGHTS[weightSliders[id]] = v;
      computePulls();
    });
  }
}
wireTune();

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") clearSelection();
});

window.addEventListener("resize", () => { /* simulation recenters */ });

load();
