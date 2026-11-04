/**
 * A sensible player, for testing.
 *
 * It is not clever and does not try to be: it plays the way a careful table
 * plays a first game, so that a few hundred games of it say something about
 * the rules rather than about how badly random clicking plays. Every decision
 * goes through the engine's own "why not" functions, so the bot can never do
 * something the rules forbid — it only chooses among what is allowed.
 *
 * In order of priority, on its turn it will:
 *   1. answer any question on the table, and lay a drawn room down
 *   2. spend clues on the seal when it can
 *   3. when engaged, attack if it is healthy enough and flee if it is not
 *   4. use a weapon on a monster in reach, a healing item when hurt, a clue item
 *   5. heal in the Foyer or the Library when low, use its trait when worth it
 *   6. investigate the card under its feet
 *   7. attack a monster beside it when the board is filling up
 *   8. walk toward whatever matters most right now — the Rift with clues in
 *      hand, a face-down card, a door into the dark, a place to heal
 *   9. end the turn
 *
 * `rand` is the bot's own random source, for breaking ties. It never touches
 * the game's RNG, so a game is still reproduced exactly by its seed and its
 * list of actions.
 */

import {
  currentPlayer,
  legalDestinations,
  pendingOrientations,
  investigateProblem,
  useItemProblem,
  sealProblem,
  combatProblem,
  engagedWith,
  roomSpecialHere,
  roomSpecialProblem,
  activeTrait,
  traitProblem,
  monsterCount,
  stepProblem,
  slotOf,
  roomKey,
} from '../engine.js';

const STEPS = [
  { dr: -1, dc: 0 },
  { dr: 1, dc: 0 },
  { dr: 0, dc: -1 },
  { dr: 0, dc: 1 },
];

const key = (pos) => `${pos.gr},${pos.gc}`;
const posOf = (k) => {
  const [gr, gc] = k.split(',').map(Number);
  return { gr, gc };
};
const gap = (a, b) => Math.abs(a.gr - b.gr) + Math.abs(a.gc - b.gc);
const placed = (state, pos) => Boolean(state.rooms[roomKey(slotOf(pos).R, slotOf(pos).C)]);

function pick(list, rand) {
  return list[Math.floor(rand() * list.length)];
}

/** Low on a pool: a third of the sheet or less. */
function low(player, pool) {
  const max = player[`${pool}Max`];
  return typeof player[pool] === 'number' && player[pool] <= Math.max(1, Math.floor(max / 3));
}

export function chooseAction(state, ctx, rand = Math.random) {
  if (state.choice) return answerChoice(state, ctx);
  if (state.pending) return { type: 'PLACE_ROOM', orient: pendingOrientations(state, ctx)[0] };

  const me = currentPlayer(state);
  const items = me.items ?? [];
  const card = (id) => ctx.items?.[id];

  // 2. The seal wins the game outright.
  if (!sealProblem(state, ctx)) return { type: 'SEAL' };

  // 3. Engaged: fight while healthy, run when not.
  const holding = engagedWith(state, me);
  if (holding.length > 0) {
    const weapon = items.find((id) => (card(id)?.effect.hit || card(id)?.effect.banish) && !useItemProblem(state, ctx, id));
    if (weapon) return { type: 'USE_ITEM', itemId: weapon };
    const fragile = low(me, 'health') || low(me, 'sanity');
    if (fragile && !combatProblem(state, 'flee')) return { type: 'FLEE' };
    if (!combatProblem(state, 'attack')) return { type: 'ATTACK' };
    if (!combatProblem(state, 'flee')) return { type: 'FLEE' };
    return { type: 'END_TURN' };
  }

  // 4. Items. A weapon on anything in reach; healing when it helps; clues now.
  for (const id of items) {
    const item = card(id);
    if (!item || useItemProblem(state, ctx, id)) continue;
    const e = item.effect;
    if (e.hit || e.banish) return { type: 'USE_ITEM', itemId: id };
    if (e.health > 0 && me.health < me.healthMax) return { type: 'USE_ITEM', itemId: id };
    if (e.sanity > 0 && me.sanity < me.sanityMax) return { type: 'USE_ITEM', itemId: id };
    if (e.clue > 0 || e.action > 0) return { type: 'USE_ITEM', itemId: id };
  }

  // 5. Heal where the house allows it, and use a trait that is worth an action.
  const room = roomSpecialHere(state, ctx);
  if (room && !roomSpecialProblem(state, ctx) && low(me, room.pool)) return { type: 'ROOM_SPECIAL' };
  const trait = activeTrait(state, ctx);
  if (trait && !traitProblem(state, ctx)) {
    if (trait.ability === 'bartered-insight' && low(me, 'sanity')) return { type: 'USE_TRAIT' };
    if (trait.ability === 'whispers-from-beyond' && state.actionsLeft > 1 && rand() < 0.25) {
      return { type: 'USE_TRAIT' };
    }
  }

  // 6. A card underfoot is what investigating is for.
  if (!investigateProblem(state)) return { type: 'INVESTIGATE' };

  // 7. Thin the monsters before they gather, if healthy.
  const fighting = !low(me, 'health') && !low(me, 'sanity');
  const crowded = monsterCount(state) >= 3 || state.boss;
  if (fighting && crowded && !combatProblem(state, 'attack')) return { type: 'ATTACK' };

  // 8. Walk toward whatever matters most.
  const move = chooseMove(state, ctx, rand);
  if (move) return move;

  return { type: 'END_TURN' };
}

function answerChoice(state, ctx) {
  const choice = state.choice;
  const options = choice.options;

  if (choice.kind === 'new-investigator') {
    // The sturdiest sheet left.
    const score = (o) => {
      const sheet = ctx.investigators?.[o.id];
      return sheet ? sheet.health + sheet.sanity : 0;
    };
    return { type: 'CHOOSE', optionId: [...options].sort((a, b) => score(b) - score(a))[0].id };
  }

  if (['attack', 'strike', 'bind'].includes(choice.kind)) {
    // The boss first; otherwise the weakest, so it dies and the count drops.
    const monsters = options.map((o) => state.monsters.find((m) => m.id === o.id)).filter(Boolean);
    monsters.sort((a, b) => (b.kind === 'boss') - (a.kind === 'boss') || a.health - b.health);
    return { type: 'CHOOSE', optionId: monsters[0]?.id ?? options[0].id };
  }

  return { type: 'CHOOSE', optionId: options[0].id };
}

/**
 * Where to go. Every reachable destination is scored by how far it leaves the
 * investigator from the nearest thing worth reaching, measured by walking the
 * house as it stands — doors and all.
 */
function chooseMove(state, ctx, rand) {
  const destinations = legalDestinations(state, ctx);
  if (destinations.length === 0) return null;

  const me = currentPlayer(state);
  const targets = goals(state, ctx, me);
  if (targets.size === 0) return null;

  const here = distanceToGoal(state, ctx, me.pos, targets);
  let best = [];
  let bestScore = Infinity;
  for (const dest of destinations) {
    // Stepping into the dark is itself a goal when exploring.
    let score = targets.has(key(dest.pos)) ? 0 : distanceToGoal(state, ctx, dest.pos, targets);
    // A weak investigator does not end up beside a monster if it can help it.
    if ((low(me, 'health') || low(me, 'sanity')) && state.monsters.some((m) => gap(m.pos, dest.pos) <= 1)) {
      score += 4;
    }
    if (score < bestScore) {
      bestScore = score;
      best = [dest];
    } else if (score === bestScore) {
      best.push(dest);
    }
  }
  // Walled off from everything that matters: the house will turn, so get as
  // close as the crow flies to the nearest goal and wait for a door there.
  if (bestScore >= 99) {
    const crow = (pos) => Math.min(...[...targets].map((k) => gap(pos, posOf(k))));
    const now = crow(me.pos);
    let near = [];
    let nearest = now;
    for (const dest of destinations) {
      const d = crow(dest.pos);
      if (d < nearest) {
        nearest = d;
        near = [dest];
      } else if (d === nearest && near.length) {
        near.push(dest);
      }
    }
    return near.length ? { type: 'MOVE', path: pick(near, rand).path } : null;
  }

  // Nothing closer than standing still: no point spending the action.
  if (bestScore >= here && state.stepsLeft === 0) return null;
  return { type: 'MOVE', path: pick(best, rand).path };
}

/** The squares worth walking toward, given the state of the game. */
function goals(state, ctx, me) {
  const targets = new Set();
  const riftId = ctx.scenario.bossRoom;
  const squaresOf = (roomId) => {
    const out = [];
    for (const [slot, entry] of Object.entries(state.rooms)) {
      if (entry.roomId !== roomId) continue;
      const [R, C] = slot.split(',').map(Number);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push({ gr: R * 3 + r, gc: C * 3 + c });
    }
    return out;
  };

  // Hurt, with a clue to spend: go where the house heals.
  if ((me.clues ?? 0) > 0) {
    if (low(me, 'health')) for (const s of squaresOf(ctx.scenario.startRoom)) targets.add(key(s));
    if (low(me, 'sanity')) for (const s of squaresOf('library-of-azrel')) targets.add(key(s));
    if (targets.size > 0) return targets;
  }

  // The house is open and the Rift is on the table: take clues there.
  const houseOpen = state.roomDeck.length === 0;
  if (houseOpen && !state.boss && (me.clues ?? 0) > 0) {
    for (const s of squaresOf(riftId)) targets.add(key(s));
    if (targets.size > 0) return targets;
  }

  // The boss is out: the healthy go to fight it.
  const boss = state.monsters.find((m) => m.kind === 'boss');
  if (boss && !low(me, 'health') && !low(me, 'sanity')) {
    for (const s of STEPS) targets.add(key({ gr: boss.pos.gr + s.dr, gc: boss.pos.gc + s.dc }));
    return targets;
  }

  // Face-down cards are clues waiting to be found.
  const mournerRooms = new Set(
    state.monsters.filter((m) => m.power?.kind === 'blocks-investigate-room').map((m) => key(slotOf(m.pos))),
  );
  for (const [k, marker] of Object.entries(state.encounters)) {
    if (marker.collected) continue;
    const [gr, gc] = k.split(',').map(Number);
    if (mournerRooms.has(key(slotOf({ gr, gc })))) continue;
    targets.add(k);
  }

  // Doors into the dark: the house has to be opened to be sealed.
  if (state.roomDeck.length > 0) {
    for (const [slot] of Object.entries(state.rooms)) {
      const [R, C] = slot.split(',').map(Number);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const from = { gr: R * 3 + r, gc: C * 3 + c };
          for (const s of STEPS) {
            const to = { gr: from.gr + s.dr, gc: from.gc + s.dc };
            if (placed(state, to)) continue;
            if (!doorProblem(state, ctx, from, to)) targets.add(key(to));
          }
        }
      }
    }
  }

  // Monsters gathering: go and thin them out.
  if (monsterCount(state) >= 3 && !low(me, 'health') && !low(me, 'sanity')) {
    for (const m of state.monsters) {
      for (const s of STEPS) targets.add(key({ gr: m.pos.gr + s.dr, gc: m.pos.gc + s.dc }));
    }
  }
  return targets;
}

/**
 * Can the house be walked from one square to the next, for planning? A door is
 * a door whatever this turn has already drawn, and a monster moves, so neither
 * counts against a route — only the walls do.
 */
function doorProblem(state, ctx, from, to) {
  return stepProblem({ ...state, drewThisTurn: false, monsters: [] }, from, to, ctx);
}

/** Walking distance from a square to the nearest goal, through doors. */
function distanceToGoal(state, ctx, start, targets) {
  if (targets.has(key(start))) return 0;
  const seen = new Set([key(start)]);
  let frontier = [start];
  for (let depth = 1; depth <= 60 && frontier.length > 0; depth++) {
    const next = [];
    for (const pos of frontier) {
      for (const s of STEPS) {
        const to = { gr: pos.gr + s.dr, gc: pos.gc + s.dc };
        const k = key(to);
        if (seen.has(k)) continue;
        if (targets.has(k) && !placed(state, to)) {
          if (!doorProblem(state, ctx, pos, to)) return depth;
          continue;
        }
        if (!placed(state, to)) continue;
        if (doorProblem(state, ctx, pos, to)) continue;
        if (targets.has(k)) return depth;
        seen.add(k);
        next.push(to);
      }
    }
    frontier = next;
  }
  return 99;
}
