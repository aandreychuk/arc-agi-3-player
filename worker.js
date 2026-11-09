import { instantiate } from "./runtime.js";

const engines = new Map();
let session;
let requestId = 0;

async function engine(group) {
  if (!engines.has(group)) {
    const response = await fetch(new URL(`./${group}.wasm`, import.meta.url));
    if (!response.ok) throw new Error(`Ошибка загрузки движка: ${response.status}`);
    engines.set(group, await instantiate(await response.arrayBuffer()));
  }
  return engines.get(group);
}

function forge(op, payload = {}) {
  return session.run({ schema: "forge.env.v1", request_id: ++requestId, op, payload });
}

function forgeObservation(raw) {
  const { game, level } = session;
  return {
    frame: raw.frame.pixels,
    transitionFrames: (raw.transition_frames ?? []).map(frame => frame.pixels),
    status: raw.status.kind,
    step: raw.step,
    actions: raw.status.kind === "running" ? (game.actions_by_level[level] ?? game.actions) : [],
  };
}

async function handle({ op, group, game, level, seed, action }) {
  if (op === "catalog") return (await engine("arc"))({ op });
  if (op === "solve") {
    await handle({ op: "start", group, game, level, seed });
    if (group === "forge") return forge(game.solver, game.solve_limits);
    if (game.alias === "wa30") {
      const response = await fetch(new URL("./wa30-solutions.json", import.meta.url));
      if (response.ok) {
        const { levels } = await response.json();
        const plan = levels[level];
        if (plan && session.run({ op: "verify_plan", plan })) {
          return { solved: true, plan: plan.map(id => ({ id })), source: "precomputed" };
        }
      }
    }
    const result = session.run({ op });
    return { ...result, plan: result.plan.map(token => {
      const click = /^ACTION6\((-?\d+),(-?\d+)\)$/.exec(token);
      return click ? { id: "ACTION6", x: Number(click[1]), y: Number(click[2]) } : { id: token };
    }) };
  }
  if (op === "start") {
    const run = await engine(group);
    session = { run, group, game, level };
    if (group === "arc") return run({ op, alias: game.alias, level, seed });
    run({ select: game.alias });
    forge("new_family", { family_seed: seed });
    forge("generate", {
      level_index: level, level_seed: seed,
      difficulty: ["intro", "core", "advanced", "challenge"][Math.min(level, 4) - 1],
    });
    return forgeObservation(forge("reset"));
  }
  if (!session) throw new Error("Игра ещё не запущена");
  if (session.group === "arc") {
    const token = action?.id === "ACTION6" ? `ACTION6(${action.x},${action.y})` : action?.id;
    return session.run({ op, action: token });
  }
  return forgeObservation(forge(op, action ? { action } : {}));
}

self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ id: data.id, result: await handle(data) });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
