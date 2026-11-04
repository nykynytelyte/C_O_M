/**
 * Scenario I: The Nameless Presence.
 *
 * The base game with this scenario laid over it: its monster deck, its boss,
 * the summoning, the seal, and the base cards that only come alive once there
 * are monsters on the board.
 */

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

import {
  buildScenario,
  createGame,
  reduce,
  currentPlayer,
  investigateProblem,
  useItemProblem,
  sealProblem,
  combatProblem,
  engagedWith,
  monsterCount,
  pendingOrientations,
  roomsFromCsv,
  entrancesFromCsv,
  encountersFromCsv,
  itemsFromCsv,
  eventsFromCsv,
  investigatorsFromCsv,
  monstersFromCsv,
} from '../engine.js';

const here = (relative) => new URL(relative, import.meta.url);
const text = (relative) => readFile(here(relative), 'utf8');

const core = JSON.parse(await text('../rules/core.json'));
const raw = JSON.parse(await text('../scenarios/nameless-presence/scenario.json'));
const scenario = buildScenario(core, raw);
const monsterCards = monstersFromCsv(await text(`../scenarios/nameless-presence/${raw.monsterDeck}`));
const ctx = {
  scenario,
  rooms: roomsFromCsv(await text('../decks/rooms.csv')),
  entrances: entrancesFromCsv(await text('../decks/entrance.csv')),
  encounterCards: encountersFromCsv(await text('../decks/encounters.csv')),
  items: itemsFromCsv(await text('../decks/items.csv')),
  events: eventsFromCsv(await text('../decks/events.csv')),
  investigators: investigatorsFromCsv(await text('../decks/investigators.csv')),
  monsterCards,
};

const MONSTER_ENCOUNTER = '1';
const EVENT_ENCOUNTER = '19';
const RIFT_SLOT = '0,1';
const RIFT_CENTRE = { gr: 1, gc: 4 };

const start = ({ encounters = [], monsters = [], events = [], seed = 41 } = {}) => {
  const game = createGame(ctx, { seed, playerCount: 2, investigatorIds: ['1', '2'] });
  // Entrance card 17 lays one card face up, so whatever is under it is revealed
  // the moment the room is entered.
  game.entranceDeck = ['17'];
  game.encounterDeck = encounters.slice();
  game.monsterDeck = monsters.slice();
  game.eventDeck = events.slice();
  game.eventDiscard = [];
  return game;
};
const enterRoom = (game) => {
  let out = reduce(game, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
  out = reduce(out, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
  return reduce(out, { type: 'PLACE_ROOM', orient: pendingOrientations(out, ctx)[0] }, ctx);
};
const at = (key) => {
  const [gr, gc] = key.split(',').map(Number);
  return { gr, gc };
};
const card = (game, id, pos) => {
  const monster = monsterCards[id];
  game.monsters.push({
    id: `t${game.nextMonster++}`,
    kind: 'card',
    cardId: id,
    name: monster.name,
    health: monster.health,
    healthMax: monster.health,
    power: monster.power,
    pos,
  });
};
/** The Rift Room on the table east of the Foyer, with every room drawn. */
const riftOpen = (game) => {
  game.rooms[RIFT_SLOT] = { roomId: 'rift-room', rot: 0 };
  game.roomDeck = [];
  return game;
};

/* ------------------------------------------------------------------ *
 * The scenario and its deck
 * ------------------------------------------------------------------ */
{
  assert.equal(scenario.startRoom, 'foyer', 'the scenario starts in the Foyer');
  assert.equal(scenario.bossRoom, 'rift-room');
  assert.equal(scenario.bossRoomAppearsLast, true, 'the Rift Room is the final room revealed');
  assert.match(scenario.story.intro, /Harrowgate Manor/);

  const counts = {};
  for (const m of Object.values(monsterCards)) counts[m.name] = (counts[m.name] ?? 0) + 1;
  assert.deepEqual(
    counts,
    { 'Shuddering Husk': 3, Mourner: 4, 'Mad Reflection': 3, 'The Whisperer': 2 },
    'a 12-monster pool of four kinds',
  );
  assert.deepEqual(monsterCards['1'].power, { kind: 'spawn-adjacent-room', min: 5, max: 6 });
  assert.deepEqual(monsterCards['11'].power, { kind: 'all-players-sanity', min: 1, max: 2 });
  assert.throws(
    () => monstersFromCsv('id,name,health,power\n1,Thing,2,fly'),
    /not one of/,
  );
  assert.throws(() => monstersFromCsv('id,name,health\n1,Thing,0'), /at least 1/);

  const game = createGame(ctx, { seed: 3, playerCount: 2 });
  assert.equal(game.monsterDeck.length, 12, 'the monster deck is shuffled in');
  assert.equal(game.roomDeck[0], 'rift-room', 'and the Rift Room is the last room');
}

/* ------------------------------------------------------------------ *
 * A Monster encounter card brings a monster onto the board
 * ------------------------------------------------------------------ */
{
  // Mourner: nobody can Investigate in its room.
  const game = enterRoom(start({ encounters: [MONSTER_ENCOUNTER], monsters: ['4'] }));
  const key = game.lastEntrance.placed[0];
  assert.equal(game.encounters[key], undefined, 'the encounter card is replaced by the monster');
  assert.equal(monsterCount(game), 1);
  assert.equal(game.monsters[0].name, 'Mourner');
  assert.deepEqual(game.monsters[0].pos, at(key), 'standing where the card lay');
  assert.equal(game.monsterDeck.length, 0);

  game.encounters['-2,0'] = {
    room: '-1,0', number: 4, cardId: '9', type: null, faceUp: false, entranceId: '17',
  };
  game.players[0].pos = { gr: -2, gc: 0 };
  assert.match(investigateProblem(game), /engaged/, 'revealing it beside you engages you');
  game.players[0].engaged = [];
  assert.match(investigateProblem(game), /Mourner is in this room/, 'Wail of Stillness');
  game.players[0].pos = { gr: 1, gc: 1 };
  assert.doesNotMatch(investigateProblem(game) ?? '', /Mourner/, 'but only in its own room');
}
{
  // The Whisperer: every investigator rolls, and loses 1 Sanity on a 1-2.
  let lost = 0;
  let held = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const game = enterRoom(start({ encounters: [MONSTER_ENCOUNTER], monsters: ['11'], seed }));
    assert.match(game.log.join('\n'), /Suggestion of Ruin: every investigator rolls/);
    for (const player of game.players) {
      if (player.sanity < ctx.investigators[player.investigatorId].sanity) lost += 1;
      else held += 1;
    }
  }
  assert.ok(lost > 0 && held > 0, 'some roll a 1-2 and some do not');
}
{
  // Shuddering Husk: on a 5-6 another monster appears in a room next door.
  let split = 0;
  let still = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const game = enterRoom(start({ encounters: [MONSTER_ENCOUNTER], monsters: ['5', '1'], seed }));
    const roll = game.log.find((line) => line.startsWith('Split Instinct'));
    assert.ok(roll, 'the Husk rolls');
    if (/nothing follows/.test(roll)) {
      still += 1;
      assert.equal(monsterCount(game), 1);
    } else {
      split += 1;
      assert.equal(monsterCount(game), 2, 'a second monster appears');
      // The only room next to the new one is the Foyer.
      const second = game.monsters[1];
      assert.ok(second.pos.gr >= 0 && second.pos.gr <= 2 && second.pos.gc >= 0 && second.pos.gc <= 2);
    }
  }
  assert.ok(split > 0 && still > 0, 'both faces of Split Instinct were seen');
}

/* ------------------------------------------------------------------ *
 * Base cards that wait on monsters are live
 * ------------------------------------------------------------------ */
{
  // Event 27: spawn 1 Monster in an adjacent space.
  const game = enterRoom(start({ encounters: [EVENT_ENCOUNTER], events: ['27'], monsters: ['4'] }));
  const key = game.lastEntrance.placed[0];
  game.players[0].pos = at(key);
  const after = reduce(game, { type: 'INVESTIGATE' }, ctx);
  assert.equal(monsterCount(after), 1, 'event 27 summons a monster');
  const m = after.monsters[0];
  const p = after.players[0].pos;
  assert.equal(Math.abs(m.pos.gr - p.gr) + Math.abs(m.pos.gc - p.gc), 1, 'next to the investigator');
}
{
  // Event 26: all monsters move 1 space toward the nearest player.
  const game = enterRoom(start({ encounters: [EVENT_ENCOUNTER], events: ['26'] }));
  const key = game.lastEntrance.placed[0];
  game.players[0].pos = at(key);
  game.players[1].pos = at(key);
  card(game, '8', { gr: 1, gc: 1 });
  const before = Math.abs(1 - game.players[0].pos.gr) + Math.abs(1 - game.players[0].pos.gc);
  const after = reduce(game, { type: 'INVESTIGATE' }, ctx);
  const m = after.monsters[0];
  const gap = Math.abs(m.pos.gr - after.players[0].pos.gr) + Math.abs(m.pos.gc - after.players[0].pos.gc);
  assert.equal(gap, before - 1, 'the monster closes one space');
}
{
  // Weapons.
  const game = start();
  const me = game.players[0];
  card(game, '4', { gr: 1, gc: 2 }); // Mourner, 1 Health, next to the Foyer centre
  card(game, '8', { gr: 0, gc: 0 }); // Mad Reflection, 3 Health, two away

  me.items = ['6', '7', '12', '10'];
  assert.equal(useItemProblem(game, ctx, '6'), null, 'the Wrench reaches the Mourner');

  const wrenched = reduce(game, { type: 'USE_ITEM', itemId: '6' }, ctx);
  assert.equal(monsterCount(wrenched), 1, 'Heavy Wrench: 2 damage destroys the Mourner');
  assert.ok(wrenched.monsterDiscard.includes('4'), 'its card goes to the discard');

  const shot = reduce(wrenched, { type: 'USE_ITEM', itemId: '7' }, ctx);
  assert.equal(shot.monsters[0].health, 2, 'Old Revolver: 1 damage from two spaces away');

  assert.match(useItemProblem(shot, ctx, '12'), /no monster on or next to/, 'Holy Water is close range');

  const two = start();
  card(two, '4', { gr: 1, gc: 2 });
  card(two, '8', { gr: 1, gc: 0 });
  two.players[0].items = ['10'];
  const asked = reduce(two, { type: 'USE_ITEM', itemId: '10' }, ctx);
  assert.equal(asked.players[0].health, two.players[0].health - 1, 'the Knife takes its Health');
  assert.equal(asked.choice?.kind, 'strike', 'two targets: the player picks');
  const cut = reduce(asked, { type: 'CHOOSE', optionId: asked.choice.options[1].id }, ctx);
  assert.equal(cut.monsters.find((m) => m.cardId === '8').health, 1, 'Ritual Knife: 2 damage');
}

/* ------------------------------------------------------------------ *
 * Combat, from the rulebook
 * ------------------------------------------------------------------ */
{
  // Attack: 4-6 hits, 1-3 misses and the attacker takes 1 damage.
  const faces = { hit: 0, miss: 0 };
  for (let seed = 1; seed <= 40; seed++) {
    const game = start({ seed });
    card(game, '8', { gr: 1, gc: 2 }); // Mad Reflection, 3 Health
    const before = { ...game.players[0] };
    const after = reduce(game, { type: 'ATTACK' }, ctx);
    const roll = after.lastRoll.value;
    const me = after.players[0];
    assert.equal(after.actionsLeft, game.actionsLeft - 1, 'an attack is an action');
    assert.deepEqual(me.engaged, [after.monsters[0].id], 'attacking engages you');
    if (roll >= 4) {
      faces.hit += 1;
      assert.equal(after.monsters[0].health, 2, `a ${roll} hits for 1`);
      assert.equal(me.sanity, before.sanity);
    } else {
      faces.miss += 1;
      assert.equal(after.monsters[0].health, 3, `a ${roll} misses`);
      // Mind Mirror: the Mad Reflection's blow lands on Sanity, not Health.
      assert.ok(me.sanity < before.sanity, 'a miss costs the attacker, in Sanity');
      assert.equal(me.health, before.health);
    }
  }
  assert.ok(faces.hit > 0 && faces.miss > 0, 'both faces of an attack were seen');

  // While engaged: only Attack or Flee.
  const held = start();
  card(held, '1', { gr: 1, gc: 2 });
  held.players[0].engaged = [held.monsters[0].id];
  assert.throws(() => reduce(held, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx), /Attack or Flee/);
  assert.match(investigateProblem(held), /engaged/);
  assert.equal(combatProblem(held, 'flee'), null);

  // Flee: 4+ escapes, 1-3 fails and costs 1 Health.
  const fled = { free: 0, caught: 0 };
  for (let seed = 1; seed <= 40; seed++) {
    const game = start({ seed });
    card(game, '1', { gr: 1, gc: 2 });
    game.players[0].engaged = [game.monsters[0].id];
    const after = reduce(game, { type: 'FLEE' }, ctx);
    const roll = after.lastRoll.value;
    if (roll >= 4) {
      fled.free += 1;
      assert.deepEqual(engagedWith(after, after.players[0]), [], `a ${roll} escapes`);
    } else {
      fled.caught += 1;
      assert.equal(engagedWith(after, after.players[0]).length, 1, `a ${roll} does not`);
      assert.equal(after.players[0].health, game.players[0].health - 1, 'and costs 1 Health');
    }
  }
  assert.ok(fled.free > 0 && fled.caught > 0, 'both faces of a flight were seen');

  // Ending a turn beside a monster engages you.
  const lingering = start();
  card(lingering, '4', { gr: 2, gc: 1 });
  lingering.players[1].pos = { gr: 0, gc: 0 };
  const ended = reduce(lingering, { type: 'END_TURN' }, ctx);
  assert.equal(engagedWith(ended, ended.players[0]).length, 1, 'next to it at the end of the turn');

  // Binding Chalk keeps it off you this turn.
  const chalked = start();
  card(chalked, '4', { gr: 2, gc: 1 });
  chalked.players[0].items = ['9'];
  const bound = reduce(chalked, { type: 'USE_ITEM', itemId: '9' }, ctx);
  const passed = reduce(bound, { type: 'END_TURN' }, ctx);
  assert.equal(engagedWith(passed, passed.players[0]).length, 0, 'Binding Chalk holds it back');

  // Monsters block movement.
  const blocked = start();
  card(blocked, '4', { gr: 1, gc: 2 });
  blocked.players[0].engaged = [];
  blocked.players[0].bound = [blocked.monsters[0].id];
  assert.throws(
    () => reduce(blocked, { type: 'MOVE', path: [{ gr: 1, gc: 2 }] }, ctx),
    /stands in the way/,
  );

  // Event 29: every engaged monster deals 1 damage.
  const struck = enterRoom(start({ encounters: [EVENT_ENCOUNTER], events: ['29'] }));
  const key = struck.lastEntrance.placed[0];
  struck.players[0].pos = at(key);
  card(struck, '1', { gr: 1, gc: 1 });
  struck.players[1].engaged = [struck.monsters[0].id];
  const afterEvent = reduce(struck, { type: 'INVESTIGATE' }, ctx);
  assert.equal(afterEvent.players[1].health, struck.players[1].health - 1, 'event 29 bites the engaged');
  assert.equal(afterEvent.players[0].health, struck.players[0].health, 'and nobody else');
}

/* ------------------------------------------------------------------ *
 * Rulebook defaults: Clue rerolls, boss damage, monster movement
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(scenario.combat, { clueReroll: true, monsterDamage: 1, bossDamage: 2 });

  // A failed Attack with a Clue in hand: the table is asked.
  let asked = null;
  for (let seed = 1; seed <= 40 && !asked; seed++) {
    const game = start({ seed });
    card(game, '8', { gr: 1, gc: 2 });
    game.players[0].clues = 2;
    const after = reduce(game, { type: 'ATTACK' }, ctx);
    if (after.choice?.kind === 'reroll') asked = after;
  }
  assert.ok(asked, 'a failed roll with a Clue in hand offers a reroll');
  assert.equal(asked.monsters[0].health, 3, 'nothing is settled while the question is open');
  const kept = reduce(asked, { type: 'CHOOSE', optionId: 'no' }, ctx);
  assert.equal(kept.players[0].clues, 2, 'keeping the roll costs nothing');
  assert.ok(kept.players[0].sanity < asked.players[0].sanity, 'and the miss lands');
  const again = reduce(asked, { type: 'CHOOSE', optionId: 'yes' }, ctx);
  assert.equal(again.players[0].clues, 1, 'a reroll costs a Clue');
  assert.match(again.log.join('\n'), /spends a Clue and rolls again/);

  // No Clue in hand, no question.
  for (let seed = 1; seed <= 10; seed++) {
    const game = start({ seed });
    card(game, '8', { gr: 1, gc: 2 });
    assert.equal(reduce(game, { type: 'ATTACK' }, ctx).choice, null);
  }

  // The boss card names no damage, so the rulebook's 2 applies.
  let bossMiss = null;
  for (let seed = 1; seed <= 40 && !bossMiss; seed++) {
    const game = start({ seed });
    game.monsters.push({ id: 'b1', kind: 'boss', name: 'The Nameless Presence', health: 8, healthMax: 8, pos: { gr: 1, gc: 2 } });
    const after = reduce(game, { type: 'ATTACK' }, ctx);
    if (after.lastRoll.value < 4) bossMiss = { before: game, after };
  }
  assert.equal(bossMiss.after.players[0].health, bossMiss.before.players[0].health - 2, 'a miss on the boss costs 2');

  // Movement: none by default; 'hunt' closes in through doors; 'room' only in its room.
  const moving = (mode) => {
    const game = start();
    game.players.forEach((p) => {
      p.pos = { gr: 0, gc: 0 };
    });
    card(game, '1', { gr: 2, gc: 2 });
    const c = { ...ctx, scenario: { ...ctx.scenario, monsterMovement: mode } };
    let g = reduce(game, { type: 'END_TURN' }, c);
    g = reduce(g, { type: 'END_TURN' }, c);
    return g.monsters[0].pos;
  };
  assert.deepEqual(moving('none'), { gr: 2, gc: 2 }, 'by default monsters stay put');
  const hunted = moving('hunt');
  assert.equal(Math.abs(hunted.gr) + Math.abs(hunted.gc), 3, 'hunting, it closes one space');
  assert.equal(Math.abs(moving('room').gr) + Math.abs(moving('room').gc), 3, 'in its own room it hunts too');
  const elsewhere = start();
  card(elsewhere, '1', { gr: -2, gc: 1 });
  elsewhere.rooms['-1,0'] = { roomId: 'gallery', rot: 0 };
  const c = { ...ctx, scenario: { ...ctx.scenario, monsterMovement: 'room' } };
  let g = reduce(elsewhere, { type: 'END_TURN' }, c);
  g = reduce(g, { type: 'END_TURN' }, c);
  assert.deepEqual(g.monsters[0].pos, { gr: -2, gc: 1 }, 'a room guard ignores investigators next door');
}

/* ------------------------------------------------------------------ *
 * The summoning
 * ------------------------------------------------------------------ */
{
  const five = riftOpen(start());
  for (let i = 0; i < 5; i++) card(five, String(i + 1), { gr: -1, gc: 0 });
  const calm = reduce(five, { type: 'END_TURN' }, ctx);
  assert.equal(calm.boss, null, 'five monsters are not enough');

  const notYet = start();
  for (let i = 0; i < 6; i++) card(notYet, String(i + 1), { gr: 1, gc: 0 });
  assert.equal(reduce(notYet, { type: 'END_TURN' }, ctx).boss, null, 'nor is six without the Rift Room');

  const six = riftOpen(start());
  for (let i = 0; i < 6; i++) card(six, String(i + 1), { gr: 1, gc: 0 });
  const summoned = reduce(six, { type: 'END_TURN' }, ctx);
  const boss = summoned.monsters.find((m) => m.kind === 'boss');
  assert.ok(boss, 'six monsters and the Rift Room: the Presence manifests');
  assert.deepEqual(boss.pos, RIFT_CENTRE, 'in space [5] of the Rift Room');
  assert.equal(boss.health, 8);
  assert.equal(monsterCount(summoned), 6, 'the boss is not counted among the monsters');
  assert.match(summoned.log.join('\n'), /It arrives\./, 'and its card is read out');
  assert.match(sealProblem(riftOpen(summoned), ctx), /can no longer be sealed/);

  // At the end of each round it drifts one space toward the nearest
  // investigator, and its aura takes Sanity from everyone beside it.
  let game = summoned;
  game.players.forEach((p) => {
    p.pos = { gr: 1, gc: 1 };
  });
  while (game.round === summoned.round) game = reduce(game, { type: 'END_TURN' }, ctx);
  const moved = game.monsters.find((m) => m.kind === 'boss');
  assert.deepEqual(moved.pos, { gr: 1, gc: 3 }, 'one space, through the wall');
  while (game.round === summoned.round + 1) game = reduce(game, { type: 'END_TURN' }, ctx);
  assert.deepEqual(game.monsters.find((m) => m.kind === 'boss').pos, { gr: 1, gc: 2 });
  assert.match(game.log.join('\n'), /Mindquake Aura/, 'beside it, the aura bites');
  assert.match(game.log.join('\n'), /Rupture of Self/, 'and every Sanity loss risks another');
  for (const p of game.players) {
    assert.ok(p.sanity < ctx.investigators[p.investigatorId].sanity, `${p.name} lost Sanity`);
  }

  // Destroying it wins the game.
  const finale = structuredClone(summoned);
  finale.monsters.find((m) => m.kind === 'boss').health = 1;
  finale.turnIndex = 0;
  finale.players[0].pos = { gr: 1, gc: 3 };
  finale.players[0].items = ['6'];
  const won = reduce(finale, { type: 'USE_ITEM', itemId: '6' }, ctx);
  assert.deepEqual(won.over, { result: 'won', reason: 'The Nameless Presence is destroyed.' });

  finale.players[0].items = ['12'];
  finale.monsters = finale.monsters.filter((m) => m.kind === 'boss');
  assert.match(useItemProblem(finale, ctx, '12'), /no monster/, 'Holy Water does not work on the boss');
}

/* ------------------------------------------------------------------ *
 * Sealing the Rift
 * ------------------------------------------------------------------ */
{
  const game = start();
  game.players[0].clues = 3;
  assert.match(sealProblem(game, ctx), /every room must be revealed/);
  riftOpen(game);
  assert.match(sealProblem(game, ctx), /in the Rift Room/);
  game.players[0].pos = RIFT_CENTRE;
  assert.equal(sealProblem(game, ctx), null);

  const half = reduce(game, { type: 'SEAL' }, ctx);
  assert.equal(half.sealClues, 3, 'clues are spent on the seal');
  assert.equal(half.players[0].clues, 0);
  assert.equal(half.actionsLeft, game.actionsLeft - 1, 'it takes an action');
  assert.equal(half.over, null, 'two investigators need four');

  half.players[0].clues = 5;
  const sealed = reduce(half, { type: 'SEAL' }, ctx);
  assert.equal(sealed.players[0].clues, 4, 'only what the seal still needs is spent');
  assert.deepEqual(sealed.over, { result: 'won', reason: 'The Rift is sealed.' });
  assert.throws(() => reduce(sealed, { type: 'END_TURN' }, ctx), /the game is over/);
}

/* ------------------------------------------------------------------ *
 * A long random game never breaks
 * ------------------------------------------------------------------ */
{
  const outcomes = { won: 0, lost: 0, running: 0, summoned: 0 };
  for (let seed = 1; seed <= 60; seed++) {
    let x = seed * 7919;
    const rand = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    let game = createGame(ctx, { seed, playerCount: 1 + (seed % 4) });
    let everSummoned = false;
    for (let i = 0; i < 4000 && !game.over; i++) {
      if (game.choice) {
        const option = game.choice.options[Math.floor(rand() * game.choice.options.length)];
        game = reduce(game, { type: 'CHOOSE', optionId: option.id }, ctx);
      } else if (game.pending) {
        game = reduce(game, { type: 'PLACE_ROOM', orient: pendingOrientations(game, ctx)[0] }, ctx);
      } else if (!sealProblem(game, ctx)) {
        game = reduce(game, { type: 'SEAL' }, ctx);
      } else if (!combatProblem(game, 'attack') && rand() < 0.5) {
        game = reduce(game, { type: 'ATTACK' }, ctx);
      } else if (!combatProblem(game, 'flee') && rand() < 0.6) {
        game = reduce(game, { type: 'FLEE' }, ctx);
      } else if (!investigateProblem(game) && rand() < 0.6) {
        game = reduce(game, { type: 'INVESTIGATE' }, ctx);
      } else {
        const usable = (currentPlayer(game).items ?? []).find((id) => !useItemProblem(game, ctx, id));
        if (usable && rand() < 0.5) {
          game = reduce(game, { type: 'USE_ITEM', itemId: usable }, ctx);
          continue;
        }
        const { legalDestinations } = await import('../engine.js');
        const dest = game.actionsLeft > 0 ? legalDestinations(game, ctx) : [];
        game =
          dest.length > 0 && rand() < 0.85
            ? reduce(game, { type: 'MOVE', path: dest[Math.floor(rand() * dest.length)].path }, ctx)
            : reduce(game, { type: 'END_TURN' }, ctx);
      }
      if (game.boss) everSummoned = true;
      for (const m of game.monsters) {
        assert.ok(game.rooms[`${Math.floor(m.pos.gr / 3)},${Math.floor(m.pos.gc / 3)}`] !== undefined, 'monsters stand in rooms');
      }
    }
    if (everSummoned) outcomes.summoned += 1;
    outcomes[game.over?.result ?? 'running'] += 1;
  }
  console.log(
    `60 random games: ${outcomes.won} won, ${outcomes.lost} lost, ${outcomes.running} unfinished; the Presence came in ${outcomes.summoned}`,
  );
}

/* ------------------------------------------------------------------ *
 * The test bot plays whole games without ever asking for an illegal move
 * ------------------------------------------------------------------ */
{
  const { simulate } = await import('../sim/run.mjs');
  for (const players of [1, 3]) {
    const games = simulate(ctx, { games: 6, players, seed: 5 });
    for (const g of games) assert.equal(g.error, null, `bot game seed ${g.seed}: ${g.error}`);
  }
}

console.log('\nSCENARIO I OK');
