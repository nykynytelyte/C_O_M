/**
 * Headless rules check. This is the software equivalent of playtesting: it
 * plays many games as fast as it can and asserts that the rules never let the
 * state drift into something the table can never be in.
 *
 * Run with: npm test
 */

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

import {
  buildScenario,
  createGame,
  reduce,
  replay,
  roomsFromCsv,
  entrancesFromCsv,
  encountersFromCsv,
  eventsFromCsv,
  itemsFromCsv,
  legalDestinations,
  pendingOrientations,
  useItemProblem,
  currentPlayer,
  doorsAt,
  stepProblem,
  slotOf,
  localOf,
  roomKey,
  ROOM_SIZE,
} from '../engine.js';

const here = (relative) => new URL(relative, import.meta.url);

const core = JSON.parse(await readFile(here('../rules/core.json'), 'utf8'));
const scenario = buildScenario(
  core,
  JSON.parse(await readFile(here('../scenarios/nameless-presence/scenario.json'), 'utf8')),
);
const rooms = roomsFromCsv(await readFile(here('../decks/rooms.csv'), 'utf8'));
const entrances = entrancesFromCsv(
  await readFile(here('../decks/entrance.csv'), 'utf8'),
);
const encounterCards = encountersFromCsv(
  await readFile(here('../decks/encounters.csv'), 'utf8'),
);
const items = itemsFromCsv(await readFile(here('../decks/items.csv'), 'utf8'));
const events = eventsFromCsv(await readFile(here('../decks/events.csv'), 'utf8'));
const ctx = { scenario, rooms, entrances, encounterCards, items, events };
const TOTAL_ENTRANCES = Object.keys(entrances).length;
const TOTAL_ENCOUNTERS = Object.keys(encounterCards).length;
const TOTAL_ITEMS = Object.keys(items).length;
const TOTAL_EVENTS = Object.keys(events).length;

const TOTAL_ROOMS = Object.keys(rooms).length;
const DIR_KEYS = ['n', 'e', 's', 'w'];
const MIDDLE = 1;

/** Deterministic action chooser, independent of the engine's own RNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function openings(room, rot) {
  const doors = doorsAt(room, rot);
  return DIR_KEYS.reduce((n, dir) => n + doors[dir].filter(Boolean).length, 0);
}

const STEPS = [
  { dr: -1, dc: 0 },
  { dr: 0, dc: 1 },
  { dr: 1, dc: 0 },
  { dr: 0, dc: -1 },
];

/** The square just inside a doorway, and the square beyond it. */
function doorway(slotR, slotC, dir, along) {
  const inside =
    dir === 'n'
      ? { gr: slotR * ROOM_SIZE, gc: slotC * ROOM_SIZE + along }
      : dir === 's'
        ? { gr: slotR * ROOM_SIZE + 2, gc: slotC * ROOM_SIZE + along }
        : dir === 'e'
          ? { gr: slotR * ROOM_SIZE + along, gc: slotC * ROOM_SIZE + 2 }
          : { gr: slotR * ROOM_SIZE + along, gc: slotC * ROOM_SIZE };
  const delta = { n: [-1, 0], e: [0, 1], s: [1, 0], w: [0, -1] }[dir];
  return { inside, outside: { gr: inside.gr + delta[0], gc: inside.gc + delta[1] } };
}

function checkInvariants(state, label) {
  const placed = Object.values(state.rooms);
  const placedIds = placed.map((entry) => entry.roomId);

  assert.equal(new Set(placedIds).size, placedIds.length, `${label}: a room was placed twice`);

  const inHand = state.pending ? 1 : 0;
  assert.equal(
    placedIds.length + state.roomDeck.length + inHand,
    TOTAL_ROOMS,
    `${label}: room cards were lost or duplicated`,
  );

  const all = [...placedIds, ...state.roomDeck, ...(state.pending ? [state.pending.roomId] : [])];
  assert.equal(new Set(all).size, TOTAL_ROOMS, `${label}: the deck and the table disagree`);

  for (const entry of placed) {
    assert.ok(entry.rot >= 0 && entry.rot < 4, `${label}: rotation outside 0-3`);
    assert.ok(openings(rooms[entry.roomId], entry.rot) > 0, `${label}: a room with no openings`);
  }

  // Item cards are only ever in four places: the deck, the discard pile,
  // someone's hand, and face up in a room under a card that said Item. Nothing
  // may evaporate when a card is taken or spent.
  const heldItems = state.players.reduce((n, player) => n + (player.items ?? []).length, 0);
  const lyingItems = Object.values(state.encounters).filter((marker) => marker.itemId).length;
  assert.equal(
    state.itemDeck.length + state.itemDiscard.length + heldItems + lyingItems,
    TOTAL_ITEMS,
    `${label}: item cards were lost or duplicated`,
  );

  // An event is never held: it is in the deck or in the discard pile, nowhere else.
  assert.equal(
    state.eventDeck.length + state.eventDiscard.length,
    TOTAL_EVENTS,
    `${label}: event cards were lost or duplicated`,
  );

  // A player is allowed to be one step into the unknown while the card they
  // drew is still being turned: that square is about to become a room.
  const pendingSlot = state.pending ? slotOf(state.pending.at) : null;

  for (const player of state.players) {
    const slot = slotOf(player.pos);
    const here = state.rooms[roomKey(slot.R, slot.C)];
    const awaitingCard =
      pendingSlot &&
      pendingSlot.R === slot.R &&
      pendingSlot.C === slot.C &&
      state.pending.playerId === player.id;
    assert.ok(here || awaitingCard, `${label}: ${player.name} stands in unexplored space`);

    const local = localOf(player.pos);
    assert.ok(
      local.r >= 0 && local.r < ROOM_SIZE && local.c >= 0 && local.c < ROOM_SIZE,
      `${label}: ${player.name} is off the card`,
    );
  }

  const foyer = placed.find((entry) => entry.roomId === scenario.startRoom);
  assert.ok(foyer, `${label}: the foyer vanished`);
  assert.equal(foyer.rot, 0, `${label}: the foyer turned`);

  assert.ok(
    state.shiftPressure >= 0 &&
      state.shiftPressure < (state.shift.ladder ?? [5, 4, 3, 2, 1, 0]).length,
    `${label}: the shift bar slid off the end of its ladder`,
  );

  // Every encounter card on the table has to lie on the floor of a room that is
  // actually there, and the entrance deck has to account for all of its cards.
  for (const [key, marker] of Object.entries(state.encounters)) {
    const [gr, gc] = key.split(',').map(Number);
    const slot = slotOf({ gr, gc });
    const placed = state.rooms[roomKey(slot.R, slot.C)];
    assert.ok(placed, `${label}: an encounter card lies in a room that was never placed`);
    assert.equal(
      marker.room,
      roomKey(slot.R, slot.C),
      `${label}: an encounter card belongs to a different room than the square it is on`,
    );
    const local = localOf({ gr, gc });
    assert.equal(
      marker.number,
      local.r * ROOM_SIZE + local.c + 1,
      `${label}: an encounter card's square number disagrees with where it lies`,
    );
  }
  assert.equal(
    state.entranceDeck.length + state.entranceSeen.length,
    TOTAL_ENTRANCES,
    `${label}: room entrance cards were lost or duplicated`,
  );
  // An encounter card is in the deck, in the discard pile, or lying on a square
  // of a room: it is dealt when it is laid down, so a face-down card is already
  // a particular card and has to be accounted for while it lies there.
  const lyingIds = Object.values(state.encounters)
    .map((marker) => marker.cardId)
    .filter(Boolean);
  assert.equal(
    state.encounterDeck.length + state.encounterDiscard.length + lyingIds.length,
    // The printed deck, plus the extra Clue cards the rules add for each player.
    TOTAL_ENCOUNTERS + (scenario.encounters.extraCluesPerPlayer ?? 0) * state.players.length,
    `${label}: encounter cards were lost or duplicated`,
  );
  assert.equal(
    new Set(lyingIds).size,
    lyingIds.length,
    `${label}: one encounter card lies in two places at once`,
  );
  for (const marker of Object.values(state.encounters)) {
    assert.ok(marker.cardId, `${label}: an encounter card lies on a square with nothing under it`);
    assert.ok(
      !marker.faceUp || marker.type,
      `${label}: a face-up encounter card does not say what it is`,
    );
    assert.ok(
      marker.faceUp || marker.type === null,
      `${label}: a face-down encounter card gives its kind away`,
    );
  }

  assert.ok(state.log.length <= 400, `${label}: log grew without bound`);
}

/* ------------------------------------------------------------------ *
 * Card data
 * ------------------------------------------------------------------ */

{
  // A door is either there or it is not, and it is never anywhere but the
  // middle of its side. The reader has to be strict or a typo silently produces
  // an unplayable card.
  assert.throws(
    () => roomsFromCsv('id,name,n,e,s,w,text\nx,X,2,0,0,0,'),
    /expected 1 for a door or 0 for a wall/,
  );
  assert.throws(
    () => roomsFromCsv('id,name,n,e,s,w,text\nx,X,101,0,0,0,'),
    /expected 1 for a door or 0 for a wall/,
  );
  assert.throws(
    () => roomsFromCsv('id,name,n,e,s,w,text\nx,X,0,0,0,0,'),
    /no doors at all/,
  );
  assert.throws(
    () => roomsFromCsv('id,name,n,e,s,w,text\nx,X,1,0,0,0,\nx,X,1,0,0,0,'),
    /duplicate id/,
  );
  assert.throws(
    () => roomsFromCsv('id,name,n,e,s,w,text\nx,X,1,0,0,0,\ny,X,1,0,0,0,'),
    /two rooms called/,
  );

  // 1 and 010 mean the same thing, and both mean a door in the middle.
  const aliased = roomsFromCsv('id,name,n,e,s,w,text\na,A,1,0,0,0,\nb,B,010,000,000,000,');
  assert.deepEqual(doorsAt(aliased.a, 0).n, [false, true, false]);
  assert.deepEqual(doorsAt(aliased.b, 0).n, [false, true, false]);
  assert.deepEqual(doorsAt(aliased.a, 0).e, [false, false, false]);
}

/* ------------------------------------------------------------------ *
 * The deck as it is actually made up
 * ------------------------------------------------------------------ */

{
  assert.equal(TOTAL_ROOMS, 20, 'the room list has twenty rooms');
  for (const id of ['foyer', 'library-of-azrel', 'rift-room', 'servants-quarters']) {
    assert.ok(rooms[id], `the deck is missing ${id}`);
  }

  // A door at 2, 4, 6 or 8 is a door in the middle of the north, east, south or
  // west side. The counts below are the ones a player would count on the card.
  const sides = (id) => DIR_KEYS.map((dir) => doorsAt(rooms[id], 0)[dir][MIDDLE]);
  assert.deepEqual(sides('foyer'), [true, true, true, true], 'the Foyer opens all four ways');
  assert.deepEqual(sides('study'), [true, true, false, false], 'Study: doors at 2 and 4');
  assert.deepEqual(sides('gallery'), [true, false, true, false], 'Gallery: doors at 2 and 6');
  assert.deepEqual(sides('sitting-room'), [true, false, false, true], 'Sitting Room: 2 and 8');
  assert.deepEqual(sides('vault'), [false, true, false, true], 'Vault: 4 and 8');
  assert.deepEqual(sides('conservatory'), [false, true, true, true], 'Conservatory: 4, 6, 8');
  assert.deepEqual(sides('kitchen'), [true, true, true, false], 'Kitchen: 2, 4, 6');

  // The Rift Room is not shuffled. It goes to the bottom, so the house cannot
  // open it early, and it turns up when the deck is nearly spent.
  const state = createGame(ctx, { seed: 12, playerCount: 2 });
  assert.equal(state.roomDeck.length, TOTAL_ROOMS - 1, 'every room but the Foyer is in the deck');
  assert.equal(state.roomDeck[0], scenario.bossRoom, 'the Rift Room is at the bottom');
  assert.equal(
    state.roomDeck.filter((id) => id === scenario.bossRoom).length,
    1,
    'the Rift Room is in the deck exactly once',
  );
  assert.equal(state.roomDeck.at(-1) === scenario.bossRoom, false, 'it is not the next card drawn');
}

/* ------------------------------------------------------------------ *
 * Turning a card
 * ------------------------------------------------------------------ */

{
  const card = {
    doors: {
      n: [false, true, false],
      e: [false, true, false],
      s: [false, false, false],
      w: [false, false, false],
    },
  };

  const at0 = doorsAt(card, 0);
  assert.equal(at0.n[MIDDLE], true);
  assert.equal(at0.e[MIDDLE], true);
  assert.equal(at0.s[MIDDLE], false);

  // A quarter clockwise carries each door onto the next side round, still in
  // the middle. That is the whole of the shift mechanic.
  const at1 = doorsAt(card, 1);
  assert.equal(at1.e[MIDDLE], true, 'north became east');
  assert.equal(at1.s[MIDDLE], true, 'east became south');
  assert.equal(at1.n.some(Boolean), false);
  assert.equal(at1.w.some(Boolean), false);

  const at2 = doorsAt(card, 2);
  assert.equal(at2.s[MIDDLE], true);
  assert.equal(at2.w[MIDDLE], true);

  const at3 = doorsAt(card, 3);
  assert.equal(at3.w[MIDDLE], true);
  assert.equal(at3.n[MIDDLE], true);

  // Four turns come back to the start.
  for (const real of Object.values(rooms)) {
    assert.deepEqual(doorsAt(real, 4), doorsAt(real, 0), `${real.name} did not come back round`);
    assert.ok(openings(real, 0) > 0);

    // And every card can be turned to face any side, which is why a drawn card
    // is never unplaceable: two middles always line up.
    for (const dir of DIR_KEYS) {
      assert.ok(
        [0, 1, 2, 3].some((rot) => doorsAt(real, rot)[dir][MIDDLE]),
        `${real.name} cannot be turned to face ${dir}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Walking and placing
 * ------------------------------------------------------------------ */

{
  const state = createGame(ctx, { seed: 7, playerCount: 2 });
  assert.equal(state.round, 1);
  assert.equal(state.actionsLeft, scenario.turn.actionsPerTurn);
  assert.deepEqual(currentPlayer(state).pos, { gr: 1, gc: 1 }, 'the middle of the foyer');

  // Walking inside the foyer spends a step and nothing else.
  const inside = reduce(state, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
  assert.equal(inside.pending, null, 'moving inside a room draws no card');
  assert.equal(inside.stepsLeft, 1);
  assert.equal(inside.actionsLeft, 1);

  // Stepping off the edge of the card draws a room, which has to be turned.
  const out = reduce(inside, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
  assert.ok(out.pending, 'leaving the foyer should pause for a placement');
  assert.equal(out.actionsLeft, 1, 'the whole move is one action');
  assert.equal(out.stepsLeft, 0, 'both steps are spent');

  assert.throws(() => reduce(out, { type: 'END_TURN' }, ctx), /place the drawn room/i);
  assert.throws(
    () => reduce(out, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx),
    /place the drawn room/i,
  );

  const drawn = out.pending.roomId;
  const valid = pendingOrientations(out, ctx);
  assert.ok(valid.length >= 1, 'the drawn card can always be turned to face the way you came in');

  // A card with doors on opposite sides has two turns that both work. What has
  // to hold is that the offered list is exactly the turns putting a door on the
  // side the investigator entered through.
  for (let rot = 0; rot < 4; rot++) {
    assert.equal(
      valid.includes(rot),
      doorsAt(rooms[drawn], rot).s[MIDDLE],
      `turn ${rot} of the ${rooms[drawn].name} was judged wrongly`,
    );
  }

  for (const rot of [0, 1, 2, 3].filter((r) => !valid.includes(r))) {
    assert.throws(
      () => reduce(out, { type: 'PLACE_ROOM', orient: rot }, ctx),
      /has no door on its south side/,
    );
  }

  const placed = reduce(out, { type: 'PLACE_ROOM', orient: valid[0] }, ctx);
  assert.equal(placed.pending, null);
  assert.equal(placed.rooms[roomKey(-1, 0)].roomId, drawn);
  assert.deepEqual(currentPlayer(placed).pos, { gr: -1, gc: 1 });
  checkInvariants(placed, 'placement');
}

{
  const state = createGame(ctx, { seed: 11, playerCount: 2 });
  const start = currentPlayer(state).pos;

  // Diagonals and jumps are refused; a move cannot exceed the allowance.
  assert.throws(
    () => reduce(state, { type: 'MOVE', path: [{ gr: start.gr + 1, gc: start.gc + 1 }] }, ctx),
    /does not share an edge/,
  );
  assert.throws(
    () => reduce(state, { type: 'MOVE', path: [{ gr: start.gr - 3, gc: start.gc }] }, ctx),
    /does not share an edge/,
  );
  assert.throws(
    () =>
      reduce(
        state,
        {
          type: 'MOVE',
          path: [
            { gr: 0, gc: 1 },
            { gr: 0, gc: 2 },
            { gr: 0, gc: 3 },
          ],
        },
        ctx,
      ),
    /only 2 more spaces/,
  );
  assert.throws(() => reduce(state, { type: 'WANDER' }, ctx), /unknown action/);
  assert.throws(() => reduce(state, {}, ctx), /must have a type/);

  // Two turns end a round with two investigators.
  const once = reduce(state, { type: 'END_TURN' }, ctx);
  assert.equal(currentPlayer(once).id, 'p2');
  const twice = reduce(once, { type: 'END_TURN' }, ctx);
  assert.equal(round(twice), 2);
  assert.equal(currentPlayer(twice).id, 'p1');
}

function round(state) {
  return state.round;
}

/* ------------------------------------------------------------------ *
 * A door is the middle of a side, and nothing else
 * ------------------------------------------------------------------ */

{
  const state = createGame(ctx, { seed: 3, playerCount: 1 });
  const west = reduce(state, { type: 'MOVE', path: [{ gr: 1, gc: 0 }] }, ctx);
  const out = reduce(west, { type: 'MOVE', path: [{ gr: 1, gc: -1 }] }, ctx);
  assert.ok(out.pending);

  const placed = reduce(
    out,
    { type: 'PLACE_ROOM', orient: pendingOrientations(out, ctx)[0] },
    ctx,
  );
  const entry = placed.rooms[roomKey(0, -1)];
  const doors = doorsAt(rooms[entry.roomId], entry.rot);

  // The doorway the player came through must be open on the new card.
  assert.equal(doors.e[MIDDLE], true, 'the new room opens back towards the foyer');
  assert.equal(doorsAt(rooms.foyer, 0).w[MIDDLE], true, 'and the foyer is open there too');

  // The two corners of that side are wall even though the side has a door: you
  // have to reach the middle of the side to get through.
  for (const along of [0, 2]) {
    const { inside, outside } = doorway(0, -1, 'e', along);
    assert.match(
      stepProblem(placed, inside, outside, ctx),
      /opens east only at the middle of that side/,
    );
  }

  // The middle square is the way through.
  const { inside, outside } = doorway(0, -1, 'e', MIDDLE);
  assert.equal(stepProblem(placed, inside, outside, ctx), null);

  checkInvariants(placed, 'doorway');
}

{
  // Every square of every placed room has to agree with its card: wall where
  // there is no door, wall at the ends of a side, open only at the middle.
  let state = createGame(ctx, { seed: 21, playerCount: 2 });

  for (let turn = 0; turn < 14; turn++) {
    if (state.pending) {
      state = reduce(
        state,
        { type: 'PLACE_ROOM', orient: pendingOrientations(state, ctx)[0] },
        ctx,
      );
    }
    const destinations = legalDestinations(state, ctx);
    const intoDark = destinations.find(
      (d) => !state.rooms[roomKey(slotOf(d.pos).R, slotOf(d.pos).C)],
    );
    const choice = intoDark ?? destinations[Math.floor(destinations.length / 2)];
    if (choice) state = reduce(state, { type: 'MOVE', path: choice.path }, ctx);
    if (state.pending) {
      state = reduce(
        state,
        { type: 'PLACE_ROOM', orient: pendingOrientations(state, ctx)[0] },
        ctx,
      );
    }
    state = reduce(state, { type: 'END_TURN' }, ctx);
  }

  assert.ok(Object.keys(state.rooms).length > 2, 'the walk should have opened rooms');

  for (const [id, entry] of Object.entries(state.rooms)) {
    const [R, C] = id.split(',').map(Number);
    const card = rooms[entry.roomId];
    const doors = doorsAt(card, entry.rot);

    for (const dir of DIR_KEYS) {
      for (let along = 0; along < ROOM_SIZE; along++) {
        const { inside, outside } = doorway(R, C, dir, along);
        const problem = stepProblem(state, inside, outside, ctx);

        if (along !== MIDDLE) {
          assert.ok(problem, `${card.name} let a step through the wall beside a door`);
        } else if (!doors[dir][MIDDLE]) {
          assert.match(
            problem,
            /no door on its \w+ side/,
            `${card.name} opened where it has no door`,
          );
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Exploration never walks through the unknown
 * ------------------------------------------------------------------ */

{
  const state = createGame(ctx, { seed: 42, playerCount: 1 });

  for (const dest of legalDestinations(state, ctx)) {
    let from = currentPlayer(state).pos;
    for (const step of dest.path) {
      assert.equal(stepProblem(state, from, step, ctx), null, 'a planned path took an illegal step');
      from = step;
    }

    const firstSlot = slotOf(dest.path[0]);
    const beyond = !state.rooms[roomKey(firstSlot.R, firstSlot.C)];
    assert.ok(!(beyond && dest.path.length > 1), 'a move may not plan through unexplored space');
  }

  // The foyer is the hub: a door in the middle of all four sides, so a card can
  // always meet it from any direction.
  const foyer = doorsAt(rooms.foyer, 0);
  for (const dir of DIR_KEYS) {
    assert.equal(foyer[dir][MIDDLE], true, `the foyer should open ${dir}`);
    assert.equal(foyer[dir].filter(Boolean).length, 1, 'one door, in the middle');
  }
}

/* ------------------------------------------------------------------ *
 * The shift
 * ------------------------------------------------------------------ */

{
  // p1 opens the room north of the foyer, walks back into the foyer, and waits
  // there. p2 stands inside the new room. Whatever the die does, the room beside
  // the roller is the one that turns, and p2 has to turn with it.
  let state = createGame(ctx, { seed: 5, playerCount: 2 });
  state = reduce(state, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
  state = reduce(state, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
  state = reduce(
    state,
    { type: 'PLACE_ROOM', orient: pendingOrientations(state, ctx)[0] },
    ctx,
  );
  state = reduce(state, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx); // p1 back out
  state = reduce(state, { type: 'END_TURN' }, ctx);
  state = reduce(
    state,
    { type: 'MOVE', path: [{ gr: 0, gc: 1 }, { gr: -1, gc: 1 }] },
    ctx,
  ); // p2 in
  state = reduce(state, { type: 'END_TURN' }, ctx);

  const before = state.rooms[roomKey(-1, 0)].rot;
  let state2 = state;
  let shifted = null;

  for (let r = 0; r < 60 && !shifted; r++) {
    state2 = reduce(state2, { type: 'END_TURN' }, ctx); // p1 in the foyer ends the round
    state2 = reduce(state2, { type: 'END_TURN' }, ctx); // p2 in the new room
    // An even round is rolled by p2, whose only neighbour is the foyer, and the
    // foyer never turns — so wait for a shift that had something to turn.
    if (state2.lastShift?.occurred && state2.lastShift.rotated.length > 0) {
      shifted = state2.lastShift;
    }
  }

  assert.ok(shifted, 'a shift should have happened within sixty rounds');
  assert.equal(
    state2.rooms[roomKey(-1, 0)].rot,
    (before + 1) % 4,
    'the room next to the roller turns a quarter',
  );
  assert.equal(state2.rooms[roomKey(0, 0)].rot, 0, 'the foyer never turns');

  // The investigator inside the turning room turned with it, and is still in it.
  const slot = slotOf(state2.players[1].pos);
  assert.equal(slot.R, -1, 'a turning room may not throw its occupant out');
  assert.equal(slot.C, 0);

  checkInvariants(state2, 'shift');
}

/* ------------------------------------------------------------------ *
 * The shift bar slides
 * ------------------------------------------------------------------ */

{
  // The rulebook's Method A: 5+ to begin with, each failed roll adds a Shift
  // Point to the next one — so 4+, 3+, 2+ — and the fifth round shifts on its own.
  assert.deepEqual(
    scenario.shift.ladder,
    [4, 3, 2, 1, 0],
    'the shift bar should start at 5+ and drop one a round',
  );

  let caseA = null;
  for (let seed = 1; seed <= 4000 && !caseA; seed++) {
    let state = createGame(ctx, { seed, playerCount: 2 });
    const shifts = [];
    for (let round = 0; round < 5; round++) {
      state = reduce(state, { type: 'END_TURN' }, ctx);
      state = reduce(state, { type: 'END_TURN' }, ctx);
      shifts.push({ ...state.lastShift });
    }
    if (shifts.slice(0, 4).every((shift) => !shift.occurred)) caseA = { state, shifts };
  }

  assert.ok(caseA, 'some game should stand still for four rounds, to see the whole bar');
  assert.deepEqual(
    caseA.shifts.map((shift) => shift.needed),
    [5, 4, 3, 2, null],
    'the bar must slide 5+, 4+, 3+, 2+, then automatic',
  );
  for (const shift of caseA.shifts.slice(0, 4)) {
    assert.ok(shift.roll >= 1 && shift.roll <= 6, 'a shift roll is a d6');
    assert.ok(shift.roll < shift.needed, `a roll of ${shift.roll} must not beat ${shift.needed}+`);
  }
  assert.equal(caseA.shifts[4].occurred, true, 'the fifth round must shift of its own accord');
  assert.equal(caseA.shifts[4].roll, null, 'an automatic shift is not rolled');

  // A shift of any kind puts the bar straight back to the top.
  let after = reduce(caseA.state, { type: 'END_TURN' }, ctx);
  after = reduce(after, { type: 'END_TURN' }, ctx);
  assert.equal(after.lastShift.needed, 5, 'a shift must reset the bar to 5+');
}

{
  // The die goes round the table one player a round, so nobody rolls twice
  // running at a two-player table.
  let state = createGame(ctx, { seed: 3, playerCount: 3 });
  const rollers = [];
  for (let round = 0; round < 3; round++) {
    for (let turn = 0; turn < 3; turn++) state = reduce(state, { type: 'END_TURN' }, ctx);
    rollers.push(state.lastShift.roller);
  }
  assert.deepEqual(rollers, ['p1', 'p2', 'p3'], 'the die should not stay with one player');
}

/* ------------------------------------------------------------------ *
 * One new room a turn
 * ------------------------------------------------------------------ */

{
  const start = reduce(
    createGame(ctx, { seed: 7, playerCount: 1 }),
    { type: 'MOVE', path: [{ gr: 0, gc: 1 }] },
    ctx,
  );
  const from = { gr: 0, gc: 1 };
  const into = { gr: -1, gc: 1 };

  assert.equal(
    stepProblem(start, from, into, ctx),
    null,
    'the dark should be open before the turn has drawn a room',
  );

  const spent = { ...start, drewThisTurn: true };
  assert.match(
    stepProblem(spent, from, into, ctx),
    /already opened a new room this turn/,
    'a second new room in the same turn must be refused',
  );
  assert.deepEqual(
    legalDestinations(spent, ctx).filter((dest) => {
      const slot = slotOf(dest.pos);
      return !spent.rooms[roomKey(slot.R, slot.C)];
    }),
    [],
    'no unexplored space may be offered once the turn has drawn a room',
  );

  // The limit belongs to the turn, not to the game.
  let state = reduce(start, { type: 'MOVE', path: [into] }, ctx);
  assert.equal(state.drewThisTurn, true, 'stepping into the dark is the turn\'s one new room');
  state = reduce(
    state,
    { type: 'PLACE_ROOM', orient: pendingOrientations(state, ctx)[0] },
    ctx,
  );
  assert.equal(state.drewThisTurn, true, 'placing the card does not hand the room back');
  state = reduce(state, { type: 'END_TURN' }, ctx);
  assert.equal(state.drewThisTurn, false, 'a new turn may open a new room');
}

/* ------------------------------------------------------------------ *
 * Playthroughs
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Room entrance cards
 * ------------------------------------------------------------------ */

{
  assert.equal(TOTAL_ENTRANCES, 30, 'the room entrance deck has thirty cards');
  for (let n = 1; n <= 30; n++) assert.ok(entrances[String(n)], `entrance card ${n} is missing`);

  for (const card of Object.values(entrances)) {
    assert.ok(card.text.length > 0, `entrance card ${card.id} has no wording`);
    if (card.placement.kind === 'fixed') {
      assert.equal(
        card.placement.spaces.length,
        card.draw,
        `card ${card.id} draws and places different numbers of cards`,
      );
    }
  }

  // Only the empty rooms, and the card that turns an existing card over instead,
  // put nothing new on the floor.
  const placeNothing = Object.values(entrances)
    .filter((card) => card.draw === 0)
    .map((card) => Number(card.id))
    .sort((a, b) => a - b);
  assert.deepEqual(placeNothing, [20, 25, 26, 27], 'the cards that place nothing');

  // A typo has to fail loudly, or a mistyped card silently does nothing.
  const head = 'id,draw,face,placement,special,text\n';
  assert.throws(() => entrancesFromCsv(head + '1,1,down,space:12,,'), /squares are 1-9/);
  assert.throws(() => entrancesFromCsv(head + '1,1,sideways,space:5,,'), /up or down/);
  assert.throws(
    () => entrancesFromCsv(head + '1,1,down,next-to-you,,'),
    /not something the table can do/,
  );
  assert.throws(() => entrancesFromCsv(head + '1,1,down,space:5,flip:whenever,'), /not one of/);
  assert.throws(() => entrancesFromCsv(head + '1,1,down,space:5,make-tea,'), /unknown instruction/);
  assert.throws(
    () => entrancesFromCsv(head + '1,2,down,space:5,,'),
    /draws 2 card\(s\) but names 1/,
  );
}

{
  const squareOf = (R, C, n) => ({
    gr: R * ROOM_SIZE + Math.floor((n - 1) / ROOM_SIZE),
    gc: C * ROOM_SIZE + ((n - 1) % ROOM_SIZE),
  });
  const awayFrom = (entry, R, C, n) => {
    const pos = squareOf(R, C, n);
    return Math.abs(pos.gr - entry.gr) + Math.abs(pos.gc - entry.gc);
  };

  const seen = new Set();
  let roundFlip = null;
  let besideFlip = null;

  for (let seed = 1; seed <= 30 && seen.size < TOTAL_ENTRANCES; seed++) {
    const rand = mulberry32(seed * 13 + 5);
    let state = createGame(ctx, { seed, playerCount: 2 });

    for (let step = 0; step < 240; step++) {
      if (state.pending) {
        const valid = pendingOrientations(state, ctx);
        state = reduce(
          state,
          { type: 'PLACE_ROOM', orient: valid[Math.floor(rand() * valid.length)] },
          ctx,
        );
        checkInvariants(state, `entrance seed ${seed}`);

        const resolved = state.lastEntrance;
        if (resolved) {
          const card = entrances[resolved.id];
          const label = `seed ${seed} card ${card.id}`;
          const [R, C] = resolved.slot.split(',').map(Number);
          seen.add(card.id);

          // One card in the deck says to lay another if the first is a monster;
          // that is the only way an entrance card places more than its draw says.
          // It can also place fewer, because there are only 30 encounter cards in
          // the house and every one lying on a square is out of the deck until it
          // is taken up.
          const short = resolved.numbers.length < card.draw;
          if (short) {
            assert.match(
              state.log.join('\n'),
              /The encounter deck is spent, so no card can be laid/,
              `${label}: placed ${resolved.numbers.length} of ${card.draw} cards with cards to spare`,
            );
          } else if (resolved.numbers.length !== card.draw) {
            const firstAt = squareOf(R, C, resolved.numbers[0]);
            const first = state.encounters[`${firstAt.gr},${firstAt.gc}`];
            assert.equal(
              resolved.numbers.length,
              card.draw + 1,
              `${label}: placed ${resolved.numbers.length} of ${card.draw} cards`,
            );
            assert.equal(first?.type, 'monster', `${label}: an extra card without a monster`);
            assert.deepEqual(
              resolved.numbers.slice(card.draw),
              [2],
              `${label}: the extra card belongs on [2]`,
            );
          }
          assert.equal(
            new Set(resolved.numbers).size,
            resolved.numbers.length,
            `${label}: two cards on one square`,
          );

          for (const n of resolved.numbers) {
            const where = squareOf(R, C, n);
            const marker = state.encounters[`${where.gr},${where.gc}`];
            if (!marker) {
              // Laid face up it is answered at once, and a Clue or a Nothing is
              // replaced by nothing at all: the square is empty afterwards. Only
              // a card with an unseen face can still be lying there.
              assert.equal(
                card.face,
                'up',
                `${label}: the card says [${n}] but nothing lies there`,
              );
              continue;
            }
            assert.equal(marker.entranceId, card.id, `${label}: the wrong card is on the table`);
            assert.equal(marker.faceUp, card.face === 'up', `${label}: the card faces the wrong way`);
            assert.equal(marker.room, resolved.slot, `${label}: the card belongs to another room`);
          }

          if (!short && card.placement.kind === 'fixed') {
            assert.deepEqual(
              resolved.numbers.slice(0, card.draw),
              card.placement.spaces,
              `${label}: placed on the wrong squares`,
            );
          }
          if (card.placement.kind === 'corners') {
            for (const n of resolved.numbers) {
              assert.ok([1, 3, 7, 9].includes(n), `${label}: [${n}] is not a corner`);
            }
          }
          if (card.placement.kind === 'edges') {
            for (const n of resolved.numbers) {
              assert.ok([2, 4, 6, 8].includes(n), `${label}: [${n}] is not an edge square`);
            }
          }
          if (card.placement.kind === 'nearest') {
            for (const n of resolved.numbers) {
              assert.equal(
                awayFrom(resolved.entry, R, C, n),
                1,
                `${label}: [${n}] is not next to the doorway`,
              );
            }
          }
          if (card.placement.kind === 'farthest') {
            for (const n of resolved.numbers) {
              assert.equal(
                awayFrom(resolved.entry, R, C, n),
                3,
                `${label}: [${n}] is not the far corner of the room`,
              );
            }
          }

          const key = resolved.placed[0];
          const marker = key ? state.encounters[key] : null;
          if (marker?.flip === 'end-of-next-round' && !roundFlip) {
            roundFlip = { state: structuredClone(state), entranceId: card.id };
          }
          if (marker?.flip === 'end-turn-adjacent' && !besideFlip) {
            besideFlip = { state: structuredClone(state), entranceId: card.id };
          }
        }
        continue;
      }

      if (state.actionsLeft > 0 && rand() < 0.85) {
        const destinations = legalDestinations(state, ctx);
        if (destinations.length > 0) {
          state = reduce(
            state,
            { type: 'MOVE', path: destinations[Math.floor(rand() * destinations.length)].path },
            ctx,
          );
          continue;
        }
      }

      state = reduce(state, { type: 'END_TURN' }, ctx);
      if (state.round > 30) break;
    }
  }

  assert.equal(
    seen.size,
    TOTAL_ENTRANCES,
    `only ${seen.size} of ${TOTAL_ENTRANCES} entrance cards were ever drawn`,
  );

  // "Flip it face up at the end of the next round."
  assert.ok(roundFlip, 'no card timed to the end of a round was ever drawn');
  {
    let state = roundFlip.state;
    // A Monster stays on its square once it is turned, so the card can still be
    // found afterwards; a Clue or a Nothing would have been taken away.
    state.encounterDeck = ['1'];
    for (let i = 0; i < 40; i++) state = reduce(state, { type: 'END_TURN' }, ctx);
    const found = Object.values(state.encounters).find(
      (marker) => marker.entranceId === roundFlip.entranceId,
    );
    assert.ok(found, 'the card is still on the table');
    assert.equal(found.faceUp, true, 'a card timed to the end of a round must turn over');
  }

  // "Flip it if a player ends their turn next to it."
  assert.ok(besideFlip, 'no card timed to a turn ending beside it was ever drawn');
  {
    let state = besideFlip.state;
    // Again a Monster, so the card is still on the table after it turns.
    state.encounterDeck = ['1'];
    const [key, marker] = Object.entries(state.encounters).find(
      ([, m]) => m.entranceId === besideFlip.entranceId,
    );
    assert.equal(marker.faceUp, false, 'the card starts face down');

    // Stand the investigator next to it, inside the same room.
    const [R, C] = marker.room.split(',').map(Number);
    const square = squareOf(R, C, marker.number);
    const local = { r: square.gr - R * ROOM_SIZE, c: square.gc - C * ROOM_SIZE };
    const stand = { r: local.r, c: local.c === 0 ? 1 : local.c - 1 };
    state.players[state.turnIndex].pos = {
      gr: R * ROOM_SIZE + stand.r,
      gc: C * ROOM_SIZE + stand.c,
    };
    assert.notEqual(marker.faceUp, true, 'standing beside it is not enough on its own');

    state = reduce(state, { type: 'END_TURN' }, ctx);
    const after = state.encounters[key];
    assert.ok(after, 'the card has not moved');
    assert.equal(after.faceUp, true, 'ending a turn beside it must turn it over');
  }
}

{
  // "Mark 1 Shift Point." A point pulls the bar down one step, which is the same
  // step a quiet round would have pulled it down, so the house turns a round
  // sooner — and the round-end roll has to see the lower bar.
  let state = createGame(ctx, { seed: 11, playerCount: 2 });
  assert.equal(state.shiftPressure, 0, 'the bar starts at the top');

  state.entranceDeck = ['24'];
  state = reduce(state, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
  state = reduce(state, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
  state = reduce(
    state,
    { type: 'PLACE_ROOM', orient: pendingOrientations(state, ctx)[0] },
    ctx,
  );

  assert.equal(state.lastEntrance.id, '24', 'card 24 is the one that marks a Shift Point');
  assert.equal(state.shiftPressure, 1, 'a Shift Point must slide the bar down one step');
  assert.equal(state.shiftTokens, 1, 'the point is counted');
  assert.match(state.log.join('\n'), /Shift Point/, 'the log must say what the point did');

  state = reduce(state, { type: 'END_TURN' }, ctx);
  state = reduce(state, { type: 'END_TURN' }, ctx);
  assert.equal(
    state.lastShift.needed,
    4,
    'the round-end roll must use the bar the Shift Point left behind',
  );

  // A point marked when the bar is already at the bottom changes nothing, and
  // says so rather than pretending to have done something.
  const floor = createGame(ctx, { seed: 12, playerCount: 2 });
  floor.shiftPressure = scenario.shift.ladder.length - 1;
  floor.entranceDeck = ['24'];
  let low = reduce(floor, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
  low = reduce(low, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
  low = reduce(low, { type: 'PLACE_ROOM', orient: pendingOrientations(low, ctx)[0] }, ctx);
  assert.equal(
    low.shiftPressure,
    scenario.shift.ladder.length - 1,
    'the bar must not slide past automatic',
  );
  assert.match(low.log.join('\n'), /already turning of its own accord/);
}

/* ------------------------------------------------------------------ *
 * Encounter cards are turned up at the end of a turn
 * ------------------------------------------------------------------ */

{
  assert.equal(
    scenario.encounters.revealOnEndTurn,
    'none',
    'the house turns nothing over for free — investigating a card is the action that does',
  );

  // A room whose entrance card puts exactly one card face down, on a named
  // square, so the test knows where it lies without having to walk there.
  const oneCard = () => {
    let state = createGame(ctx, { seed: 21, playerCount: 2 });
    state.entranceDeck = ['2'];
    // A Monster, because a Clue or a Nothing is replaced by nothing and leaves
    // the square empty — and these tests are about the card staying put.
    state.encounterDeck = ['1'];
    state = reduce(state, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
    state = reduce(state, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
    return reduce(
      state,
      { type: 'PLACE_ROOM', orient: pendingOrientations(state, ctx)[0] },
      ctx,
    );
  };

  const posFromKey = (key) => {
    const [gr, gc] = key.split(',').map(Number);
    return { gr, gc };
  };
  const distance = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
  const roomSquares = () => {
    const out = [];
    for (let r = 0; r < ROOM_SIZE; r++) {
      for (let c = 0; c < ROOM_SIZE; c++) out.push({ r, c });
    }
    return out;
  };
  const standOn = (state, marker, where) => {
    const [R, C] = marker.room.split(',').map(Number);
    state.players[state.turnIndex].pos = {
      gr: R * ROOM_SIZE + where.r,
      gc: C * ROOM_SIZE + where.c,
    };
    return state;
  };
  const endTurn = (state) => reduce(state, { type: 'END_TURN' }, ctx);

  const planted = oneCard();
  const key = planted.lastEntrance.placed[0];
  const marker = planted.encounters[key];
  const onIt = localOf(posFromKey(key));
  assert.equal(marker.faceUp, false, 'a card placed face down starts face down');

  const beside = roomSquares().find((square) => distance(square, onIt) === 1);
  const away = roomSquares().find((square) => distance(square, onIt) >= 2);

  // The mansion's own setting: ending a turn turns nothing over. A card is read
  // by spending one of the two actions on it, not by standing near it.
  let state = endTurn(standOn(structuredClone(planted), marker, onIt));
  assert.equal(
    state.encounters[key].faceUp,
    false,
    'ending your turn on a card does not turn it over',
  );

  // A scenario may still ask for it, and how wide the ring reaches is its to say.
  const withMode = (mode) => {
    const copy = structuredClone(planted);
    copy.encounterReveal = mode;
    return copy;
  };

  state = endTurn(standOn(withMode('on-or-adjacent'), marker, onIt));
  assert.equal(state.encounters[key].faceUp, true, 'asked for, ending your turn on it turns it');

  state = endTurn(standOn(withMode('on-or-adjacent'), marker, beside));
  assert.equal(state.encounters[key].faceUp, true, 'and one square beside it too');

  state = endTurn(standOn(withMode('on-or-adjacent'), marker, away));
  assert.equal(state.encounters[key].faceUp, false, 'two squares off is not beside it');

  // How wide the ring is belongs to the scenario.
  state = structuredClone(planted);
  state.encounterReveal = 'on';
  state = endTurn(standOn(state, marker, beside));
  assert.equal(
    state.encounters[key].faceUp,
    false,
    'with "on", standing beside it is not enough',
  );

  state = structuredClone(planted);
  state.encounterReveal = 'on';
  state = endTurn(standOn(state, marker, onIt));
  assert.equal(state.encounters[key].faceUp, true, 'with "on", standing on it still counts');

  state = structuredClone(planted);
  state.encounterReveal = 'none';
  state = endTurn(standOn(state, marker, onIt));
  assert.equal(state.encounters[key].faceUp, false, 'with "none", nothing turns over');

  assert.throws(
    () =>
      createGame(
        { ...ctx, scenario: { ...scenario, encounters: { revealOnEndTurn: 'next-to' } } },
        { seed: 1 },
      ),
    /not one of/,
    'a mistyped reveal mode must fail loudly rather than quietly do nothing',
  );
}

/* ------------------------------------------------------------------ *
 * Entering a room draws a room entrance card — once per player per turn
 * ------------------------------------------------------------------ */

{
  // Out of the foyer into a new room, then straight back in.
  let state = createGame(ctx, { seed: 31, playerCount: 2 });
  state = reduce(state, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
  state = reduce(state, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
  state = reduce(state, { type: 'PLACE_ROOM', orient: pendingOrientations(state, ctx)[0] }, ctx);
  assert.equal(state.lastEntrance.slot, '-1,0', 'stepping into a new room turns its card');
  const drawn = state.entranceSeen.length;
  const rot = state.rooms['-1,0'].rot;

  // "Each player may only trigger 1 Room Entrance Card per turn."
  state = reduce(state, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
  assert.equal(state.lastEntrance, null, 'walking back in the same turn turns no card');
  assert.equal(state.entranceSeen.length, drawn, 'nothing more came off the deck');
  assert.match(state.log.join('\n'), /already been drawn this turn/);

  // A new turn, and walking into a room already on the table draws again.
  state = reduce(state, { type: 'END_TURN' }, ctx);
  state = reduce(state, { type: 'END_TURN' }, ctx);
  state.rooms['-1,0'].rot = rot; // undo any shift, so the doorway still lines up
  state = reduce(state, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
  assert.equal(state.lastEntrance?.slot, '-1,0', 'coming back on a later turn turns a card');
  assert.equal(state.entranceSeen.length, drawn + 1, 'a second card came off the deck');
  assert.match(state.log.join('\n'), /Room entrance —/, 'the card is applied, not just counted');
  assert.equal(
    state.entranceDeck.length + state.entranceSeen.length,
    TOTAL_ENTRANCES,
    'no card went missing on the way back',
  );

  // Re-entering draws far more often than the deck has cards, so a spent deck
  // comes back rather than the rest of the game running silent.
  const walkIn = (from) => {
    let out = reduce(from, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
    out = reduce(out, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
    return reduce(out, { type: 'PLACE_ROOM', orient: pendingOrientations(out, ctx)[0] }, ctx);
  };
  const spent = (() => {
    const game = createGame(ctx, { seed: 32, playerCount: 2 });
    game.entranceSeen = game.entranceDeck.slice();
    game.entranceDeck = [];
    return walkIn(game);
  })();
  assert.ok(spent.lastEntrance, 'a spent deck still hands out a card');
  assert.equal(
    spent.entranceDeck.length + spent.entranceSeen.length,
    TOTAL_ENTRANCES,
    'the deck is whole again after shuffling',
  );
  assert.match(spent.log.join('\n'), /shuffled/, 'the shuffle is not silent');

  // The room deck is the one deck that does not come back: when every room is on
  // the table the house is finished, and the way out is shut.
  let closed = createGame(ctx, { seed: 33, playerCount: 1 });
  closed = reduce(closed, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
  closed.roomDeck = [];
  assert.throws(
    () => reduce(closed, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx),
    /no room left to turn over/,
    'stepping into the dark with no rooms left is refused, not crashed',
  );
}

/* ------------------------------------------------------------------ *
 * The encounter deck
 * ------------------------------------------------------------------ */

{
  // Six of each of the five kinds, which is 30 cards.
  const counts = {};
  for (const card of Object.values(encounterCards)) {
    counts[card.type] = (counts[card.type] ?? 0) + 1;
  }
  assert.deepEqual(counts, { monster: 6, clue: 6, nothing: 6, event: 6, item: 6 });

  // The reader is strict, or a typo quietly makes a card of a kind that is not in
  // the game at all.
  assert.throws(() => encountersFromCsv('id,type\n1,spooks'), /a card is one of/);
  assert.throws(() => encountersFromCsv('id,type\n1,monster\n1,clue'), /duplicate id/);
  assert.throws(() => encountersFromCsv('id\n1'), /missing the "type" column/);
  assert.throws(() => encountersFromCsv('id,type\n'), /has no cards/);

  const rigged = (entranceId, encounterIds, eventIds = null) => {
    const game = createGame(ctx, { seed: 41, playerCount: 2 });
    game.entranceDeck = [entranceId];
    game.encounterDeck = encounterIds.slice();
    if (eventIds) game.eventDeck = eventIds.slice();
    return game;
  };
  const enter = (game) => {
    let out = reduce(game, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
    out = reduce(out, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
    return reduce(out, { type: 'PLACE_ROOM', orient: pendingOrientations(out, ctx)[0] }, ctx);
  };
  const squareOf = (key) => {
    const [gr, gc] = key.split(',').map(Number);
    return { gr, gc };
  };
  // Walk onto the card and spend an action on it: that is what takes it up.
  const take = (game, at) => {
    const [gr, gc] = at.split(',').map(Number);
    game.players[game.turnIndex].pos = { gr, gc };
    return reduce(game, { type: 'INVESTIGATE' }, ctx);
  };

  // A face-down card is already a particular card: it is dealt as it is laid
  // down, and only its face is hidden.
  let state = enter(rigged('2', ['7']));
  const key = state.lastEntrance.placed[0];
  assert.equal(state.encounters[key].faceUp, false);
  assert.equal(state.encounters[key].cardId, '7', 'the card was dealt when it was laid');
  assert.deepEqual(state.encounterDeck, [], 'and it came off the deck');
  assert.equal(state.encounters[key].type, null, 'a face-down card still says nothing');

  state.players[state.turnIndex].pos = squareOf(key);
  state = reduce(state, { type: 'INVESTIGATE' }, ctx);
  assert.equal(
    state.encounters[key],
    undefined,
    'a Clue is replaced by the token, so the card leaves the square',
  );
  assert.equal(currentPlayer(state).clues, 1, 'a clue is a clue, and it is counted');
  assert.deepEqual(state.encounterDiscard, ['7'], 'the card went to the discard pile');
  assert.match(state.log.join('\n'), /It is a Clue/, 'the log says what the card was');

  // A card laid face up is read on the spot — but nothing is collected by
  // seeing it.
  const faceUp = enter(rigged('17', ['1']));
  const upKey = faceUp.lastEntrance.placed[0];
  assert.equal(faceUp.encounters[upKey].faceUp, true);
  assert.equal(faceUp.encounters[upKey].type, 'monster', 'card 1 is a monster');
  assert.equal(currentPlayer(faceUp).clues, 0, 'a monster is not a clue');
  assert.equal(faceUp.encounterDeck.length, 0, 'the monster was drawn off the deck');

  // The user-facing rule, in one test: a Clue laid face up is worth nothing
  // until someone investigates the square it lies on.
  const showing = enter(rigged('17', ['7']));
  const clueKey = showing.lastEntrance.placed[0];
  assert.equal(showing.encounters[clueKey].type, 'clue', 'the card shows it is a Clue');
  assert.equal(currentPlayer(showing).clues, 0, 'the token is not collected by looking at it');
  assert.deepEqual(showing.encounterDiscard, [], 'the card is still lying on the square');
  const collected = take(showing, clueKey);
  assert.equal(currentPlayer(collected).clues, 1, 'and it is collected by investigating it');
  assert.deepEqual(collected.encounterDiscard, ['7'], 'which spends the encounter card');

  // "If Monster, place another face up on [2]" can finally be answered, because
  // the card is laid face up and the deck has said what it is. A rigged deck is
  // read from the end, so the last id is the first card drawn.
  const twoCards = enter(rigged('16', ['19', '1'], ['22']));
  assert.equal(twoCards.lastEntrance.placed.length, 2, 'a monster brings a second card with it');
  assert.equal(
    twoCards.encounters[twoCards.lastEntrance.placed[1]].type,
    'event',
    'the second card is read as well, and waits to be taken up',
  );
  assert.deepEqual(twoCards.eventDiscard, [], 'nothing is played by seeing it');

  // An Event shows what it is, and is only read out when someone takes it up.
  const evented = enter(rigged('17', ['19'], ['22']));
  const eventKey = evented.lastEntrance.placed[0];
  assert.equal(evented.encounters[eventKey].type, 'event', 'the card shows what it is');
  assert.deepEqual(evented.eventDiscard, [], 'and nothing has been played yet');
  assert.equal(evented.stepsLeft, 0, 'seeing it does not move anybody');

  const played = take(evented, eventKey);
  assert.equal(played.encounters[eventKey], undefined, 'taking it up clears the square');
  assert.deepEqual(played.eventDiscard, ['22'], 'the event card went to the discard pile');
  assert.equal(played.stepsLeft, 1, 'card 22 is one space of free movement');

  // A Nothing is only taking the card away — and only when it is taken up.
  const nothing = enter(rigged('17', ['13']));
  const nothingKey = nothing.lastEntrance.placed[0];
  assert.equal(nothing.encounters[nothingKey].type, 'nothing', 'a Nothing shows as much');
  const cleared = take(nothing, nothingKey);
  assert.equal(cleared.encounters[nothingKey], undefined, 'a Nothing leaves no card behind');
  assert.equal(currentPlayer(cleared).clues, 0, 'and it is not a clue');

  const justOne = enter(rigged('16', ['1', '7']));
  assert.equal(justOne.lastEntrance.placed.length, 1, 'a clue brings nothing with it');

  /* ---- investigating: the turn's other action ---- */

  // Card 7 lays one card face down on a corner of the new room. Walk two squares
  // to it, then spend the second action looking into it.
  const plantedRoom = () => {
    let state = createGame(ctx, { seed: 53, playerCount: 2 });
    state.entranceDeck = ['7'];
    state.encounterDeck = ['9']; // a clue
    state = reduce(state, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
    state = reduce(state, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
    return reduce(
      state,
      { type: 'PLACE_ROOM', orient: pendingOrientations(state, ctx)[0] },
      ctx,
    );
  };

  const planted = plantedRoom();
  const downKey = planted.lastEntrance.placed[0];
  const down = planted.encounters[downKey];
  const [slotR, slotC] = down.room.split(',').map(Number);
  const cardAt = localOf(squareOf(downKey));

  // Two squares away along a row or column — a corner always has one.
  const startLocal = { r: cardAt.r === 0 ? 2 : 0, c: cardAt.c };
  const midLocal = { r: (cardAt.r + startLocal.r) / 2, c: (cardAt.c + startLocal.c) / 2 };
  const toGlobal = (p) => ({ gr: slotR * ROOM_SIZE + p.r, gc: slotC * ROOM_SIZE + p.c });

  // Their turn starts here: two actions, the card two squares away.
  const beforeWalk = structuredClone(planted);
  beforeWalk.players[beforeWalk.turnIndex].pos = toGlobal(startLocal);
  beforeWalk.actionsLeft = beforeWalk.actionsPerTurn;
  beforeWalk.stepsLeft = 0;

  const walked = reduce(
    beforeWalk,
    { type: 'MOVE', path: [toGlobal(midLocal), toGlobal(cardAt)] },
    ctx,
  );
  assert.equal(walked.actionsLeft, 1, 'walking two squares is one action');
  assert.equal(
    walked.encounters[downKey].faceUp,
    false,
    'walking onto a card does not read it',
  );
  // The card under it was dealt when it was laid down, but walking onto it says
  // nothing about what it is.
  assert.equal(walked.encounters[downKey].type, null, 'walking onto it reads nothing');
  assert.equal(walked.encounters[downKey].cardId, '9', 'though the card is already a card');

  const looked = reduce(walked, { type: 'INVESTIGATE' }, ctx);
  assert.equal(looked.actionsLeft, 0, 'investigating spends the other action');
  assert.equal(
    looked.encounters[downKey],
    undefined,
    'the Clue replaces the card on your square',
  );
  assert.ok(looked.encounterDiscard.includes('9'), 'and the card goes to the encounter discard');
  assert.equal(
    currentPlayer(looked).clues,
    currentPlayer(walked).clues + 1,
    'a clue is a clue',
  );
  assert.match(looked.log.join('\n'), /investigates the card on/, 'the log says what was done');

  assert.throws(
    () => reduce(looked, { type: 'INVESTIGATE' }, ctx),
    /no actions left this turn/,
    'the turn only has two actions',
  );

  const blank = structuredClone(planted);
  blank.players[blank.turnIndex].pos = toGlobal(midLocal);
  blank.stepsLeft = 0;
  assert.throws(
    () => reduce(blank, { type: 'INVESTIGATE' }, ctx),
    /no encounter card on this square/,
    'there is nothing on that square to look into',
  );

  const readAlready = structuredClone(planted);
  readAlready.players[readAlready.turnIndex].pos = toGlobal(cardAt);
  readAlready.encounters[downKey].faceUp = true;
  readAlready.encounters[downKey].collected = true;
  assert.throws(
    () => reduce(readAlready, { type: 'INVESTIGATE' }, ctx),
    /nothing left to take/,
    'a card that has been taken up is not investigated again',
  );

  // Investigating is not a move: the investigator stays where they stood.
  assert.deepEqual(looked.players[looked.turnIndex].pos, toGlobal(cardAt));

  // The encounter deck replenishes like every other deck.
  const spent = rigged('17', []);
  spent.encounterDiscard = Object.keys(encounterCards);
  const afterSpent = enter(spent);
  const spentKey = afterSpent.lastEntrance.placed[0];
  assert.match(afterSpent.log.join('\n'), /It is a[n]? /, 'a spent deck still answers');
  const onTable = Object.values(afterSpent.encounters).filter((marker) => marker.cardId).length;
  assert.equal(
    afterSpent.encounterDeck.length + afterSpent.encounterDiscard.length + onTable,
    TOTAL_ENCOUNTERS,
    'the deck is whole again after shuffling',
  );
  assert.match(afterSpent.log.join('\n'), /encounter deck is spent, so its cards are shuffled/);
}

/* ------------------------------------------------------------------ *
 * Item cards
 * ------------------------------------------------------------------ */

{
  assert.equal(TOTAL_ITEMS, 24, 'the item deck is 24 cards');

  // The reader is strict about the columns that carry rules: a typo in one of
  // them would leave a card quietly doing nothing at the table.
  // Health and Sanity are in the game, so no card may claim to wait on them.
  assert.deepEqual(items['2'].needs, [], 'the First Aid Kit waits on nothing now');
  assert.equal(items['2'].effect.health, 1);
  assert.deepEqual(items['10'].needs, [], 'the Ritual Knife is a weapon now');
  assert.deepEqual(items['10'].effect.hit, { damage: 2, reach: 1 });
  assert.equal(items['10'].effect.health, -1, 'and it costs a point of Health');
  assert.deepEqual(items['9'].effect.bind, { reach: 1 }, 'Binding Chalk holds a monster back');
  assert.equal(items['19'].effect.pushRooms, 1, 'and the Ghost Bell drives them away');
  assert.equal(items['1'].effect.move, 2);
  assert.equal(items['1'].effect.health, 0, 'and it takes no Health with it');
  assert.equal(items['11'].effect.sanityShield, 1, 'the amulet is a ward');
  assert.equal(items['18'].effect.damageShield, 1, 'and so are the painkillers');
  assert.throws(
    () => itemsFromCsv('id,name,needs,text\n1,Thing,health,"x"'),
    /Health and Sanity are in the game now/,
    'a card cannot wait on a pool that exists',
  );
  assert.throws(
    () => itemsFromCsv('id,name,effect,text\n1,Thing,glide,"x"'),
    /not something the table can carry out/,
  );
  assert.throws(() => itemsFromCsv('id,name,effect,text\n1,Thing,fly:2,"x"'), /it can only change/);
  assert.throws(() => itemsFromCsv('id,name,needs,text\n1,Thing,singing,"x"'), /which is not one of/);
  assert.throws(() => itemsFromCsv('id,name,text\n1,Thing,"x"\n1,Other,"y"'), /duplicate id/);
  assert.throws(() => itemsFromCsv('id,text\n1,"x"'), /missing the "name" column/);

  const start = (encounterIds, itemIds, entranceId = '17') => {
    const game = createGame(ctx, { seed: 41, playerCount: 2 });
    game.entranceDeck = [entranceId];
    game.encounterDeck = encounterIds.slice();
    game.itemDeck = itemIds.slice();
    game.itemDiscard = [];
    return game;
  };
  const enterRoom = (game) => {
    let out = reduce(game, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
    out = reduce(out, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
    return reduce(out, { type: 'PLACE_ROOM', orient: pendingOrientations(out, ctx)[0] }, ctx);
  };
  // Walk onto the card and spend an action on it: that is what takes it up.
  const take = (game, at) => {
    const [gr, gc] = at.split(',').map(Number);
    game.players[game.turnIndex].pos = { gr, gc };
    return reduce(game, { type: 'INVESTIGATE' }, ctx);
  };

  // An encounter card that calls an Item is turned over first: the investigator
  // sees what is lying there, and nothing is in hand until they look into it.
  let state = enterRoom(start(['25'], ['15']));
  const itemKey = state.lastEntrance.placed[0];
  assert.equal(state.encounters[itemKey].type, 'item', 'the card shows what it is');
  assert.equal(
    state.encounters[itemKey].itemId,
    '15',
    'and the item under it is face up beside it',
  );
  assert.deepEqual(currentPlayer(state).items, [], 'showing is not taking');
  assert.deepEqual(state.itemDeck, [], 'the item card has left its deck');

  state = take(state, itemKey);
  assert.deepEqual(
    currentPlayer(state).items,
    ['15'],
    'investigating it puts the Clue Journal in hand',
  );
  assert.equal(state.encounters[itemKey], undefined, 'and the square is empty');
  assert.equal(state.itemDeck.length, 0, 'the item deck gave up its card');
  assert.match(state.log.join('\n'), /Clue Journal/);
  assert.equal(currentPlayer(state).clues, 0, 'taking a card is not using it');

  // Using it is free, and the spent card goes to the discard pile.
  const journal = reduce(state, { type: 'USE_ITEM', itemId: '15' }, ctx);
  assert.equal(currentPlayer(journal).clues, 1, 'the Clue Journal is worth one clue');
  assert.deepEqual(currentPlayer(journal).items, [], 'and it leaves the hand');
  assert.deepEqual(journal.itemDiscard, ['15']);
  assert.equal(journal.actionsLeft, state.actionsLeft, 'using an item costs no action');
  assert.throws(
    () => reduce(journal, { type: 'USE_ITEM', itemId: '15' }, ctx),
    /not in this investigator's hand/,
    'a card that has been spent cannot be spent again',
  );

  // Adrenaline: two more spaces this turn, and no further.
  const syringeBefore = enterRoom(start(['25'], ['1']));
  const syringe = take(syringeBefore, syringeBefore.lastEntrance.placed[0]);
  assert.equal(syringe.moveRange, 2);
  const swift = reduce(syringe, { type: 'USE_ITEM', itemId: '1' }, ctx);
  assert.equal(swift.moveRange, 4, 'the syringe is two extra spaces');
  assert.equal(
    reduce(swift, { type: 'END_TURN' }, ctx).moveRange,
    2,
    'and they do not carry into the next turn',
  );

  // Dusty Pocketwatch hands an action back, which is why using an item is free.
  const watchBefore = enterRoom(start(['25'], ['23']));
  const watch = take(watchBefore, watchBefore.lastEntrance.placed[0]);
  const armed = reduce(watch, { type: 'USE_ITEM', itemId: '23' }, ctx);
  assert.equal(armed.actionsLeft, watch.actionsLeft + 1, 'the pocketwatch is an extra action');

  // Seal Fragment marks the same bar the round-end roll uses.
  const sealBefore = enterRoom(start(['25'], ['21']));
  const seal = reduce(
    take(sealBefore, sealBefore.lastEntrance.placed[0]),
    { type: 'USE_ITEM', itemId: '21' },
    ctx,
  );
  assert.equal(seal.shiftPressure, 1, 'a shift point is marked');
  assert.equal(seal.shiftTokens, 1);

  // The lantern only shows what is face down in the room the holder is in.
  const lantern = start(['1'], [], '2');
  lantern.players[0].items.push('4');
  const dark = enterRoom(lantern);
  const hiddenKey = dark.lastEntrance.placed[0];
  assert.equal(dark.encounters[hiddenKey].faceUp, false, 'entrance card 2 lays it face down');
  const lit = reduce(dark, { type: 'USE_ITEM', itemId: '4' }, ctx);
  assert.equal(lit.encounters[hiddenKey].faceUp, true, 'the lantern turned it over');
  assert.equal(lit.encounters[hiddenKey].type, 'monster', 'and the deck answered for it');

  // A Health card is live now. These seats carry no sheet, so the card is spent
  // and says plainly that there is no pool to move; the healing itself is
  // proved against the investigator sheets.
  const kitBefore = enterRoom(start(['25'], ['2']));
  const kit = take(kitBefore, kitBefore.lastEntrance.placed[0]);
  assert.deepEqual(currentPlayer(kit).items, ['2'], 'the First Aid Kit is kept');
  assert.equal(useItemProblem(kit, ctx, '2'), null, 'and it is ready to use');
  const kitUsed = reduce(kit, { type: 'USE_ITEM', itemId: '2' }, ctx);
  assert.match(kitUsed.log.join('\n'), /no Health on their sheet/);
  assert.deepEqual(kitUsed.itemDiscard, ['2'], 'the card is spent either way');
  assert.match(useItemProblem(kit, ctx, '15'), /not in this investigator's hand/);

  // The item deck replenishes from its discards like every other deck.
  const emptyDeck = start(['25'], []);
  emptyDeck.itemDiscard = Object.keys(items);
  const refillBefore = enterRoom(emptyDeck);
  const refilled = take(refillBefore, refillBefore.lastEntrance.placed[0]);
  assert.match(refilled.log.join('\n'), /item deck is spent, so its cards are shuffled/);
  assert.equal(
    refilled.itemDeck.length + refilled.itemDiscard.length + currentPlayer(refilled).items.length,
    TOTAL_ITEMS,
    'the deck is whole again',
  );
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

{
  assert.equal(TOTAL_EVENTS, 30, 'the event deck is 30 cards');

  // The two columns that carry rules are read strictly.
  assert.deepEqual(events['3'].roll, { min: 5, max: 6 });
  assert.deepEqual(events['3'].effect, [{ kind: 'clue', n: 1 }]);
  assert.equal(events['10'].roll, null, 'card 10 happens whatever the die says');
  assert.deepEqual(events['10'].effect, [{ kind: 'sanity', n: -1 }], 'Sanity is in the game now');
  assert.deepEqual(events['10'].needs, [], 'so card 10 is no longer pending');
  assert.deepEqual(events['13'].when, { kind: 'sanity', atMost: 3 }, 'card 13 carries a condition');
  assert.deepEqual(events['19'].when, { kind: 'no-items' }, 'and so does card 19');
  assert.throws(
    () => eventsFromCsv('id,when,text\n1,whenever,"x"'),
    /the when column takes no-items/,
    'a conditional card is read strictly',
  );
  assert.throws(() => eventsFromCsv('id,roll,text\n1,7,"x"'), /not a d6 band/);
  assert.throws(() => eventsFromCsv('id,roll,text\n1,5-3,"x"'), /backwards/);
  assert.throws(() => eventsFromCsv('id,effect,text\n1,fly:2,"x"'), /an event can/);
  assert.throws(
    () => eventsFromCsv('id,effect,text\n1,teleport:moon,"x"'),
    /not somewhere this house knows/,
  );
  assert.throws(() => eventsFromCsv('id,effect,text\n1,clue:+0,"x"'), /not a number of anything/);
  assert.throws(() => eventsFromCsv('id,text\n1,"x"\n1,"y"'), /duplicate id/);
  assert.throws(() => eventsFromCsv('id\n1'), /missing the "text" column/);

  const start = (encounterIds, eventIds, entranceId = '17') => {
    const game = createGame(ctx, { seed: 41, playerCount: 2 });
    game.entranceDeck = [entranceId];
    game.encounterDeck = encounterIds.slice();
    game.eventDeck = eventIds.slice();
    game.eventDiscard = [];
    return game;
  };
  const enterRoom = (game) => {
    let out = reduce(game, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
    out = reduce(out, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
    return reduce(out, { type: 'PLACE_ROOM', orient: pendingOrientations(out, ctx)[0] }, ctx);
  };
  // Walk onto the card and spend an action on it: that is what takes it up.
  const take = (game, at) => {
    const [gr, gc] = at.split(',').map(Number);
    game.players[game.turnIndex].pos = { gr, gc };
    return reduce(game, { type: 'INVESTIGATE' }, ctx);
  };
  const squareOf = (key) => {
    const [gr, gc] = key.split(',').map(Number);
    return { gr, gc };
  };

  // An Event shows what it is when it is revealed, and is read out only when
  // someone takes it up: seeing a card is not playing it.
  const shown = enterRoom(start(['19'], ['3']));
  const shownKey = shown.lastEntrance.placed[0];
  assert.equal(shown.encounters[shownKey].type, 'event', 'the card shows what it is');
  assert.deepEqual(shown.eventDiscard, [], 'and nothing has been played yet');

  const rolled = take(shown, shownKey);
  assert.deepEqual(rolled.encounters, {}, 'an Event leaves no card behind once taken up');
  assert.deepEqual(rolled.eventDiscard, ['3'], 'and goes to the discard pile');
  const roll = Number(/The die comes up (\d)/.exec(rolled.log.join('\n'))[1]);
  assert.equal(
    currentPlayer(rolled).clues,
    roll >= 5 ? 1 : 0,
    'card 3 is a clue on 5-6 and nothing otherwise',
  );

  // A card with no roll happens whatever the die would have said.
  const tokenlessBefore = enterRoom(start(['19'], ['20']));
  const tokenless = take(tokenlessBefore, tokenlessBefore.lastEntrance.placed[0]);
  assert.equal(currentPlayer(tokenless).clues, 0, 'a clue token that is not there is not taken');
  assert.match(tokenless.log.join('\n'), /no clue token to give up/);

  const holdingClue = start(['19'], ['20']);
  currentPlayer(holdingClue).clues = 2;
  const withClue = enterRoom(holdingClue);
  assert.equal(currentPlayer(withClue).clues, 2, 'a token is held until the card is taken up');
  assert.equal(
    currentPlayer(take(withClue, withClue.lastEntrance.placed[0])).clues,
    1,
    'card 20 gives up one clue token',
  );

  // Teleporting home, and moving without spending an action.
  const homeBefore = enterRoom(start(['19'], ['24']));
  const home = take(homeBefore, homeBefore.lastEntrance.placed[0]);
  assert.deepEqual(currentPlayer(home).pos, { gr: 1, gc: 1 }, 'card 24 is back to the Foyer');

  const stridesBefore = enterRoom(start(['19'], ['25']));
  const strides = take(stridesBefore, stridesBefore.lastEntrance.placed[0]);
  assert.equal(strides.stepsLeft, 2, 'card 25 is two spaces of movement');
  assert.equal(
    strides.actionsLeft,
    stridesBefore.actionsLeft - 1,
    'and the card itself costs no action',
  );

  // The nearest room turns, carrying whoever is inside it.
  const turningBefore = enterRoom(start(['19'], ['28']));
  const turning = take(turningBefore, turningBefore.lastEntrance.placed[0]);
  assert.equal(turning.rooms['0,0'].rot, 1, 'card 28 turns the nearest other room');

  // "Your next Investigate action fails": the action is spent on nothing.
  const doomedBefore = enterRoom(start(['19'], ['14']));
  const doomed = take(doomedBefore, doomedBefore.lastEntrance.placed[0]);
  assert.equal(doomed.investigatePenalty, 1, 'card 14 puts a debt on the next look');

  // Card 18 — "Shuffle one face-down Encounter Card in your room back into the
  // deck." It can only work because the card on a square is a particular card
  // from the moment it is laid down.
  const puttingBack = enterRoom(start(['7', '19'], ['18'], '8'));
  const [eventSquare, otherSquare] = puttingBack.lastEntrance.placed;
  assert.equal(puttingBack.encounters[eventSquare].cardId, '19', 'an Event was dealt onto [2]');
  assert.equal(puttingBack.encounters[eventSquare].faceUp, false, 'and it lies face down');
  assert.equal(puttingBack.encounters[otherSquare].cardId, '7', 'with a Clue face down on [8]');

  const putBack = take(puttingBack, eventSquare);
  assert.equal(putBack.encounters[otherSquare], undefined, 'the face-down card left its square');
  assert.deepEqual(putBack.encounterDeck, ['7'], 'and went back into the encounter deck');
  assert.match(putBack.log.join('\n'), /goes back into the encounter deck/);

  // With nothing face down in the room there is nothing to give back.
  const nothingToDo = enterRoom(start(['19'], ['18'], '17'));
  const done = take(nothingToDo, nothingToDo.lastEntrance.placed[0]);
  assert.match(done.log.join('\n'), /nothing face down in this room to put back/);

  const pendingLook = createGame(ctx, { seed: 53, playerCount: 2 });
  pendingLook.entranceDeck = ['2'];
  pendingLook.encounterDeck = ['1'];
  const planted = enterRoom(pendingLook);
  const plantedKey = planted.lastEntrance.placed[0];
  planted.investigatePenalty = 1;
  planted.players[planted.turnIndex].pos = squareOf(plantedKey);
  const missed = reduce(planted, { type: 'INVESTIGATE' }, ctx);
  assert.equal(missed.encounters[plantedKey].faceUp, false, 'the card stayed face down');
  assert.equal(missed.actionsLeft, planted.actionsLeft - 1, 'and the action was spent');
  assert.equal(missed.investigatePenalty, 0, 'the debt is paid');

  // A card waiting on a rule the house lacks is read, noted and put aside.
  const unansweredBefore = enterRoom(start(['19'], ['21']));
  const unanswered = take(unansweredBefore, unansweredBefore.lastEntrance.placed[0]);
  assert.deepEqual(unanswered.encounters, {}, 'an unanswered Event still leaves no card');
  assert.match(
    unanswered.log.join('\n'),
    /still pending: it needs a choice to make/,
    'the card says plainly that it is waiting',
  );
  assert.equal(currentPlayer(unanswered).clues, 0, 'and it changes nothing');

  // A card that is pending is still a card: it is drawn, read out and put in the
  // discard like any other, and it comes back round when the deck runs out.
  // Nothing is filtered out of a deck for waiting on a rule the game lacks.
  const cycling = enterRoom(start(['19', '20'], ['21'], '8'));
  const [firstSquare, secondSquare] = cycling.lastEntrance.placed;

  const firstDraw = take(cycling, firstSquare);
  assert.match(firstDraw.log.join('\n'), /The event is read out/, 'the pending card is read out');
  assert.match(firstDraw.log.join('\n'), /still pending: it needs a choice to make/);
  assert.deepEqual(firstDraw.eventDiscard, ['21'], 'and put in the discard like any other');
  assert.equal(firstDraw.encounters[firstSquare], undefined, 'and it leaves its square');

  // A fresh turn, so there is an action left to look with.
  const secondTurn = structuredClone(firstDraw);
  secondTurn.actionsLeft = secondTurn.actionsPerTurn;
  secondTurn.stepsLeft = 0;
  const secondDraw = take(secondTurn, secondSquare);
  const pendingTimes = secondDraw.log.filter((line) => line.includes('still pending')).length;
  assert.equal(pendingTimes, 2, 'the deck handed the same pending card back round');

  // With nothing left to draw there is no event to read, so the card stays put.
  const noEvents = enterRoom(start(['19'], []));
  const stuck = noEvents.lastEntrance.placed[0];
  const afterStuck = take(noEvents, stuck);
  assert.equal(
    afterStuck.encounters[stuck].type,
    'event',
    'with no event left to draw, the card stays where it is',
  );

  // The event deck replenishes from its discards like every other deck.
  const spentEvents = start(['19'], []);
  spentEvents.eventDiscard = Object.keys(events);
  const refillBefore = enterRoom(spentEvents);
  const refilled = take(refillBefore, refillBefore.lastEntrance.placed[0]);
  assert.match(refilled.log.join('\n'), /event deck is spent, so its cards are shuffled/);
  assert.equal(
    refilled.eventDeck.length + refilled.eventDiscard.length,
    TOTAL_EVENTS,
    'the event deck is whole again',
  );
}

/* ------------------------------------------------------------------ *
 * A card that asks a question
 *
 * Some cards cannot be carried out without being told who or what they mean.
 * The card pauses, the table is asked, and the answer carries the card out.
 * ------------------------------------------------------------------ */

{
  const start = (encounterIds, eventIds, itemIds = [], entranceId = '17') => {
    const game = createGame(ctx, { seed: 41, playerCount: 2 });
    game.entranceDeck = [entranceId];
    game.encounterDeck = encounterIds.slice();
    game.eventDeck = eventIds.slice();
    game.eventDiscard = [];
    game.itemDeck = itemIds.slice();
    game.itemDiscard = [];
    return game;
  };
  const enterRoom = (game) => {
    let out = reduce(game, { type: 'MOVE', path: [{ gr: 0, gc: 1 }] }, ctx);
    out = reduce(out, { type: 'MOVE', path: [{ gr: -1, gc: 1 }] }, ctx);
    return reduce(out, { type: 'PLACE_ROOM', orient: pendingOrientations(out, ctx)[0] }, ctx);
  };
  const take = (game, at) => {
    const [gr, gc] = at.split(',').map(Number);
    game.players[game.turnIndex].pos = { gr, gc };
    return reduce(game, { type: 'INVESTIGATE' }, ctx);
  };

  // The Discarded Note asks who takes the token, and gives it to them.
  const note = createGame(ctx, { seed: 41, playerCount: 2 });
  note.players[0].items = ['24'];
  let state = reduce(note, { type: 'USE_ITEM', itemId: '24' }, ctx);
  assert.equal(state.choice.kind, 'give-clue', 'the card asks who');
  assert.deepEqual(state.choice.options.map((option) => option.id), ['p2']);
  assert.throws(
    () => reduce(state, { type: 'END_TURN' }, ctx),
    /answer the choice on the table/,
    'nothing else happens until the question is answered',
  );
  assert.throws(() => reduce(state, { type: 'CHOOSE', optionId: 'p9' }, ctx), /not one of the choices/);
  state = reduce(state, { type: 'CHOOSE', optionId: 'p2' }, ctx);
  assert.equal(state.players[1].clues, 1, 'the token goes to the other investigator');
  assert.equal(state.players[0].clues, 0, 'and not to the one holding the card');
  assert.equal(state.choice, null, 'the table is free again');

  // The Signal Flare pulls someone two spaces closer, at no cost to them.
  const flare = createGame(ctx, { seed: 41, playerCount: 2 });
  flare.players[0].items = ['16'];
  flare.players[1].pos = { gr: 0, gc: 0 };
  let pulled = reduce(flare, { type: 'USE_ITEM', itemId: '16' }, ctx);
  assert.equal(pulled.choice.kind, 'pull');
  assert.equal(pulled.choice.spaces, 2, 'it carries the card its two spaces');
  pulled = reduce(pulled, { type: 'CHOOSE', optionId: 'p2' }, ctx);
  assert.deepEqual(pulled.players[1].pos, { gr: 1, gc: 1 }, 'two spaces toward the holder');
  assert.equal(pulled.actionsLeft, pulled.actionsPerTurn, 'a card does the moving');

  // Event 23 trades two investigators' squares.
  const swapGame = enterRoom(start(['19'], ['23']));
  swapGame.players[1].pos = { gr: 0, gc: 0 };
  const askedSwap = take(swapGame, swapGame.lastEntrance.placed[0]);
  assert.equal(askedSwap.choice.kind, 'swap');
  const mine = { ...askedSwap.players[0].pos };
  const theirs = { ...askedSwap.players[1].pos };
  const afterSwap = reduce(askedSwap, { type: 'CHOOSE', optionId: 'p2' }, ctx);
  assert.deepEqual(afterSwap.players[0].pos, theirs);
  assert.deepEqual(afterSwap.players[1].pos, mine);

  // Event 5 only asks on a 4-6, and only when there is something to give up.
  let asked = 0;
  let silent = 0;
  let emptyHanded = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const game = createGame(ctx, { seed, playerCount: 2 });
    game.entranceDeck = ['17'];
    game.encounterDeck = ['19'];
    game.eventDeck = ['5'];
    game.eventDiscard = [];
    const armed = enterRoom(game);
    armed.players[0].items = seed % 2 === 0 ? [] : ['15'];
    const read = take(armed, armed.lastEntrance.placed[0]);
    const die = Number(/The die comes up (\d)/.exec(read.log.join('\n'))[1]);

    if (die < 4) {
      assert.equal(read.choice, null, `a ${die} asks nothing`);
      silent += 1;
      continue;
    }
    if (seed % 2 === 0) {
      assert.equal(read.choice, null, 'with nothing in hand there is nothing to give up');
      assert.match(read.log.join('\n'), /nothing in hand to give up/);
      emptyHanded += 1;
      continue;
    }
    assert.equal(read.choice.kind, 'discard-item');
    const dropped = reduce(read, { type: 'CHOOSE', optionId: '15' }, ctx);
    assert.deepEqual(dropped.players[0].items, [], 'the named card leaves the hand');
    assert.deepEqual(dropped.itemDiscard, ['15']);
    asked += 1;
  }
  assert.ok(
    silent > 0 && emptyHanded > 0 && asked > 0,
    'the card was seen asking, refusing and passing by',
  );
}

/* ------------------------------------------------------------------ *
 * A die on a card, and only one way to read it
 * ------------------------------------------------------------------ */

{
  // The roll column is the short form; it is compiled into the same op a card
  // writes for itself when it needs two outcomes.
  const column = eventsFromCsv('id,roll,effect,when,needs,text\nc,5-6,clue:+1,,,"On 5-6."');
  assert.equal(column.c.roll.min, 5, 'the column still reads as a band');
  assert.deepEqual(column.c.effect, [{ kind: 'clue', n: 1 }]);

  const split = eventsFromCsv(
    'id,roll,effect,when,needs,text\nd,,roll:d6/1-3:health:-1/4-6:clue:+1,,,"A split card."',
  );
  assert.equal(split.d.effect.length, 1, 'one op, not five');
  assert.equal(split.d.effect[0].kind, 'roll');
  assert.equal(split.d.effect[0].die, 6);
  assert.deepEqual(
    split.d.effect[0].branches.map((band) => [band.min, band.max]),
    [
      [1, 3],
      [4, 6],
    ],
  );
  assert.deepEqual(split.d.effect[0].branches[0].ops, [{ kind: 'health', n: -1 }]);

  // Two things on one face, and a die written as 1d6.
  const pair = eventsFromCsv(
    'id,roll,effect,when,needs,text\ne,,roll:1d6/1-2:sanity:-1;clue:-1/3-6:sanity:+1,,,"Two at once."',
  );
  assert.deepEqual(pair.e.effect[0].branches[0].ops, [
    { kind: 'sanity', n: -1 },
    { kind: 'clue', n: -1 },
  ]);

  // An item writes its die the same way, with `;` holding a branch together.
  const item = itemsFromCsv(
    'id,name,effect,needs,text\nx,Dark Dice,roll:d6/1-3:sanity:-1/4-6:clue:+1,,"A die."',
  );
  assert.equal(item.x.effect.roll.die, 6);
  assert.deepEqual(
    item.x.effect.roll.branches.map((band) => band.ops.length),
    [1, 1],
    'an item branch is a list of one, like an event branch',
  );
  assert.equal(item.x.effect.roll.branches[1].ops[0].clue, 1);
  assert.equal(item.x.effect.roll.branches[0].ops[0].sanity, -1);

  // What a person editing the deck can get wrong is a load error, not a card
  // that quietly half happens.
  const bad = (effect) => eventsFromCsv(`id,roll,effect,when,needs,text\ne,,${effect},,,"Bad."`);
  assert.throws(() => bad('roll:d6/1-6:clue:+1/3-4:clue:-1'), /twice/);
  assert.throws(() => bad('roll:d6/1-7:clue:+1'), /d6/);
  assert.throws(() => bad('roll:d6/4-2:clue:+1'), /backwards/);
  assert.throws(() => bad('roll:d6/1-3:'), /no effect/);
  assert.throws(() => bad('roll:d6'), /no band/);
  assert.throws(() => bad('roll:6/1-3:clue:+1'), /not a die/);
}

/* ------------------------------------------------------------------ *
 * Being sealed in is the point
 * ------------------------------------------------------------------ */

/**
 * Is every way out of the current player's room shut?
 *
 * A room has no interior walls, so an investigator can always walk to any of
 * its nine squares. The question is whether any of those squares still opens
 * onto somewhere else.
 */
function roomIsSealed(state, ctx) {
  const slot = slotOf(currentPlayer(state).pos);
  for (let r = 0; r < ROOM_SIZE; r++) {
    for (let c = 0; c < ROOM_SIZE; c++) {
      const from = { gr: slot.R * ROOM_SIZE + r, gc: slot.C * ROOM_SIZE + c };
      for (const step of STEPS) {
        const to = { gr: from.gr + step.dr, gc: from.gc + step.dc };
        const there = slotOf(to);
        if (there.R === slot.R && there.C === slot.C) continue;
        if (!stepProblem(state, from, to, ctx)) return false;
      }
    }
  }
  return true;
}

let sealedCase = null;
let sealedSeed = null;

{
  // The shift turns the rooms next to yours. A room that had its door on the
  // shared side can turn it away, and once the deck is empty there may be no
  // card left that opens a new way out. That is the game, not a bug: the engine
  // must never quietly prevent it, and must never leave the investigator with
  // no legal action either.
  for (let seed = 1; seed <= 240 && !sealedCase; seed++) {
    const rand = mulberry32(seed);
    let state = createGame(ctx, { seed, playerCount: 2 });

    for (let step = 0; step < 1200; step++) {
      if (state.pending) {
        state = reduce(
          state,
          { type: 'PLACE_ROOM', orient: pendingOrientations(state, ctx)[0] },
          ctx,
        );
        continue;
      }

      if (state.stepsLeft === 0 && state.actionsLeft > 0 && roomIsSealed(state, ctx)) {
        sealedCase = state;
        sealedSeed = seed;
        break;
      }

      const destinations = legalDestinations(state, ctx);
      if (state.actionsLeft > 0 && destinations.length > 0 && rand() < 0.75) {
        state = reduce(
          state,
          { type: 'MOVE', path: destinations[Math.floor(rand() * destinations.length)].path },
          ctx,
        );
      } else {
        state = reduce(state, { type: 'END_TURN' }, ctx);
      }

      if (state.round > 40) break;
    }
  }

  assert.ok(sealedCase, 'no investigator was ever sealed in, so the house cannot trap anyone');
  checkInvariants(sealedCase, `sealed in on seed ${sealedSeed}`);

  // Sealed in is not a broken state. The investigator can still walk around the
  // room they are in, and can still end the turn and wait for the house to turn
  // again.
  assert.ok(
    legalDestinations(sealedCase, ctx).length > 0,
    'an investigator sealed in a room must still be able to move about it',
  );

  const after = reduce(sealedCase, { type: 'END_TURN' }, ctx);
  checkInvariants(after, 'sealed in, ending the turn');
}

/* ------------------------------------------------------------------ *
 * Turn order at every table size
 * ------------------------------------------------------------------ */

{
  // The scenario is written for one to four investigators. Turn order, the round
  // count and who is up next are the kind of thing that works at two players and
  // quietly stops working at three, so every size gets played.
  for (const count of [1, 2, 3, 4]) {
    let state = createGame(ctx, { seed: 90 + count, playerCount: count });

    assert.equal(state.players.length, count, `${count} players were asked for`);
    assert.deepEqual(
      state.players.map((p) => p.id),
      Array.from({ length: count }, (_, i) => `p${i + 1}`),
      'investigators are numbered in turn order',
    );
    for (const player of state.players) {
      assert.deepEqual(player.pos, { gr: 1, gc: 1 }, 'everyone starts in the middle of the foyer');
    }

    for (let round = 1; round <= 3; round++) {
      for (let turn = 0; turn < count; turn++) {
        assert.equal(state.round, round, `${count}p: round counted wrongly`);
        assert.equal(state.turnIndex, turn, `${count}p: turn order broke`);
        assert.equal(currentPlayer(state).id, `p${turn + 1}`, `${count}p: wrong player is up`);
        assert.equal(
          state.actionsLeft,
          scenario.turn.actionsPerTurn,
          `${count}p: a turn did not start with a full allowance`,
        );
        state = reduce(state, { type: 'END_TURN' }, ctx);
      }

      assert.equal(
        state.round,
        round + 1,
        `${count}p: the round should end after ${count} turn${count === 1 ? '' : 's'}`,
      );
      assert.equal(state.turnIndex, 0, `${count}p: the round did not come back to the first player`);
      assert.equal(currentPlayer(state).id, 'p1');
    }

    checkInvariants(state, `${count} players`);
  }

  // Outside the range the scenario is written for, setup refuses rather than
  // inventing an investigator or silently dropping one.
  assert.throws(() => createGame(ctx, { playerCount: 0 }), /takes 1-4 players/);
  assert.throws(() => createGame(ctx, { playerCount: 5 }), /takes 1-4 players/);
}

{
  // A four-player game has to replay from its seed as exactly as a two-player
  // one, shifts and all.
  const options = { seed: 4242, playerCount: 4 };
  const rand = mulberry32(options.seed);
  const actions = [];
  let state = createGame(ctx, options);

  for (let step = 0; step < 300; step++) {
    let action;
    if (state.pending) {
      const valid = pendingOrientations(state, ctx);
      action = { type: 'PLACE_ROOM', orient: valid[Math.floor(rand() * valid.length)] };
    } else if (state.actionsLeft > 0 && rand() < 0.8) {
      const destinations = legalDestinations(state, ctx);
      action =
        destinations.length === 0
          ? { type: 'END_TURN' }
          : { type: 'MOVE', path: destinations[Math.floor(rand() * destinations.length)].path };
    } else {
      action = { type: 'END_TURN' };
    }

    state = reduce(state, action, ctx);
    actions.push(action);
    checkInvariants(state, `four players step ${step}`);
    if (state.round > 40) break;
  }

  assert.ok(Object.keys(state.rooms).length > 2, 'four investigators should open rooms too');
  assert.equal(
    JSON.stringify(replay(ctx, options, actions)),
    JSON.stringify(state),
    'the four-player game did not replay identically',
  );
}

/* ------------------------------------------------------------------ *
 * Playthroughs
 * ------------------------------------------------------------------ */

const GAMES = 40;
const MAX_ACTIONS = 900;

let totalActions = 0;
let totalPlacements = 0;
let totalShifts = 0;
let roomsUsed = 0;

const started = Date.now();

for (let game = 0; game < GAMES; game++) {
  const seed = 1000 + game;
  const options = { seed, playerCount: 2 };
  const rand = mulberry32(seed);

  let state = createGame(ctx, options);
  const actions = [];
  let lastShiftRound = null;

  for (let step = 0; step < MAX_ACTIONS; step++) {
    let action;

    if (state.pending) {
      const valid = pendingOrientations(state, ctx);
      assert.ok(valid.length > 0, 'a drawn card is always placeable here');
      action = { type: 'PLACE_ROOM', orient: valid[Math.floor(rand() * valid.length)] };
    } else if (state.actionsLeft > 0 && rand() < 0.82) {
      const destinations = legalDestinations(state, ctx);
      action =
        destinations.length === 0
          ? { type: 'END_TURN' }
          : { type: 'MOVE', path: destinations[Math.floor(rand() * destinations.length)].path };
    } else {
      // Items are used whenever they are usable: a randomised game is here to
      // catch rules drift, and a card nobody ever plays catches nothing.
      const usable = (currentPlayer(state).items ?? []).find(
        (id) => useItemProblem(state, ctx, id) === null,
      );
      action =
        usable && rand() < 0.6 ? { type: 'USE_ITEM', itemId: usable } : { type: 'END_TURN' };
    }

    state = reduce(state, action, ctx);
    actions.push(action);
    checkInvariants(state, `game ${seed} step ${step}`);

    if (action.type === 'PLACE_ROOM') totalPlacements += 1;
    if (state.lastShift?.occurred && state.lastShift.round !== lastShiftRound) {
      totalShifts += 1;
      lastShiftRound = state.lastShift.round;
    }

    if (state.round > 40) break;
  }

  roomsUsed += Object.keys(state.rooms).length;
  totalActions += actions.length;

  // The whole point of the seed: the same actions must rebuild the same state.
  const replayed = replay(ctx, options, actions);
  assert.equal(
    JSON.stringify(replayed),
    JSON.stringify(state),
    `game ${seed} did not replay identically`,
  );

  // And the same seed with no actions must produce the same opening.
  assert.equal(
    JSON.stringify(createGame(ctx, options)),
    JSON.stringify(createGame(ctx, options)),
    `game ${seed} opening is not deterministic`,
  );
}

const elapsed = Date.now() - started;

console.log(`\n${GAMES} games in ${elapsed}ms`);
console.log(`  actions played   ${totalActions}`);
console.log(`  rooms placed     ${totalPlacements}`);
console.log(`  shifts triggered ${totalShifts}`);
console.log(`  mean rooms open  ${(roomsUsed / GAMES).toFixed(1)} of ${TOTAL_ROOMS}`);
console.log(`  first sealed in  seed ${sealedSeed}, round ${sealedCase.round}`);
/* ------------------------------------------------------------------ *
 * Core rules and scenarios
 * ------------------------------------------------------------------ */
{
  // The Foyer is the one steadfast room: every game starts there.
  assert.equal(scenario.startRoom, 'foyer');
  assert.ok(scenario.shift.exemptRooms.includes('foyer'), 'the Foyer never turns');
  assert.equal(scenario.turn.actionsPerTurn, core.turn.actionsPerTurn, 'turns come from the core');

  const base = { id: 'test', name: 'Test' };
  assert.throws(
    () => buildScenario(core, { ...base, rules: { startRoom: 'study' } }),
    /always starts in the foyer/,
    'a scenario cannot start anywhere but the Foyer',
  );
  assert.throws(
    () => buildScenario(core, { ...base, startRoom: 'study' }),
    /always starts in the foyer/,
  );
  assert.throws(
    () => buildScenario(core, { ...base, turn: { actionsPerTurn: 3 } }),
    /goes under "rules"/,
    'a core rule is only changed through the rules block',
  );

  // A scenario may bend a core rule, one setting at a time.
  const harsh = buildScenario(core, {
    ...base,
    rules: { turn: { actionsPerTurn: 3 }, shift: { ladder: [3, 2, 1, 0], exemptRooms: [] } },
  });
  assert.equal(harsh.turn.actionsPerTurn, 3);
  assert.equal(harsh.turn.moveRange, core.turn.moveRange, 'what it leaves alone stays core');
  assert.deepEqual(harsh.shift.ladder, [3, 2, 1, 0]);
  assert.ok(harsh.shift.exemptRooms.includes('foyer'), 'and the Foyer still never turns');
  assert.deepEqual(harsh.monsters, []);
  assert.equal(harsh.endgame, null);
  assert.equal(core.turn.actionsPerTurn, 2, 'the core rules are not changed by a scenario');
}

console.log('\nALL INVARIANTS HELD');
