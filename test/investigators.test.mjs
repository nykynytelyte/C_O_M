/**
 * Investigator sheets: the six characters, their numbers, and how a seat is
 * filled from the deck.
 *
 * Run with: npm test
 */

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

import {
  buildScenario,
  createGame,
  reduce,
  currentPlayer,
  pendingOrientations,
  useItemProblem,
  roomSpecialProblem,
  traitProblem,
  investigatorsFromCsv,
  roomsFromCsv,
  entrancesFromCsv,
  encountersFromCsv,
  itemsFromCsv,
  eventsFromCsv,
} from '../engine.js';

const here = (relative) => new URL(relative, import.meta.url);

const core = JSON.parse(await readFile(here('../rules/core.json'), 'utf8'));
const scenario = buildScenario(
  core,
  JSON.parse(await readFile(here('../scenarios/nameless-presence/scenario.json'), 'utf8')),
);
const rooms = roomsFromCsv(await readFile(here('../decks/rooms.csv'), 'utf8'));
const entrances = entrancesFromCsv(await readFile(here('../decks/entrance.csv'), 'utf8'));
const encounterCards = encountersFromCsv(await readFile(here('../decks/encounters.csv'), 'utf8'));
const items = itemsFromCsv(await readFile(here('../decks/items.csv'), 'utf8'));
const events = eventsFromCsv(await readFile(here('../decks/events.csv'), 'utf8'));
const investigators = investigatorsFromCsv(
  await readFile(here('../decks/investigators.csv'), 'utf8'),
);

const ctx = { scenario, rooms, entrances, encounterCards, items, events, investigators };

/* ------------------------------------------------------------------ *
 * The sheets themselves
 * ------------------------------------------------------------------ */

{
  assert.deepEqual(
    Object.keys(investigators),
    ['1', '2', '3', '4', '5', '6'],
    'the six sheets are in the deck',
  );

  const clara = investigators['1'];
  assert.equal(clara.name, 'Clara Holt');
  assert.equal(clara.role, 'The Rational Archivist');
  assert.equal(clara.health, 4, 'Health comes off the sheet');
  assert.equal(clara.sanity, 6, 'and so does Sanity');
  assert.equal(clara.clueLimit, 5, 'and the Clue Limit');
  assert.equal(clara.trait, 'Logical Detachment');
  assert.equal(clara.ability, 'logical-detachment', 'her trait has a rule behind it');
  assert.match(clara.bio, /Harrowgate/, 'the back of the card is kept as well');

  const gideon = investigators['2'];
  assert.equal(gideon.health, 6, 'Gideon is the tougher one');
  assert.equal(gideon.sanity, 4, 'and the more brittle one');

  // Every trait has a rule behind it, so none of them waits on anything.
  for (const sheet of Object.values(investigators)) {
    assert.ok(sheet.trait, `${sheet.name} has a trait`);
    assert.ok(sheet.traitText, `${sheet.name}'s trait is written out`);
    assert.ok(sheet.ability, `${sheet.name}'s trait has a rule`);
    assert.equal(sheet.traitNeeds, '', `${sheet.name}'s trait waits on nothing`);
    assert.ok(Number.isInteger(sheet.health) && sheet.health > 0, `${sheet.name} has Health`);
    assert.ok(Number.isInteger(sheet.sanity) && sheet.sanity > 0, `${sheet.name} has Sanity`);
  }
}

/* ------------------------------------------------------------------ *
 * Reading the CSV
 * ------------------------------------------------------------------ */

{
  const head = 'id,name,health,sanity,clueLimit,trait,traitText,traitNeeds,bio\n';

  const plain = investigatorsFromCsv(
    head + '1,Ada,4,4,5,Quiet,"Says little.",,She is here.',
  );
  assert.equal(plain['1'].name, 'Ada');
  assert.equal(plain['1'].role, '', 'a sheet without a role has no role');
  assert.equal(plain['1'].traitNeeds, '', 'a live trait waits for nothing');

  assert.throws(
    () => investigatorsFromCsv(head + '1,Ada,4,4,5,T,,,\n1,Ada,4,4,5,T,,,'),
    /duplicate id/,
  );
  assert.throws(() => investigatorsFromCsv(head + '1,Ada,four,4,5,T,,,'), /not a number of Health/);
  assert.equal(
    investigatorsFromCsv(head + '1,Ada,4,4,5,T,,,')['1'].name,
    'Ada',
    'a sheet with an empty bio and a live trait still reads',
  );
  assert.throws(() => investigatorsFromCsv(head + '1,,4,4,5,T,,,'), /has no name/);
  assert.throws(
    () => investigatorsFromCsv('id,name,health\n1,Ada,4\n'),
    /missing the "sanity" column/,
  );
  assert.throws(() => investigatorsFromCsv('id,name,health,sanity,clueLimit\n'), /no investigators/);
}

/* ------------------------------------------------------------------ *
 * Filling the seats
 * ------------------------------------------------------------------ */

{
  const state = createGame(ctx, { seed: 11, playerCount: 2 });

  assert.equal(state.players.length, 2);
  const [first, second] = state.players;
  assert.equal(first.name, 'Clara Holt', 'the first seat is the first sheet');
  assert.equal(first.investigatorId, '1');
  assert.equal(first.role, 'The Rational Archivist');
  assert.equal(first.health, 4);
  assert.equal(first.healthMax, 4, 'and it starts full');
  assert.equal(first.sanity, 6);
  assert.equal(first.sanityMax, 6);
  assert.equal(first.clueLimit, 5);
  assert.equal(first.clues, 0, 'nobody starts holding a clue');
  assert.deepEqual(first.items, [], 'and nobody starts with an item');
  assert.deepEqual(first.pos, second.pos, 'everyone starts in the same room');

  assert.equal(second.name, 'Gideon Marsh');
  assert.equal(second.health, 6);
  assert.equal(second.sanity, 4);

  assert.equal(state.clues, undefined, 'there is no shared clue pile any more');

  const chosen = createGame(ctx, {
    seed: 11,
    playerCount: 2,
    investigatorIds: ['3', '6'],
  });
  assert.deepEqual(
    chosen.players.map((player) => player.name),
    ['Lucille Voss', 'Silas Finch'],
    'the seats can be filled from any sheet',
  );
  assert.equal(chosen.players[0].sanity, 6);

  const one = createGame(ctx, { seed: 3, playerCount: 1 });
  assert.equal(one.players.length, 1);
  assert.equal(one.players[0].name, 'Clara Holt');
}

{
  const tooFew = {
    ...ctx,
    investigators: { '1': investigators['1'], '2': investigators['2'] },
  };
  assert.throws(
    () => createGame(tooFew, { seed: 1, playerCount: 3 }),
    /needs 3 investigators and the deck holds 2/,
  );
  assert.throws(
    () => createGame(ctx, { seed: 1, playerCount: 2, investigatorIds: ['1', '1'] }),
    /cannot take two seats/,
  );
  assert.throws(
    () => createGame(ctx, { seed: 1, playerCount: 2, investigatorIds: ['1', '9'] }),
    /no investigator "9"/,
  );
  assert.throws(
    () => createGame(ctx, { seed: 1, playerCount: 2, investigatorIds: ['1'] }),
    /1 investigator\(s\) were named for 2 player/,
  );
}

// A game with no investigator deck still works, with plain seats, so the engine
// does not depend on this deck existing.
{
  const { investigators: _drop, ...bare } = ctx;
  const state = createGame(bare, { seed: 5, playerCount: 2 });
  assert.equal(state.players[0].name, 'Investigator 1');
  assert.equal(state.players[0].health, undefined, 'no sheet, no numbers to show');
  assert.equal(state.players[0].clues, 0, 'but a seat can still hold a clue token');
}

/* ------------------------------------------------------------------ *
 * Clue tokens belong to an investigator
 * ------------------------------------------------------------------ */

{
  const journalId = Object.values(items).find((item) => item.name === 'Clue Journal').id;

  let state = createGame(ctx, { seed: 7, playerCount: 2 });
  state.players[0].items = [journalId];
  state = reduce(state, { type: 'USE_ITEM', itemId: journalId }, ctx);

  assert.equal(state.players[0].clues, 1, 'the token belongs to the investigator who took it');
  assert.equal(state.players[1].clues, 0, 'and not to the table');
}

/* ------------------------------------------------------------------ *
 * Health and Sanity are live
 *
 * Every one of these is a card read through the real CSV path: nothing here
 * pokes a pool directly except to set the situation the card is asking about.
 * ------------------------------------------------------------------ */

{
  const start = (
    encounterIds,
    { events: eventIds = [], items: itemIds = [] } = {},
    entranceId = '17',
  ) => {
    const game = createGame(ctx, { seed: 41, playerCount: 2, investigatorIds: ['1', '2'] });
    // These read the cards themselves; Clara's own trait has its own test.
    for (const p of game.players) p.ability = null;
    game.entranceDeck = [entranceId];
    game.encounterDeck = encounterIds.slice();
    game.eventDeck = eventIds.slice();
    game.eventDiscard = [];
    game.itemDeck = itemIds.slice();
    game.itemDiscard = [];
    return game;
  };
  const enterRoom = (game, c = ctx) => {
    let out = reduce(game, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, c);
    out = reduce(out, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, c);
    return reduce(out, { type: 'PLACE_ROOM', orient: pendingOrientations(out, c)[0] }, c);
  };
  const take = (game, at, c = ctx) => {
    const [gr, gc] = at.split(',').map(Number);
    game.players[game.turnIndex].pos = { gr, gc };
    return reduce(game, { type: 'INVESTIGATE' }, c);
  };
  // One Event card, read on a fresh house, with the situation set first.
  const read = (cardIds, rig) => {
    const game = enterRoom(start(['19'], { events: cardIds }));
    if (rig) rig(game);
    return take(game, game.lastEntrance.placed[0]);
  };

  // Card 10 is one Sanity off the investigator who read it, and nobody else.
  const drained = read(['10']);
  assert.equal(drained.players[0].sanity, 5, 'card 10 costs one Sanity');
  assert.equal(drained.players[1].sanity, 4, 'the other investigator keeps theirs');
  assert.match(drained.log.join('\n'), /loses 1 Sanity \(this event\) — 5 of 6 left/);

  // Card 12 gives one back, but never past the sheet.
  const restored = read(['12'], (game) => {
    game.players[0].sanity = 3;
  });
  assert.equal(restored.players[0].sanity, 4, 'card 12 is one Sanity back');
  const full = read(['12']);
  assert.equal(full.players[0].sanity, 6, 'a full investigator stays full');
  assert.match(full.log.join('\n'), /already at full Sanity/);

  // At 0 Sanity the investigator goes mad: the house keeps them as a monster
  // where they stood, and the player takes up a sheet nobody has played yet.
  const emptied = read(['11'], (game) => {
    game.players[0].sanity = 1;
  });
  assert.equal(emptied.players[0].sanity, 0, 'a two-point loss stops at zero');
  assert.match(emptied.log.join('\n'), /has gone mad\. Where they stood, there is now a monster/);
  assert.equal(emptied.monsters.length, 1, 'madness leaves a monster behind');
  assert.deepEqual(emptied.monsters[0].pos, emptied.players[0].pos, 'standing where they went mad');
  assert.equal(emptied.choice?.kind, 'new-investigator', 'the seat is offered a new sheet');
  const offered = emptied.choice.options.map((o) => o.id);
  for (const seated of emptied.usedInvestigators) {
    assert.ok(!offered.includes(seated), `investigator ${seated} has already been played`);
  }
  assert.throws(
    () => reduce(emptied, { type: 'END_TURN' }, ctx),
    /answer the choice/,
    'nothing happens until the seat is filled',
  );

  const replaced = reduce(emptied, { type: 'CHOOSE', optionId: offered[0] }, ctx);
  const fresh = replaced.players[0];
  const sheet = investigators[offered[0]];
  assert.equal(fresh.investigatorId, sheet.id);
  assert.equal(fresh.name, sheet.name);
  assert.equal(fresh.sanity, sheet.sanity, 'a new investigator starts with a full sheet');
  assert.equal(fresh.health, sheet.health);
  assert.equal(fresh.clues, 0);
  assert.deepEqual(fresh.items, []);
  assert.deepEqual(fresh.pos, { gr: 1, gc: 1 }, 'and starts in the Foyer');
  assert.equal(fresh.down, undefined);
  assert.ok(replaced.usedInvestigators.includes(sheet.id), 'and is not dealt again');
  assert.equal(replaced.turnIndex, 1, 'going mad on your own turn ends it');
  assert.equal(replaced.choice, null);

  // At 0 Health the investigator has fallen: no monster, a new sheet all the same.
  const fallen = read(['19'], (game) => {
    game.players[0].health = 1;
  });
  assert.equal(fallen.players[0].health, 0);
  assert.match(fallen.log.join('\n'), /has fallen/);
  assert.equal(fallen.monsters.length, 0, 'a fallen investigator is not a monster');
  assert.equal(fallen.choice?.kind, 'new-investigator');

  // With every sheet already played there is no one to send, and the seat is out.
  const lastStand = read(['19'], (game) => {
    game.players[0].health = 1;
    game.usedInvestigators = Object.keys(investigators);
  });
  assert.equal(lastStand.players[0].out, true, 'no sheets left: the seat is out');
  assert.equal(lastStand.choice, null);
  assert.equal(lastStand.turnIndex, 1, 'and play passes on');
  assert.equal(lastStand.over, null, 'one seat is still in the game');
  let rounds = lastStand;
  for (let i = 0; i < 3; i++) {
    rounds = reduce(rounds, { type: 'END_TURN' }, ctx);
    assert.equal(rounds.turnIndex, 1, 'a seat that is out is skipped');
  }

  // When the last seat is out, the game is over.
  const wiped = read(['19'], (game) => {
    game.players[0].health = 1;
    game.players[1].out = true;
    game.usedInvestigators = Object.keys(investigators);
  });
  assert.deepEqual(wiped.over, { result: 'lost', reason: 'Every investigator is gone.' });
  assert.throws(() => reduce(wiped, { type: 'END_TURN' }, ctx), /the game is over/);

  const again = read(['11'], (game) => {
    game.players[0].sanity = 0;
  });
  assert.match(again.log.join('\n'), /no Sanity left to lose/, 'and it says so next time');

  // Card 13 only bites when Sanity is already low.
  const brittle = read(['13'], (game) => {
    game.players[0].sanity = 3;
  });
  assert.equal(brittle.players[0].sanity, 2, 'card 13 takes another point at 3');
  const steady = read(['13']);
  assert.equal(steady.players[0].sanity, 6, 'and nothing at all at 6');
  assert.match(steady.log.join('\n'), /only bites when Sanity is 3 or less/);

  // The die comes first: card 1 is a point of Health on 1-3 and nothing after.
  const rolled = read(['1']);
  const die = Number(/The die comes up (\d)/.exec(rolled.log.join('\n'))[1]);
  assert.equal(rolled.players[0].health, die <= 3 ? 3 : 4, `card 1 on a ${die}`);
  assert.equal(rolled.lastRoll.value, die, 'the face is kept for a card that reads it');
  assert.equal(rolled.lastRoll.die, 6, 'and the card asked for a d6');

  // Card 19 asks whether anything is being carried.
  const emptyHanded = read(['19']);
  assert.equal(emptyHanded.players[0].health, 3, 'with no items, card 19 costs Health');
  const carrying = read(['19'], (game) => {
    game.players[0].items = ['14'];
  });
  assert.equal(carrying.players[0].health, 4, 'carrying anything, it costs nothing');
  assert.match(carrying.log.join('\n'), /nothing at all is being carried/);

  // The First Aid Kit gives a point back and is spent doing it.
  const kitBefore = enterRoom(start(['25'], { items: ['2'] }));
  const kit = take(kitBefore, kitBefore.lastEntrance.placed[0]);
  kit.players[0].health = 2;
  const healed = reduce(kit, { type: 'USE_ITEM', itemId: '2' }, ctx);
  assert.equal(healed.players[0].health, 3, 'the kit restores one Health');
  assert.deepEqual(healed.itemDiscard, ['2'], 'and goes to the discard pile');

  // The Tattered Grimoire trades one pool for the other.
  const grimoireBefore = enterRoom(start(['25'], { items: ['17'] }));
  const grimoire = take(grimoireBefore, grimoireBefore.lastEntrance.placed[0]);
  grimoire.players[0].sanity = 3;
  const traded = reduce(grimoire, { type: 'USE_ITEM', itemId: '17' }, ctx);
  assert.equal(traded.players[0].sanity, 4, 'the grimoire gives one Sanity');
  assert.equal(traded.players[0].health, 3, 'and takes one Health');

  // The Protective Amulet takes the whole of the next source, then it is gone.
  const wardedBefore = enterRoom(start(['19', '20'], { events: ['10', '10'] }, '8'));
  const [firstSquare, secondSquare] = wardedBefore.lastEntrance.placed;
  wardedBefore.players[0].items = ['11'];
  let warded = reduce(wardedBefore, { type: 'USE_ITEM', itemId: '11' }, ctx);
  warded = take(warded, firstSquare);
  assert.equal(warded.players[0].sanity, 6, 'the amulet absorbs the first source');
  assert.match(warded.log.join('\n'), /warded: the Protective Amulet absorbs/);
  warded.actionsLeft = 2;
  warded = take(warded, secondSquare);
  assert.equal(warded.players[0].sanity, 5, 'and the next source lands');

  // Painkillers take a whole source however heavy it is — proved with a card
  // read through the same reader, because no Health card deals more than one.
  const heavyCtx = {
    ...ctx,
    events: { ...events, ...eventsFromCsv('id,effect,text\nh,health:-3,"Lose 3 Health."') },
  };
  const armoured = createGame(heavyCtx, {
    seed: 41,
    playerCount: 2,
    investigatorIds: ['1', '2'],
  });
  armoured.entranceDeck = ['19'];
  armoured.encounterDeck = ['19'];
  armoured.eventDeck = ['h'];
  let padded = enterRoom(armoured, heavyCtx);
  padded.players[0].items = ['18'];
  padded = reduce(padded, { type: 'USE_ITEM', itemId: '18' }, heavyCtx);
  padded = take(padded, padded.lastEntrance.placed[0], heavyCtx);
  assert.equal(padded.players[0].health, 4, 'the painkillers take a three-point source whole');
  assert.match(padded.log.join('\n'), /warded: the Painkillers absorbs/);

  // A die inside an item card: Dark Dice hands over a token on 4-6 and takes a
  // point of Sanity on 1-3, and both faces are the same d6 said out loud.
  const faces = { token: 0, hurt: 0 };
  for (let seed = 1; seed <= 12; seed++) {
    const game = createGame(ctx, { seed, playerCount: 2, investigatorIds: ['1', '2'] });
    game.entranceDeck = ['17'];
    game.encounterDeck = ['25'];
    game.itemDeck = ['22'];
    game.itemDiscard = [];
    const found = enterRoom(game);
    found.players[0].items = ['22'];

    const used = reduce(found, { type: 'USE_ITEM', itemId: '22' }, ctx);
    const die = used.lastRoll.value;
    assert.ok(die >= 1 && die <= 6, 'a d6 came up a d6');
    assert.equal(used.lastRoll.source, 'the Dark Dice', 'and the state knows who rolled it');
    assert.match(used.log.join('\n'), new RegExp(`The die comes up ${die}\\.`));
    assert.equal(used.players[0].clues, die >= 4 ? 1 : 0, `Dark Dice on a ${die} is a token or nothing`);
    assert.equal(used.players[0].sanity, die <= 3 ? 5 : 6, `and Sanity on a ${die}`);
    assert.deepEqual(used.itemDiscard, ['22'], 'the card is spent whichever face came up');
    if (die >= 4) faces.token += 1;
    else faces.hurt += 1;
  }
  assert.ok(faces.token > 0 && faces.hurt > 0, 'both faces of Dark Dice were seen');

  // What is still waiting, and what it is waiting for.
  const waiting = createGame(ctx, { seed: 41, playerCount: 2, investigatorIds: ['1', '2'] });
  waiting.players[0].items = ['22', '9', '10', '13'];
  assert.match(useItemProblem(waiting, ctx, '9'), /no monster on or next to/);
  assert.match(useItemProblem(waiting, ctx, '10'), /no monster on or next to/);
  assert.match(useItemProblem(waiting, ctx, '13'), /needs a lock/);
  assert.equal(useItemProblem(waiting, ctx, '22') ?? null, null, 'Dark Dice is no longer waiting for dice');

  // No card in either deck still claims to be waiting on Health or Sanity.
  for (const card of Object.values(events)) {
    assert.ok(
      !card.needs.includes('health') && !card.needs.includes('sanity'),
      `event ${card.id} does not wait on a pool that exists`,
    );
  }
  for (const card of Object.values(items)) {
    assert.ok(
      !card.needs.includes('health') && !card.needs.includes('sanity'),
      `item ${card.id} does not wait on a pool that exists`,
    );
  }

  assert.equal(currentPlayer(healed).name, 'Clara Holt', 'the reader was a sheet');
}

/* ------------------------------------------------------------------ *
 * The Library of Azrel: spend 1 Clue to regain 1 Sanity
 * ------------------------------------------------------------------ */
{
  const rooms = ctx.rooms;
  assert.equal(rooms['library-of-azrel'].special, 'clue-for-sanity');
  assert.equal(rooms.foyer.special, 'clue-for-health', 'the Foyer mends the body');
  assert.equal(rooms.kitchen.special, null, 'an ordinary room has no special');
  assert.throws(
    () => roomsFromCsv('id,name,n,e,s,w,text,special\nx,X,1,1,1,1,,fly'),
    /not one of/,
  );

  const game = createGame(ctx, { seed: 5, playerCount: 2, investigatorIds: ['1', '2'] });
  const me = game.players[0];
  me.clues = 2;
  me.sanity = 3;
  // The Foyer: the same trade, for Health.
  assert.match(roomSpecialProblem(game, ctx), /full Health/, 'no Clue is wasted at full Health');
  me.health = 2;
  const mended = reduce(game, { type: 'ROOM_SPECIAL' }, ctx);
  assert.equal(mended.players[0].clues, 1, 'a Clue is spent in the Foyer');
  assert.equal(mended.players[0].health, 3, 'and a point of Health regained');
  assert.equal(mended.players[0].sanity, 3, 'but no Sanity');
  assert.equal(mended.actionsLeft, game.actionsLeft - 1, 'it takes an action');

  game.rooms['1,0'] = { roomId: 'kitchen', rot: 0 };
  me.pos = { gr: 4, gc: 1 };
  assert.match(roomSpecialProblem(game, ctx), /nothing special/, 'not in the Kitchen');

  game.rooms['0,1'] = { roomId: 'library-of-azrel', rot: 0 };
  me.pos = { gr: 1, gc: 4 };
  assert.equal(roomSpecialProblem(game, ctx), null);

  const read = reduce(game, { type: 'ROOM_SPECIAL' }, ctx);
  assert.equal(read.players[0].clues, 1, 'a Clue is spent');
  assert.equal(read.players[0].sanity, 4, 'and a point of Sanity regained');
  assert.equal(read.actionsLeft, game.actionsLeft - 1, 'it takes an action');

  const empty = structuredClone(game);
  empty.players[0].clues = 0;
  assert.match(roomSpecialProblem(empty, ctx), /no Clue/);
  const whole = structuredClone(game);
  whole.players[0].sanity = whole.players[0].sanityMax;
  assert.match(roomSpecialProblem(whole, ctx), /full Sanity/, 'no Clue is wasted at full Sanity');
}

/* ------------------------------------------------------------------ *
 * Traits
 * ------------------------------------------------------------------ */
{
  const seat = (ids, seed = 7) => createGame(ctx, { seed, playerCount: ids.length, investigatorIds: ids });
  // An Event card lying face up under the current investigator, ready to read.
  const eventUnderfoot = (game, eventId) => {
    const me = game.players[game.turnIndex];
    me.pos = { gr: 1, gc: 0 };
    game.encounters['1,0'] = {
      entranceId: '17', room: '0,0', number: 4, cardId: '19', type: 'event', faceUp: true,
    };
    game.eventDeck = [eventId];
    game.eventDiscard = [];
    game.actionsLeft = 2;
  };
  const monsterAt = (game, pos) => {
    game.monsters.push({ id: `t${game.nextMonster++}`, kind: 'card', name: 'Husk', health: 2, healthMax: 2, pos });
    return game.monsters.at(-1).id;
  };

  // Clara — Logical Detachment: the first Sanity an Event takes each round is ignored.
  let clara = seat(['1', '2']);
  eventUnderfoot(clara, '10');
  clara = reduce(clara, { type: 'INVESTIGATE' }, ctx);
  assert.equal(clara.players[0].sanity, 6, 'the first event loss of the round is ignored');
  assert.match(clara.log.join('\n'), /Logical Detachment/);
  eventUnderfoot(clara, '10');
  clara = reduce(clara, { type: 'INVESTIGATE' }, ctx);
  assert.equal(clara.players[0].sanity, 5, 'the second one in the same round is not');

  // Gideon — Steel Nerves: a failed Flee is rolled again, once a turn.
  let rerolled = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const game = seat(['2', '1'], seed);
    game.players[0].engaged = [monsterAt(game, { gr: 1, gc: 2 })];
    const after = reduce(game, { type: 'FLEE' }, ctx);
    const log = after.log.join('\n');
    if (/Steel Nerves/.test(log)) {
      rerolled += 1;
      assert.equal((log.match(/Steel Nerves/g) ?? []).length, 1, 'only one reroll');
    } else {
      assert.match(log, /— free\./, 'no reroll means the first roll escaped');
    }
  }
  assert.ok(rerolled > 0, 'a failed Flee was rerolled');

  // Lucille — Whispers from Beyond: an action to see the top Encounter card, once a round.
  const lucille = seat(['3', '1']);
  assert.equal(traitProblem(lucille, ctx), null);
  const heard = reduce(lucille, { type: 'USE_TRAIT' }, ctx);
  const top = lucille.encounterDeck.at(-1);
  assert.equal(heard.peek.cardId, top, 'she sees the card that will be drawn next');
  assert.equal(heard.encounterDeck.length, lucille.encounterDeck.length, 'and leaves it there');
  assert.equal(heard.actionsLeft, lucille.actionsLeft - 1, 'in place of an action');
  assert.match(traitProblem(heard, ctx), /already spoken this round/);

  // Dr. Graves — Field Medic: someone beside him who regains Health regains 1 more.
  const ward = seat(['1', '4']);
  ward.players[0].health = 1;
  ward.players[0].items = ['2']; // First Aid Kit: +1 Health
  ward.players[1].pos = { gr: 1, gc: 2 };
  const patched = reduce(ward, { type: 'USE_ITEM', itemId: '2' }, ctx);
  assert.equal(patched.players[0].health, 3, 'the kit and the doctor: +2');
  assert.match(patched.log.join('\n'), /Field Medic/);
  const alone = structuredClone(ward);
  alone.players[1].pos = { gr: 4, gc: 4 };
  assert.equal(reduce(alone, { type: 'USE_ITEM', itemId: '2' }, ctx).players[0].health, 2, 'not from afar');

  // Marion — Hunches: a free step after Investigating, once a turn.
  let marion = seat(['5', '1']);
  eventUnderfoot(marion, '12');
  marion = reduce(marion, { type: 'INVESTIGATE' }, ctx);
  assert.equal(marion.stepsLeft, 1, 'a free space of movement');
  assert.match(marion.log.join('\n'), /Hunches/);
  marion.stepsLeft = 0;
  eventUnderfoot(marion, '12');
  marion = reduce(marion, { type: 'INVESTIGATE' }, ctx);
  assert.equal(marion.stepsLeft, 0, 'only once a turn');

  // Silas — Bartered Insight: 2 Clues for 1 Sanity, as an action.
  const silas = seat(['6', '1']);
  silas.players[0].clues = 1;
  silas.players[0].sanity = silas.players[0].sanityMax - 2;
  assert.match(traitProblem(silas, ctx), /needs 2 Clues/);
  silas.players[0].clues = 3;
  const traded = reduce(silas, { type: 'USE_TRAIT' }, ctx);
  assert.equal(traded.players[0].clues, 1);
  assert.equal(traded.players[0].sanity, silas.players[0].sanity + 1);
  assert.equal(traded.actionsLeft, silas.actionsLeft - 1);

  // Clara has nothing to use as an action.
  assert.match(traitProblem(seat(['1', '2']), ctx), /no trait to use/);
}

console.log('INVESTIGATOR SHEETS OK');
