import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const out = {
    rows: 4200,
    seed: 1337,
    mode: "mixed",
    out: "data/test.csv",
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rows") {
      out.rows = Number(argv[++i]);
      continue;
    }
    if (arg === "--seed") {
      out.seed = Number(argv[++i]);
      continue;
    }
    if (arg === "--mode") {
      out.mode = String(argv[++i]);
      continue;
    }
    if (arg === "--out") {
      out.out = String(argv[++i]);
      continue;
    }
  }

  if (!Number.isFinite(out.rows) || out.rows < 3000) out.rows = 4200;
  if (!Number.isFinite(out.seed)) out.seed = 1337;
  if (!["mixed", "trending", "volatile", "mean_reverting"].includes(out.mode)) {
    out.mode = "mixed";
  }
  return out;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randBetween(rng, min, max) {
  return min + (max - min) * rng();
}

function pickWeighted(rng, entries) {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [kind, weight] of entries) {
    if (roll < weight) return kind;
    roll -= weight;
  }
  return entries[entries.length - 1][0];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function modePreset(mode) {
  if (mode === "trending") {
    return {
      moveMix: [
        ["normal", 62],
        ["medium", 28],
        ["spike", 10],
      ],
      segments: [
        { name: "trend_up", weight: 0.38, driftBps: 1.3, volBps: 3.8, flatChance: 0.05 },
        { name: "trend_down", weight: 0.32, driftBps: -1.1, volBps: 4.1, flatChance: 0.05 },
        { name: "sideways_low", weight: 0.12, driftBps: 0.1, volBps: 1.6, flatChance: 0.42 },
        { name: "trend_up_flat", weight: 0.18, driftBps: 0.85, volBps: 2.4, flatChance: 0.22 },
      ],
    };
  }
  if (mode === "volatile") {
    return {
      moveMix: [
        ["normal", 42],
        ["medium", 38],
        ["spike", 20],
      ],
      segments: [
        { name: "volatile_a", weight: 0.33, driftBps: 0.3, volBps: 11.5, flatChance: 0.01 },
        { name: "volatile_b", weight: 0.34, driftBps: -0.25, volBps: 13.5, flatChance: 0.01 },
        { name: "volatile_c", weight: 0.33, driftBps: 0.1, volBps: 15.0, flatChance: 0.01 },
      ],
    };
  }
  if (mode === "mean_reverting") {
    return {
      moveMix: [
        ["normal", 78],
        ["medium", 18],
        ["spike", 4],
      ],
      segments: [
        { name: "sideways_low", weight: 0.28, driftBps: 0.0, volBps: 1.2, flatChance: 0.62 },
        { name: "mean_revert_down", weight: 0.24, driftBps: -0.25, volBps: 2.0, flatChance: 0.32 },
        { name: "mean_revert_up", weight: 0.24, driftBps: 0.25, volBps: 2.0, flatChance: 0.32 },
        { name: "flat_anchor", weight: 0.24, driftBps: 0.0, volBps: 0.9, flatChance: 0.72 },
      ],
    };
  }
  return {
    moveMix: [
      ["normal", 70],
      ["medium", 25],
      ["spike", 5],
    ],
    segments: [
      { name: "trend_up", weight: 0.22, driftBps: 0.9, volBps: 3.5, flatChance: 0.08 },
      { name: "sideways_low", weight: 0.18, driftBps: 0.0, volBps: 1.4, flatChance: 0.5 },
      { name: "trend_down", weight: 0.20, driftBps: -0.8, volBps: 4.2, flatChance: 0.07 },
      { name: "volatile", weight: 0.22, driftBps: 0.15, volBps: 10.5, flatChance: 0.02 },
      { name: "trend_up_flat", weight: 0.18, driftBps: 0.55, volBps: 2.2, flatChance: 0.28 },
    ],
  };
}

function buildRegimes(rows, mode) {
  const preset = modePreset(mode);
  const segments = preset.segments;

  const total = segments.reduce((sum, s) => sum + s.weight, 0);
  const planned = segments.map((segment) => ({
    ...segment,
    rows: Math.max(1, Math.round((segment.weight / total) * rows)),
  }));

  let diff = rows - planned.reduce((sum, s) => sum + s.rows, 0);
  let i = 0;
  while (diff !== 0) {
    planned[i % planned.length].rows += diff > 0 ? 1 : -1;
    diff += diff > 0 ? -1 : 1;
    i += 1;
  }

  const output = [];
  for (const segment of planned) {
    output.push(segment);
  }
  return { regimes: output, moveMix: preset.moveMix };
}

function generate(rows, seed, mode) {
  const rng = mulberry32(seed);
  const { regimes, moveMix } = buildRegimes(rows, mode);
  const lines = ["mid"];
  let price = 50_000;
  let anchor = price;
  let regimeIndex = 0;
  let regimeTick = 0;
  let current = regimes[0];

  for (let row = 0; row < rows; row++) {
    if (regimeTick >= current.rows) {
      regimeIndex = Math.min(regimes.length - 1, regimeIndex + 1);
      current = regimes[regimeIndex];
      regimeTick = 0;
      anchor = price;
    }

    const moveKind = pickWeighted(rng, moveMix);

    let deltaBps = 0;
    if (moveKind === "normal") {
      deltaBps = randBetween(rng, -current.volBps, current.volBps);
    } else if (moveKind === "medium") {
      deltaBps = randBetween(rng, -current.volBps * 3.5, current.volBps * 3.5);
    } else {
      const spikeSize = randBetween(rng, 25, 110);
      deltaBps = (rng() < 0.5 ? -1 : 1) * spikeSize;
    }

    const drift = current.driftBps;
    const meanRevert = current.name.includes("sideways") || current.name.includes("flat") || current.name.includes("mean_revert")
      ? (anchor - price) / price * (mode === "mean_reverting" ? 18 : 12)
      : 0;
    const shock = (deltaBps + drift + meanRevert) / 10_000;

    const flatStretch = current.flatChance > 0 && rng() < current.flatChance;
    if (!flatStretch) {
      price = Math.max(
        1_000,
        price * (1 + shock + randBetween(rng, -0.0012, 0.0012))
      );
    } else {
      price = Math.max(
        1_000,
        price * (1 + randBetween(rng, -0.00025, 0.00025))
      );
    }

    if (moveKind === "spike") {
      anchor = price;
    }

    lines.push(String(round2(price)));
    regimeTick += 1;
  }

  return lines.join("\n") + "\n";
}

function main() {
  const { rows, seed, mode, out } = parseArgs(process.argv);
  const content = generate(rows, seed, mode);
  const outPath = resolve(process.cwd(), out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content, "utf8");
  console.log(
    JSON.stringify({
      outPath,
      rows,
      seed,
      mode,
    })
  );
}

main();
