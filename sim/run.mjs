/**
 * Play many games of a scenario with the bot in every seat and report how they
 * went: how often the table wins and how, how often the boss comes, how long a
 * game lasts, who falls and who goes mad.
 *
 *   npm run sim                       200 games at each table size, 1-4
 *   node sim/run.mjs --games 500 --players 2 --seed 7
 *
 * Every game is seeded, so any one of them can be replayed exactly.
 */

import { readFile } from 'node:fs/promises';
import {
  buildScenario,
  createGame,
  reduce,
  monsterCount,
  roomsFromCsv,
  entrancesFromCsv,
  encountersFromCsv,
  itemsFromCsv,
  eventsFromCsv,
  investigatorsFromCsv,
  monstersFromCsv,
} from '../engine.js';
import { chooseAction } from './bot.js';

const MAX_ROUNDS = 150;
const MAX_ACTIONS = 20000;

export async function loadContext(scenarioDir = 'nameless-presence') {
  const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
  const raw = JSON.parse(await read(`scenarios/${scenarioDir}/scenario.json`));
  return {
    scenario: buildScenario(JSON.parse(await read('rules/core.json')), raw),
    rooms: roomsFromCsv(await read('decks/rooms.csv')),
    entrances: entrancesFromCsv(await read('decks/entrance.csv')),
    encounterCards: encountersFromCsv(await read('decks/encounters.csv')),
    items: itemsFromCsv(await read('decks/items.csv')),
    events: eventsFromCsv(await read('decks/events.csv')),
    investigators: investigatorsFromCsv(await read('decks/investigators.csv')),
    monsterCards: raw.monsterDeck
      ? monstersFromCsv(await read(`scenarios/${scenarioDir}/${raw.monsterDeck}`))
      : null,
  };
}

function rng(seed) {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

/** Play one game to the end and say what happened in it. */
export function playOne(ctx, { seed, players, keepState = false }) {
  const rand = rng(seed + 99991);
  const ids = Object.keys(ctx.investigators);
  const seats = [...ids].sort(() => rand() - 0.5).slice(0, players);
  let state = createGame(ctx, { seed, playerCount: players, investigatorIds: seats });

  const record = {
    seed,
    players,
    seats,
    result: 'stalled',
    rounds: 0,
    summonedRound: null,
    peakMonsters: 0,
    fallen: [],
    mad: [],
    actions: {},
    error: null,
  };

  for (let n = 0; n < MAX_ACTIONS && !state.over && state.round <= MAX_ROUNDS; n++) {
    const action = chooseAction(state, ctx, rand);
    const before = state;
    try {
      state = reduce(state, action, ctx);
    } catch (err) {
      record.error = `${action.type}: ${err.message}`;
      break;
    }
    record.actions[action.type] = (record.actions[action.type] ?? 0) + 1;

    // Someone left the table: a new sheet in their seat, or the seat is out.
    for (const [i, was] of before.players.entries()) {
      const now = state.players[i];
      if (was.out || (now.investigatorId === was.investigatorId && !now.out)) continue;
      const kept = state.monsters.some(
        (m) => m.kind === 'mad' && m.fromInvestigator === was.investigatorId,
      );
      (kept ? record.mad : record.fallen).push(was.investigatorId);
    }
    if (state.boss && record.summonedRound === null) record.summonedRound = state.round;
    record.peakMonsters = Math.max(record.peakMonsters, monsterCount(state));
  }

  record.rounds = state.round;
  record.roomsOpen = Object.keys(state.rooms).length;
  record.sealClues = state.sealClues ?? 0;
  if (keepState) record.state = state;
  if (state.over?.result === 'lost') record.result = 'lost';
  else if (state.over?.reason?.includes('sealed')) record.result = 'sealed';
  else if (state.over?.result === 'won') record.result = 'boss';
  else if (record.error) record.result = 'error';
  return record;
}

export function simulate(ctx, { games, players, seed = 1 }) {
  const out = [];
  for (let g = 0; g < games; g++) out.push(playOne(ctx, { seed: seed + g * 7919, players }));
  return out;
}

const pct = (n, d) => (d === 0 ? '  -' : `${Math.round((100 * n) / d)}%`.padStart(4));
const median = (list) => {
  const v = list.filter((x) => x !== null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : '-';
};
const mean = (list) => (list.length ? (list.reduce((a, b) => a + b, 0) / list.length).toFixed(1) : '-');

export function report(byPlayers, ctx) {
  const lines = [];
  lines.push(
    'players  games   sealed  boss-kill  lost  stalled   boss-came  rounds(med)  summon-round(med)  rooms  peak-monsters  fallen/game  mad/game',
  );
  const sheets = {};
  for (const [players, records] of Object.entries(byPlayers)) {
    const n = records.length;
    const count = (r) => records.filter((x) => x.result === r).length;
    lines.push(
      [
        String(players).padStart(7),
        String(n).padStart(6),
        pct(count('sealed'), n).padStart(8),
        pct(count('boss'), n).padStart(10),
        pct(count('lost'), n).padStart(5),
        pct(count('stalled') + count('error'), n).padStart(8),
        pct(records.filter((r) => r.summonedRound !== null).length, n).padStart(11),
        String(median(records.map((r) => r.rounds))).padStart(12),
        String(median(records.map((r) => r.summonedRound))).padStart(18),
        String(median(records.map((r) => r.roomsOpen))).padStart(6),
        String(median(records.map((r) => r.peakMonsters))).padStart(14),
        mean(records.map((r) => r.fallen.length)).padStart(12),
        mean(records.map((r) => r.mad.length)).padStart(9),
      ].join(' '),
    );
    for (const r of records) {
      for (const id of r.seats) {
        sheets[id] ??= { seated: 0, fallen: 0, mad: 0 };
        sheets[id].seated += 1;
      }
      for (const id of r.fallen) if (sheets[id]) sheets[id].fallen += 1;
      for (const id of r.mad) if (sheets[id]) sheets[id].mad += 1;
    }
  }

  lines.push('', 'investigator          started  fell  went-mad  survived');
  for (const [id, s] of Object.entries(sheets).sort((a, b) => a[0] - b[0])) {
    const name = ctx.investigators[id].name.padEnd(20);
    const lostIt = s.fallen + s.mad;
    lines.push(
      `${name} ${String(s.seated).padStart(8)} ${pct(s.fallen, s.seated).padStart(5)} ${pct(s.mad, s.seated).padStart(9)} ${pct(Math.max(0, s.seated - lostIt), s.seated).padStart(9)}`,
    );
  }

  const errors = Object.values(byPlayers)
    .flat()
    .filter((r) => r.error);
  if (errors.length) {
    lines.push('', `errors (${errors.length}):`);
    for (const r of errors.slice(0, 5)) lines.push(`  seed ${r.seed}, ${r.players}p: ${r.error}`);
  }
  return lines.join('\n');
}

// Run from the command line.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const games = Number(arg('games', 200));
  const seed = Number(arg('seed', 1));
  const range = String(arg('players', '1-4'));
  const [lo, hi = lo] = range.split('-').map(Number);

  const ctx = await loadContext(arg('scenario', 'nameless-presence'));
  const byPlayers = {};
  const started = Date.now();
  for (let p = lo; p <= hi; p++) byPlayers[p] = simulate(ctx, { games, players: p, seed });
  console.log(`${ctx.scenario.name} — ${games} games at each table size, seed ${seed}\n`);
  console.log(report(byPlayers, ctx));
  console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
