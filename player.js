const byId = id => document.getElementById(id);
const canvas = byId("frame");
const ctx = canvas.getContext("2d");
const boardSize = 64;
const groupTitles = { forge: "Game Forge", arc: "ARC-AGI-3" };
const actionButtons = [...document.querySelectorAll("[data-action]")];
const tabs = [...document.querySelectorAll("[data-group]")];
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const keyboard = new Map(Object.entries({
  arrowup: "ACTION1", w: "ACTION1",
  arrowdown: "ACTION2", s: "ACTION2",
  arrowleft: "ACTION3", a: "ACTION3",
  arrowright: "ACTION4", d: "ACTION4",
  " ": "ACTION5", z: "ACTION7",
}));

let requestId = 0;
let pending;
let palette;
let catalog = { forge: [], arc: [] };
let group = "forge";
let selected;
let playing;
let observation;
let transform;
let busy = false;
let solver;
let plan = [];
let playback = false;
let stopPlayback = false;

function request(payload) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending = { id, resolve, reject };
    worker.postMessage({ id, ...payload });
  });
}

worker.onmessage = ({ data }) => {
  if (pending?.id !== data.id) return;
  const { resolve, reject } = pending;
  pending = null;
  if (data.error) reject(new Error(data.error));
  else resolve(data.result);
};

worker.onerror = event => {
  pending?.reject(new Error(event.message || "Ошибка браузерного движка"));
  pending = null;
};

function setStatus(text, kind = "") {
  byId("status").textContent = text;
  byId("status").dataset.kind = kind;
}

function draw(frame) {
  const height = frame.length;
  const width = frame[0].length;
  const scale = Math.max(1, Math.floor(boardSize / Math.max(width, height)));
  const x = Math.max(0, Math.floor((boardSize - width * scale) / 2));
  const y = Math.max(0, Math.floor((boardSize - height * scale) / 2));
  transform = { x, y, scale, width, height };
  ctx.fillStyle = palette[0];
  ctx.fillRect(0, 0, boardSize, boardSize);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      ctx.fillStyle = palette[frame[row][col]] ?? palette[0];
      ctx.fillRect(x + col * scale, y + row * scale, scale, scale);
    }
  }
}

function controls() {
  const actions = observation?.actions ?? [];
  byId("start").disabled = busy || !selected;
  byId("reset").disabled = busy || !playing;
  byId("next").hidden = !(observation?.status === "won" && playing.level < playing.game.levels);
  byId("next").disabled = busy;
  byId("solve").disabled = busy || !playing;
  byId("solve").textContent = solver ? "Отменить поиск" : "Найти решение";
  byId("replay").disabled = !playback && (busy || !plan.length);
  byId("replay-label").textContent = playback ? "Остановить" : "Воспроизвести";
  for (const button of actionButtons) {
    button.disabled = busy || !actions.includes(button.dataset.action);
  }
  canvas.classList.toggle("clickable", !busy && actions.includes("ACTION6"));
  for (const input of document.querySelectorAll("#options input")) input.disabled = busy;
  for (const tab of tabs) tab.disabled = busy;
  for (const button of byId("games").querySelectorAll("button")) button.disabled = busy;
}

function renderCatalog() {
  const filter = byId("query").value.trim().toLowerCase();
  const list = byId("games");
  list.replaceChildren();
  for (const game of catalog[group]) {
    if (!`${game.title} ${game.alias}`.toLowerCase().includes(filter)) continue;
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = busy;
    button.setAttribute("aria-current", String(game === selected));
    const name = document.createElement("span");
    name.textContent = game.title;
    const levels = document.createElement("small");
    levels.textContent = game.levels;
    button.append(name, levels);
    button.addEventListener("click", () => choose(game, 1, 0));
    li.append(button);
    list.append(li);
  }
  if (!list.children.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Игры не найдены";
    list.append(empty);
  }
}

function heading(game, level, seed) {
  selected = game;
  byId("collection").textContent = groupTitles[group];
  byId("title").textContent = game.title;
  byId("level").max = game.levels;
  byId("level").value = level;
  byId("seed-field").hidden = !game.seeded;
  byId("seed").value = game.seeded ? seed : 0;
  for (const tab of tabs) tab.setAttribute("aria-pressed", String(tab.dataset.group === group));
  renderCatalog();
}

function updateUrl() {
  const url = new URL(location.href);
  url.search = new URLSearchParams({
    group, game: playing.game.alias, level: playing.level, seed: playing.seed,
  });
  history.replaceState(null, "", url);
}

async function show(result) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reducedMotion) {
    for (const frame of result.transitionFrames ?? []) {
      draw(frame);
      await new Promise(resolve => setTimeout(resolve, 65));
    }
  }
  observation = result;
  draw(result.frame);
  const progress = `Уровень ${playing.level}/${playing.game.levels} · Ход ${result.step}`;
  const suffix = {
    won: playing.level === playing.game.levels ? " · Игра пройдена" : " · Уровень пройден",
    lost: " · Уровень не пройден",
  };
  setStatus(progress + (suffix[result.status] ?? ""), result.status);
}

async function choose(game, level, seed) {
  if (busy || !game) return;
  endSearch();
  showPlan([]);
  byId("solution-status").textContent = "";
  heading(game, level, seed);
  busy = true;
  observation = null;
  playing = null;
  ctx.clearRect(0, 0, boardSize, boardSize);
  controls();
  setStatus("Загрузка уровня…");
  try {
    const result = await request({ op: "start", group, game, level, seed });
    playing = { game, level, seed };
    updateUrl();
    await show(result);
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    busy = false;
    controls();
  }
}

function showPlan(actions) {
  plan = actions;
  const list = byId("plan");
  const symbols = { ACTION1: "↑", ACTION2: "↓", ACTION3: "←", ACTION4: "→", ACTION5: "Space", ACTION7: "Undo" };
  list.replaceChildren(...actions.map(action => {
    const item = document.createElement("li");
    item.textContent = action.id === "ACTION6" ? `(${action.x},${action.y})` : symbols[action.id] ?? action.id;
    return item;
  }));
  list.hidden = actions.length === 0;
}

function endSearch() {
  solver?.terminate();
  solver = null;
}

function solve() {
  if (busy || !playing) return;
  const status = byId("solution-status");
  if (solver) {
    endSearch();
    status.textContent = "Поиск отменён";
    controls();
    return;
  }
  showPlan([]);
  status.textContent = "Поиск решения…";
  const search = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  solver = search;
  controls();
  function finish({ result, error }) {
    if (solver !== search) return;
    endSearch();
    if (error) status.textContent = error;
    else if (result.solved) {
      showPlan(result.plan);
      status.textContent = `Ходов в плане: ${result.plan.length}`;
    } else {
      status.textContent = "Решение не найдено за отведённый поиск";
      status.title = result.reason ?? "";
    }
    controls();
  }
  status.removeAttribute("title");
  search.onmessage = ({ data }) => finish(data);
  search.onerror = event => finish({ error: event.message || "Ошибка планировщика" });
  search.postMessage({ id: 1, op: "solve", group, ...playing });
}

async function replay() {
  if (playback) {
    stopPlayback = true;
    return;
  }
  if (busy || !playing || !plan.length) return;
  busy = true;
  playback = true;
  stopPlayback = false;
  controls();
  const status = byId("solution-status");
  const items = byId("plan").children;
  let executed = 0;
  try {
    await show(await request({ op: "reset" }));
    for (const [index, action] of plan.entries()) {
      if (stopPlayback) break;
      items[index - 1]?.removeAttribute("aria-current");
      items[index].setAttribute("aria-current", "step");
      status.textContent = `Ход ${index + 1}/${plan.length}`;
      await show(await request({ op: "step", action }));
      executed++;
      if (!stopPlayback && executed < plan.length) {
        await new Promise(resolve => setTimeout(resolve, 170));
      }
    }
    if (stopPlayback) status.textContent = `Остановлено на ходе ${executed}/${plan.length}`;
    else if (observation.status === "won") status.textContent = `Пройдено за ${executed} ходов`;
    else throw new Error("План не завершил уровень");
  } catch (error) {
    status.textContent = error.message;
  } finally {
    byId("plan").querySelector('[aria-current="step"]')?.removeAttribute("aria-current");
    playback = false;
    busy = false;
    controls();
  }
}

async function play(op, action) {
  if (busy || !playing || (action && !observation?.actions.includes(action.id))) return;
  busy = true;
  controls();
  try {
    await show(await request({ op, action }));
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    busy = false;
    controls();
  }
}

byId("query").addEventListener("input", renderCatalog);
byId("options").addEventListener("submit", event => {
  event.preventDefault();
  choose(selected, byId("level").valueAsNumber, byId("seed").valueAsNumber);
});
byId("next").addEventListener("click", () => choose(playing.game, playing.level + 1, playing.seed));
byId("reset").addEventListener("click", () => play("reset"));
byId("solve").addEventListener("click", solve);
byId("replay").addEventListener("click", replay);
for (const button of actionButtons) {
  button.addEventListener("click", () => play("step", { id: button.dataset.action }));
}
for (const tab of tabs) {
  tab.addEventListener("click", async () => {
    if (group === tab.dataset.group || busy) return;
    if (tab.dataset.group === "arc" && !catalog.arc.length) {
      busy = true;
      controls();
      setStatus("Загрузка ARC-игр…");
      try {
        catalog.arc = await request({ op: "catalog" });
      } catch (error) {
        setStatus(error.message, "error");
        return;
      } finally {
        busy = false;
        controls();
      }
    }
    group = tab.dataset.group;
    byId("query").value = "";
    choose(catalog[group][0], 1, 0);
  });
}
document.addEventListener("keydown", event => {
  if (event.target.closest("input,textarea,select") || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === " " && event.target.closest("button")) return;
  const id = keyboard.get(event.key.toLowerCase());
  if (!id || !observation?.actions.includes(id)) return;
  event.preventDefault();
  play("step", { id });
});
canvas.addEventListener("click", event => {
  if (!transform || !observation?.actions.includes("ACTION6")) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((event.clientX - rect.left) * boardSize / rect.width - transform.x) / transform.scale);
  const y = Math.floor(((event.clientY - rect.top) * boardSize / rect.height - transform.y) / transform.scale);
  if (x >= 0 && y >= 0 && x < transform.width && y < transform.height) {
    play("step", { id: "ACTION6", x, y });
  }
});

async function init() {
  busy = true;
  controls();
  try {
    const response = await fetch(new URL("./catalog.json", import.meta.url));
    if (!response.ok) throw new Error("Каталог игр недоступен");
    const config = await response.json();
    palette = config.palette;
    catalog.forge = config.forge;
    const params = new URLSearchParams(location.search);
    if (params.get("group") === "arc") {
      group = "arc";
      catalog.arc = await request({ op: "catalog" });
    }
    const game = catalog[group].find(item => item.alias === params.get("game")) ?? catalog[group][0];
    const bounded = (raw, minimum, maximum) => {
      const value = Number(raw);
      return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : minimum;
    };
    const level = bounded(params.get("level"), 1, game.levels);
    const seed = game.seeded ? bounded(params.get("seed"), 0, Number.MAX_SAFE_INTEGER) : 0;
    busy = false;
    await choose(game, level, seed);
  } catch (error) {
    setStatus(error.message, "error");
    busy = false;
    controls();
  }
}

init();
