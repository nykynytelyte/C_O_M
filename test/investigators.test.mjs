/**
 * Investigator sheets: the six characters, their numbers, and how a seat is
 * filled from the deck.
 *
 * Run with: npm test
 */

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

import {
  createGame,
  reduce,
  currentPlayer,
  pendingOrientations,
  useItemProblem,
  investigatorsFromCsv,
  roomsFromCsv,
  entrancesFromCsv,
  encountersFromCsv,
  itemsFromCsv,
  eventsFromCsv,
} from '../engine.js';

const here = (relative) => new URL(relative, import.meta.url);

const scenario = JSON.parse(await readFile(here('../scenarios/mansion/scenario.json'), 'utf8'));
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
  assert.match(clara.traitNeeds, /Events that cost Sanity/, 'her trait says what it waits for');
  assert.match(clara.bio, /Harrowgate/, 'the back of the card is kept as well');

  const gideon = investigators['2'];
  assert.equal(gideon.health, 6, 'Gideon is the tougher one');
  assert.equal(gideon.sanity, 4, 'and the more brittle one');

  // No trait is allowed to pretend to work: every one of the six names the rule
  // it is still waiting for, in words a player can read.
  for (const sheet of Object.values(investigators)) {
    assert.ok(sheet.trait, `${sheet.name} has a trait`);
    assert.ok(sheet.traitText, `${sheet.name}'s trait is written out`);
    assert.ok(
      sheet.traitNeeds.length > 0,
      `${sheet.name}'s trait pretends to work without saying what is missing`,
    );
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

  // Zero is a floor, not a defeat: the rulebook has not said what happens at 0,
  // so the table is told and the investigator stays standing.
  const emptied = read(['11'], (game) => {
    game.players[0].sanity = 1;
  });
  assert.equal(emptied.players[0].sanity, 0, 'a two-point loss stops at zero');
  assert.match(
    emptied.log.join('\n'),
    /is at 0 Sanity\. Nothing in the base game knocks anyone out/,
    'zero is a floor, not a knockout',
  );
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
  waiting.players[0].items = ['22', '10', '13'];
  assert.match(useItemProblem(waiting, ctx, '10'), /needs a monster/);
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

console.log('INVESTIGATOR SHEETS OK');
