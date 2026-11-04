/**
 * Corridors of Madness — rules engine.
 *
 * The engine knows nothing about any particular scenario. Everything it needs
 * arrives as `ctx = { scenario, rooms }`, so adding a scenario is adding data,
 * not editing this file.
 *
 * Two properties are load-bearing and should survive every rule change:
 *
 *  1. `reduce` is pure. It clones the state, applies one action, returns the
 *     new state. No hidden mutation, no globals.
 *  2. Randomness is a seeded xorshift whose position lives in `state.rngState`.
 *     So `{ seed, actions }` reproduces any game exactly. When a player reports
 *     a bug you replay their game instead of asking what they think happened.
 *
 * State is plain JSON: no class instances, no functions, no Dates.
 *
 * ---------------------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------------------------
 *
 * Every room card is a 3x3 grid of spaces. The mansion is a growing grid of
 * room slots, and each slot owns the 3x3 block of spaces at
 *
 *     gr = slotR * 3 + r      gc = slotC * 3 + c
 *
 * So a position is one pair of integers, movement is one orthogonal step, and
 * crossing between rooms is just the step that happens to cross a multiple-of-3
 * line. That keeps walking inside a room and walking through a door the same
 * operation, which is why the whole thing stays simple.
 *
 * A door is always in the middle square of its side, never in a corner. That is
 * why a door always meets a door: two middles line up by definition. What the
 * house does instead is turn. A quarter turn carries a door onto another side,
 * and if that side has no door, the doorway becomes a wall — which is how an
 * investigator ends up sealed in.
 */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

export const ROOM_SIZE = 3;

const DIRS = [
  { key: 'n', dr: -1, dc: 0 },
  { key: 'e', dr: 0, dc: 1 },
  { key: 's', dr: 1, dc: 0 },
  { key: 'w', dr: 0, dc: -1 },
];

const DIR_KEYS = ['n', 'e', 's', 'w'];

const DIR_WORD = { n: 'north', e: 'east', s: 'south', w: 'west' };

/** The middle square of a side. The only place a door is ever cut. */
const DOOR_AT = 1;

export const OPPOSITE = { n: 's', e: 'w', s: 'n', w: 'e' };

const mod = (n, m) => ((n % m) + m) % m;

/* ------------------------------------------------------------------ *
 * Positions
 *
 * A position is { gr, gc } in global space. `slotOf` says which room it is
 * in, `localOf` says where in that room's own 3x3 grid.
 * ------------------------------------------------------------------ */

export function roomKey(slotR, slotC) {
  return `${slotR},${slotC}`;
}

export function slotOf(pos) {
  return { R: Math.floor(pos.gr / ROOM_SIZE), C: Math.floor(pos.gc / ROOM_SIZE) };
}

export function localOf(pos) {
  return { r: mod(pos.gr, ROOM_SIZE), c: mod(pos.gc, ROOM_SIZE) };
}

function posOf(slotR, slotC, r, c) {
  return { gr: slotR * ROOM_SIZE + r, gc: slotC * ROOM_SIZE + c };
}

/** Which direction is one orthogonal step from `from` to `to`? null if not adjacent. */
function travelDir(from, to) {
  const dr = to.gr - from.gr;
  const dc = to.gc - from.gc;
  if (Math.abs(dr) + Math.abs(dc) !== 1) return null;
  if (dr === -1) return 'n';
  if (dr === 1) return 's';
  return dc === 1 ? 'e' : 'w';
}

/**
 * Which square along the edge a step leaving `from` in direction `dir` passes
 * through. North and south measure across the columns, east and west down the
 * rows. Since a door only exists at the middle, this says whether a square is a
 * doorway or the stretch of wall beside it.
 */
function edgeOffset(from, dir) {
  const local = localOf(from);
  return dir === 'n' || dir === 's' ? local.c : local.r;
}

/* ------------------------------------------------------------------ *
 * Scenario data loading
 * ------------------------------------------------------------------ */

/** Minimal RFC4180-ish CSV reader. Handles quoted fields and doubled quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/**
 * Read one side's door: 1 for a door, 0 for wall. A door only ever sits in the
 * middle of a side, so there is nothing else to describe. 010 and 000 are taken
 * as the same thing, for anyone filling in the three squares by hand.
 */
function parseEdgeDoors(value, id, dir) {
  const text = (value ?? '').trim();
  if (text === '' || text === '0' || text === '000') return [false, false, false];
  if (text === '1' || text === '010') return [false, true, false];
  throw new Error(
    `room "${id}" has "${text}" for its ${dir} side; expected 1 for a door or 0 for a wall`,
  );
}

/**
 * Turn the rooms CSV into a map of id -> room card.
 * Expected columns: id, name, n, e, s, w, text.
 */
/**
 * What a room lets you do while you stand in it. A room card names one of
 * these in its `special` column; standing in the room, it costs an action.
 *
 *   clue-for-sanity   spend 1 Clue to regain 1 Sanity (the Library of Azrel)
 *   clue-for-health   spend 1 Clue to regain 1 Health (the Foyer)
 */
const ROOM_SPECIALS = {
  'clue-for-sanity': { label: 'Spend 1 Clue to regain 1 Sanity', pool: 'sanity' },
  'clue-for-health': { label: 'Spend 1 Clue to regain 1 Health', pool: 'health' },
};

export function roomsFromCsv(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error('rooms CSV is empty');

  const column = (name) => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`rooms CSV is missing the "${name}" column`);
    return index;
  };

  const iId = column('id');
  const iName = column('name');
  const iText = column('text');
  const iSpecial = header.indexOf('special');
  const iDoors = Object.fromEntries(DIR_KEYS.map((dir) => [dir, column(dir)]));

  const rooms = {};
  const seenNames = new Map();

  for (const row of rows) {
    const id = (row[iId] ?? '').trim();
    if (!id) continue;
    if (rooms[id]) throw new Error(`rooms CSV has a duplicate id: "${id}"`);

    const doors = {};
    for (const dir of DIR_KEYS) doors[dir] = parseEdgeDoors(row[iDoors[dir]], id, dir);

    const openings = DIR_KEYS.reduce((n, dir) => n + doors[dir].filter(Boolean).length, 0);
    if (openings === 0) {
      throw new Error(`room "${id}" has no doors at all, so it could never be entered`);
    }

    const name = (row[iName] ?? id).trim();
    if (seenNames.has(name)) {
      throw new Error(`rooms CSV has two rooms called "${name}"`);
    }
    seenNames.set(name, id);

    const special = iSpecial === -1 ? '' : (row[iSpecial] ?? '').trim();
    if (special && !ROOM_SPECIALS[special]) {
      throw new Error(
        `room "${id}" has the special "${special}", which is not one of ${Object.keys(ROOM_SPECIALS).join(', ')}`,
      );
    }

    rooms[id] = {
      id,
      name,
      doors,
      openings,
      text: (row[iText] ?? '').trim(),
      special: special || null,
    };
  }

  if (Object.keys(rooms).length === 0) throw new Error('rooms CSV has no rooms');
  return rooms;
}

/* ------------------------------------------------------------------ *
 * Room entrance cards
 *
 * Walking into a room is not the end of the move: the room's entrance card says
 * where the encounter cards lie. Every card in that deck is one of a handful of
 * sentences — draw N, put them on these squares, this way up — so the deck is
 * data, and a second deck is a second CSV.
 *
 * Squares are numbered the way they are printed on the card, reading left to
 * right and top to bottom as the card lies on the table once it has been turned:
 *
 *     1 2 3
 *     4 5 6
 *     7 8 9
 *
 * The numbering belongs to the table, not to the card, which is why the corners
 * of a room turned sideways are still its corners.
 * ------------------------------------------------------------------ */

const SPACE_NUMBERS = ROOM_SIZE * ROOM_SIZE;
const REVEAL_MODES = ['none', 'on', 'adjacent', 'on-or-adjacent'];

// An encounter card does not say what happens; it says which of the house's
// decks you are sent to. Five kinds, so the deck is built from five lists.
const ENCOUNTER_TYPES = ['monster', 'clue', 'nothing', 'event', 'item'];
const ENCOUNTER_WORD = {
  monster: 'Monster',
  clue: 'Clue',
  nothing: 'Nothing',
  event: 'Event',
  item: 'Item',
};

/**
 * How far a turn has to reach to turn an encounter card over.
 *
 * Off by default: investigating a card is an action, so a card that turns over
 * for free just by ending a turn beside it is a rule a scenario has to ask for.
 */
function revealMode(scenario) {
  const mode = scenario.encounters?.revealOnEndTurn ?? 'none';
  if (!REVEAL_MODES.includes(mode)) {
    throw new Error(
      `scenario reveals encounter cards "${mode}", which is not one of ${REVEAL_MODES.join(', ')}`,
    );
  }
  return mode;
}

/* ------------------------------------------------------------------ *
 * Monster cards
 *
 * The base encounter deck says Monster; it does not say which. That is the
 * scenario's to say: each scenario brings its own monster deck, and a Monster
 * encounter card turned over sends you to it. The monster that comes off it
 * stands on the square where the card lay.
 *
 * `power` is what the monster does, from a small vocabulary:
 *
 *   spawn-adjacent-room@5-6   when revealed, roll 1d6; on 5-6 another monster
 *                             appears in a room next to this one
 *   all-players-sanity@1-2    when revealed, every investigator rolls 1d6 and
 *                             loses 1 Sanity on 1-2
 *   blocks-investigate-room   nobody can Investigate in the same room
 *   damage-to-sanity          the damage it deals comes off Sanity, not Health
 * ------------------------------------------------------------------ */

const MONSTER_POWERS = {
  'spawn-adjacent-room': { banded: true },
  'all-players-sanity': { banded: true },
  'blocks-investigate-room': { banded: false },
  'damage-to-sanity': { banded: false },
};

function parseMonsterPower(value, id) {
  const text = (value ?? '').trim();
  if (text === '') return null;
  const [kind, band] = text.split('@');
  const rule = MONSTER_POWERS[kind];
  if (!rule) {
    throw new Error(
      `monster "${id}" has the power "${kind}", which is not one of ${Object.keys(MONSTER_POWERS).join(', ')}`,
    );
  }
  if (!rule.banded) {
    if (band !== undefined) throw new Error(`monster "${id}": ${kind} takes no die roll`);
    return { kind };
  }
  const match = /^([1-6])(?:-([1-6]))?$/.exec(band ?? '');
  if (!match) throw new Error(`monster "${id}": ${kind} needs a d6 band, like ${kind}@5-6`);
  const min = Number(match[1]);
  const max = match[2] ? Number(match[2]) : min;
  if (min > max) throw new Error(`monster "${id}" has its band backwards`);
  return { kind, min, max };
}

/**
 * Turn a scenario's monster CSV into a map of id -> card.
 * Expected columns: id, name, health, and — if the deck has them — ability,
 * power, text, flavor.
 */
/**
 * How monsters move at the end of each round, when their card does not say:
 *   none    they stay where they appeared
 *   hunt    1 space toward the nearest investigator, through doors
 *   room    1 space toward the nearest investigator in their own room
 * A monster card's own `movement` column overrides the rule for that monster.
 */
const MOVEMENTS = ['none', 'hunt', 'room'];

function readMovement(value, what) {
  if (!value) return null;
  if (!MOVEMENTS.includes(value)) {
    throw new Error(`${what} moves "${value}", which is not one of ${MOVEMENTS.join(', ')}`);
  }
  return value;
}

export function monstersFromCsv(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error('monster CSV is empty');
  const column = (name, required = true) => {
    const index = header.indexOf(name);
    if (index === -1 && required) throw new Error(`monster CSV is missing the "${name}" column`);
    return index;
  };
  const iId = column('id');
  const iName = column('name');
  const iHealth = column('health');
  const iAbility = column('ability', false);
  const iPower = column('power', false);
  const iText = column('text', false);
  const iFlavor = column('flavor', false);
  const iMovement = column('movement', false);
  const iDamage = column('damage', false);
  const cell = (row, index) => (index === -1 ? '' : (row[index] ?? '').trim());

  const cards = {};
  for (const row of rows) {
    const id = cell(row, iId);
    if (!id) continue;
    if (cards[id]) throw new Error(`monster CSV has a duplicate id: "${id}"`);
    const name = cell(row, iName);
    if (!name) throw new Error(`monster "${id}" has no name`);
    const health = Number(cell(row, iHealth));
    if (!Number.isInteger(health) || health < 1) {
      throw new Error(`monster "${id}" has "${cell(row, iHealth)}" for Health; it needs a whole number of at least 1`);
    }
    cards[id] = {
      id,
      name,
      health,
      ability: cell(row, iAbility),
      power: parseMonsterPower(cell(row, iPower), id),
      text: cell(row, iText),
      flavor: cell(row, iFlavor),
      movement: readMovement(cell(row, iMovement), `monster "${id}"`),
      damage: cell(row, iDamage) === '' ? undefined : Number(cell(row, iDamage)),
    };
    if (cards[id].damage !== undefined && !Number.isInteger(cards[id].damage)) {
      throw new Error(`monster "${id}" deals "${cell(row, iDamage)}" damage, which is not a number`);
    }
  }
  if (Object.keys(cards).length === 0) throw new Error('monster CSV has no monsters');
  return cards;
}

/* ------------------------------------------------------------------ *
 * Core rules and scenarios
 * ------------------------------------------------------------------ */

/**
 * The game is the core rules plus one scenario.
 *
 * The core rules (rules/core.json) are what every game of Corridors of Madness
 * shares: two actions a turn, the shift ladder, how many can sit at the table,
 * and the Foyer. A scenario brings what makes it that scenario — its story, its
 * monsters, its endgame, the room the story ends in — and may bend a core rule
 * through its `rules` block, which is laid over the core one section at a time.
 *
 * The Foyer is not the scenario's to move. It is the one steadfast room: every
 * game starts there, and the house never turns it.
 */
const STEADFAST_KEYS = ['startRoom', 'startSlot', 'startSpace'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function layer(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return structuredClone(over);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(over)) {
    out[key] = key in out ? layer(out[key], value) : structuredClone(value);
  }
  return out;
}

export function buildScenario(core, scenario) {
  if (!core) throw new Error('buildScenario needs the core rules');
  if (!scenario) throw new Error('buildScenario needs a scenario');

  const overrides = scenario.rules ?? {};
  for (const key of STEADFAST_KEYS) {
    if (key in overrides || key in scenario) {
      throw new Error(
        `scenario "${scenario.id}" sets ${key}, but the game always starts in the ${core.startRoom}`,
      );
    }
  }

  for (const key of Object.keys(core)) {
    if (key in scenario && !STEADFAST_KEYS.includes(key)) {
      throw new Error(
        `scenario "${scenario.id}" sets ${key} at the top level; a change to a core rule goes under "rules"`,
      );
    }
  }

  const rules = layer(core, overrides);
  // However a scenario bends the shift, the Foyer stays where it is.
  const exempt = rules.shift?.exemptRooms ?? [];
  if (rules.shift && !exempt.includes(rules.startRoom)) {
    rules.shift.exemptRooms = [rules.startRoom, ...exempt];
  }

  const { rules: _ignored, ...own } = scenario;
  return {
    ...rules,
    ...own,
    story: scenario.story ?? null,
    monsters: scenario.monsters ?? [],
    endgame: scenario.endgame ?? null,
  };
}
const CORNER_SPACES = [1, 3, 7, 9];
const EDGE_SPACES = [2, 4, 6, 8];
const FLIP_RULES = ['end-of-next-round', 'second-player', 'end-turn-adjacent'];

function parsePlacement(value, id) {
  const text = (value ?? '').trim();
  if (text === 'none') return { kind: 'none' };
  if (['random', 'corners', 'edges', 'nearest', 'farthest'].includes(text)) {
    return { kind: text };
  }

  const match = /^spaces?:([0-9]+(?:\+[0-9]+)*)$/.exec(text);
  if (!match) {
    throw new Error(
      `entrance card "${id}" has "${text}" for its placement, which is not something the table can do`,
    );
  }
  const spaces = match[1].split('+').map(Number);
  for (const n of spaces) {
    if (!Number.isInteger(n) || n < 1 || n > SPACE_NUMBERS) {
      throw new Error(
        `entrance card "${id}" places a card on square ${n}; the squares are 1-${SPACE_NUMBERS}`,
      );
    }
  }
  if (new Set(spaces).size !== spaces.length) {
    throw new Error(`entrance card "${id}" puts two cards on the same square`);
  }
  return { kind: 'fixed', spaces };
}

function parseSpecials(value, id) {
  const out = {
    discardOne: false,
    playerChoice: false,
    shiftPoints: 0,
    ifMonsterSpace: null,
    flip: null,
  };

  for (const token of (value ?? '').split('|').map((t) => t.trim()).filter(Boolean)) {
    if (token === 'discard-one') {
      out.discardOne = true;
    } else if (token === 'player-choice') {
      out.playerChoice = true;
    } else if (token.startsWith('shift-point:')) {
      const n = Number(token.slice('shift-point:'.length));
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`entrance card "${id}" marks "${token}", which is not a number of points`);
      }
      out.shiftPoints += n;
    } else if (token.startsWith('if-monster:')) {
      const n = Number(token.slice('if-monster:'.length));
      if (!Number.isInteger(n) || n < 1 || n > SPACE_NUMBERS) {
        throw new Error(
          `entrance card "${id}" has "${token}"; the extra card needs a square 1-${SPACE_NUMBERS}`,
        );
      }
      out.ifMonsterSpace = n;
    } else if (token.startsWith('flip:')) {
      const rule = token.slice('flip:'.length);
      if (!FLIP_RULES.includes(rule)) {
        throw new Error(
          `entrance card "${id}" flips on "${rule}", which is not one of ${FLIP_RULES.join(', ')}`,
        );
      }
      out.flip = rule;
    } else {
      throw new Error(`entrance card "${id}" has an unknown instruction "${token}"`);
    }
  }
  return out;
}

/**
 * Turn the entrance CSV into a map of id -> card.
 * Expected columns: id, draw, face, placement, special, text.
 */
export function entrancesFromCsv(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error('entrance CSV is empty');

  const column = (name) => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`entrance CSV is missing the "${name}" column`);
    return index;
  };

  const iId = column('id');
  const iDraw = column('draw');
  const iFace = column('face');
  const iPlace = column('placement');
  const iSpecial = column('special');
  const iText = column('text');

  const cards = {};

  for (const row of rows) {
    const id = (row[iId] ?? '').trim();
    if (!id) continue;
    if (cards[id]) throw new Error(`entrance CSV has a duplicate id: "${id}"`);

    const draw = Number((row[iDraw] ?? '').trim());
    if (!Number.isInteger(draw) || draw < 0 || draw > 3) {
      throw new Error(`entrance card "${id}" draws ${row[iDraw]} cards; it can only draw 0-3`);
    }

    const face = (row[iFace] ?? '').trim();
    if (face !== 'up' && face !== 'down') {
      throw new Error(`entrance card "${id}" says "${face}"; a card is placed up or down`);
    }

    const placement = parsePlacement(row[iPlace], id);
    if (placement.kind === 'none' && draw !== 0) {
      throw new Error(`entrance card "${id}" draws ${draw} cards but places none`);
    }
    if (placement.kind === 'fixed' && placement.spaces.length !== draw) {
      throw new Error(
        `entrance card "${id}" draws ${draw} card(s) but names ${placement.spaces.length} square(s)`,
      );
    }

    cards[id] = {
      id,
      draw,
      face,
      placement,
      specials: parseSpecials(row[iSpecial], id),
      text: (row[iText] ?? '').trim(),
    };
  }

  if (Object.keys(cards).length === 0) throw new Error('entrance CSV has no cards');
  return cards;
}

/**
 * Turn the encounter CSV into a map of id -> card.
 * Expected columns: id, type — nothing else. A card names a kind, not an
 * effect; the effect lives in that kind's own deck.
 */
export function encountersFromCsv(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error('encounter CSV is empty');

  const column = (name) => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`encounter CSV is missing the "${name}" column`);
    return index;
  };

  const iId = column('id');
  const iType = column('type');

  const cards = {};
  for (const row of rows) {
    const id = (row[iId] ?? '').trim();
    if (!id) continue;
    if (cards[id]) throw new Error(`encounter CSV has a duplicate id: "${id}"`);

    const type = (row[iType] ?? '').trim().toLowerCase();
    if (!ENCOUNTER_TYPES.includes(type)) {
      throw new Error(
        `encounter card "${id}" is a "${type}"; a card is one of ${ENCOUNTER_TYPES.join(', ')}`,
      );
    }
    cards[id] = { id, type };
  }

  if (Object.keys(cards).length === 0) throw new Error('encounter CSV has no cards');
  return cards;
}

/* ------------------------------------------------------------------ *
 * Item cards
 *
 * An encounter card that says Item does not say what the item is: it sends you
 * to the item deck, and the card you turn over there replaces it. So the item
 * deck is data like every other — one CSV — and the investigator keeps the card
 * until they spend it.
 *
 * Two columns do the work. `effect` is what the house can already carry out, in
 * tokens: `clue:1`, `move:2`, `shift:1`, `action:1`, `reveal-room`. A card that
 * asks for a die writes a roll instead, and the branches are the whole effect:
 *
 *   roll:d6/1-3:sanity:-1/4-6:clue:+1
 *
 * `needs` names the rule a card is waiting for — monster, event, player, dice,
 * lock, placement, reorder — so that a card whose rule is not in the game yet is
 * never silently inert: the table is told exactly what is missing.
 * ------------------------------------------------------------------ */

const ITEM_COUNTS = [
  'move',
  'clue',
  'shift',
  'action',
  'health',
  'sanity',
  'pull',
  'give-clue',
];

/** One effect is written with a hyphen; the rest are their own name. */
const ITEM_KEY = { 'give-clue': 'giveClue' };

/** A ward is not a number of something; it stands in front of the next loss. */
const ITEM_WARDS = { 'sanity-shield': 'sanityShield', 'damage-shield': 'damageShield' };

const NEED_WORD = {
  monster: 'a monster',
  event: 'an Event card',
  player: 'another investigator',
  dice: 'a die roll',
  lock: 'a lock',
  placement: 'a room placed out of turn',
  reorder: 'the encounter deck put back in order',
  choice: 'a choice to make',
};

/**
 * A die roll written into an effect: `roll:d6/1-3:sanity:-1/4-6:clue:+1`.
 *
 * The first part names the die. Slashes separate the branches, and a branch is
 * `6:` or `1-3:` — the faces it answers to — followed by what happens on them.
 * A branch may hold two things, written with `;` between them. A face that no
 * branch names is a real outcome: the die is rolled, the number is said out
 * loud, and nothing follows. That is why a card that only bites high,
 * `roll:d6/5-6:clue:+1`, does nothing on a 2 rather than quietly doing the
 * wrong thing — and why a card needs no "else" written for the low faces.
 *
 * Bands are read strictly: backwards, overlapping, off the die, or empty of any
 * effect are all load errors in a deck a person edits by hand.
 */
function parseRoll(value, id, what, readBranch) {
  const [head, ...bands] = String(value)
    .split('/')
    .map((part) => part.trim());

  const die = /^(?:1)?d([1-9][0-9]*)$/.exec(head ?? '');
  if (!die) {
    throw new Error(
      `${what} "${id}" rolls "${head}", which is not a die; write d6 for one six-sided die`,
    );
  }
  const size = Number(die[1]);
  if (bands.length === 0) {
    throw new Error(
      `${what} "${id}" rolls a d${size} but names no band to answer to; write roll:d${size}/1-3:...`,
    );
  }

  const branches = [];
  for (const band of bands) {
    if (!band) throw new Error(`${what} "${id}" has an empty band in its roll: "${value}"`);

    const colon = band.indexOf(':');
    const faces = (colon === -1 ? band : band.slice(0, colon)).trim();
    const body = colon === -1 ? '' : band.slice(colon + 1).trim();

    const range = /^([1-9][0-9]*)(?:-([1-9][0-9]*))?$/.exec(faces);
    if (!range) {
      throw new Error(
        `${what} "${id}" answers to "${faces}"; a band is a face like 6 or a range like 1-3`,
      );
    }
    const min = Number(range[1]);
    const max = range[2] ? Number(range[2]) : min;
    if (min > max) {
      throw new Error(`${what} "${id}" has "${faces}" backwards; the low face comes first`);
    }
    if (max > size) {
      throw new Error(`${what} "${id}" answers to a ${max} on a d${size}`);
    }
    if (!body) {
      throw new Error(`${what} "${id}" has no effect on ${faces}; leave the band out instead`);
    }
    for (const other of branches) {
      if (min <= other.max && other.min <= max) {
        throw new Error(`${what} "${id}" answers to ${min}-${max} twice; bands cannot overlap`);
      }
    }

    branches.push({ min, max, ops: readBranch(body) });
  }
  return { kind: 'roll', die: size, branches };
}

function parseItemEffect(value, id) {
  const tokens = (value ?? '')
    .split('|')
    .map((t) => t.trim())
    .filter(Boolean);
  const rolls = tokens.filter((token) => token.startsWith('roll:'));

  // One roll per card: two rolls in a row would still be replayable, but the
  // second would have no card left to belong to, and the log would say nothing
  // about which die was which.
  if (rolls.length > 1) {
    throw new Error(`item "${id}" rolls a die ${rolls.length} times; a card rolls once`);
  }

  const out = parseItemFields(
    tokens.filter((token) => !token.startsWith('roll:')).join('|'),
    id,
  );
  if (rolls.length === 1) {
    // Inside a branch `;` holds two things together, because `|` already means
    // "and then this too" between the parts of a card.
    // A branch is one flat effect, but it is handed on as a list of one so that
    // an item's roll and an event's roll are carried out the same way.
    out.roll = parseRoll(rolls[0].slice('roll:'.length), id, 'item', (branch) => [
      parseItemFields(branch.replaceAll(';', '|'), id),
    ]);
  }
  return out;
}

/** The flat effect a card carries, read the way it always has been. */
function parseItemFields(value, id) {
  const out = {
    move: 0,
    clue: 0,
    shift: 0,
    action: 0,
    health: 0,
    sanity: 0,
    sanityShield: 0,
    damageShield: 0,
    pull: 0,
    giveClue: 0,
    revealRoom: false,
    hit: null,
    banish: null,
    bind: null,
    pushRooms: 0,
  };

  for (const token of (value ?? '').split('|').map((t) => t.trim()).filter(Boolean)) {
    if (token === 'reveal-room') {
      out.revealRoom = true;
      continue;
    }

    // hit:2@1 deals 2 damage to a monster up to 1 space away; banish@1 removes
    // one outright. Range 1 is the investigator's own square and the four next
    // to it.
    const bind = /^bind@([1-9])$/.exec(token);
    if (bind) {
      out.bind = { reach: Number(bind[1]) };
      continue;
    }
    const push = /^push-adjacent-rooms:([1-9])$/.exec(token);
    if (push) {
      out.pushRooms = Number(push[1]);
      continue;
    }

    const strike = /^(?:hit:([1-9][0-9]*)|banish)@([1-9])$/.exec(token);
    if (strike) {
      if (strike[1]) out.hit = { damage: Number(strike[1]), reach: Number(strike[2]) };
      else out.banish = { reach: Number(strike[2]) };
      continue;
    }

    const match = /^([a-z]+(?:-[a-z]+)?):([+-]?[0-9]+)$/.exec(token);
    if (!match) {
      throw new Error(
        `item "${id}" has "${token}" for an effect, which is not something the table can carry out`,
      );
    }
    const [, rawKey, amount] = match;
    const key = ITEM_KEY[rawKey] ?? rawKey;
    const n = Number(amount);

    if (ITEM_WARDS[rawKey]) {
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`item "${id}" puts "${amount}" wards on the table; a ward is one use`);
      }
      out[ITEM_WARDS[rawKey]] += n;
      continue;
    }

    if (!ITEM_COUNTS.includes(rawKey)) {
      throw new Error(
        `item "${id}" changes "${rawKey}"; it can only change ${ITEM_COUNTS.join(', ')}`,
      );
    }
    if (!Number.isInteger(n) || n === 0) {
      throw new Error(`item "${id}" changes ${key} by "${amount}", which is not a number of anything`);
    }
    out[key] += n;
  }
  return out;
}

function parseNeeds(value, id) {
  const needs = [];
  for (const token of (value ?? '').split('+').map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    // Health and Sanity are in the game now, so a card that claims to wait on
    // one of them is a card whose CSV has not caught up.
    if (token === 'health' || token === 'sanity') {
      throw new Error(
        `"${id}" waits on ${token}, but Health and Sanity are in the game now — give it an effect instead`,
      );
    }
    if (!NEED_WORD[token]) {
      throw new Error(
        `item "${id}" waits on "${token}", which is not one of ${Object.keys(NEED_WORD).join(', ')}`,
      );
    }
    if (!needs.includes(token)) needs.push(token);
  }
  return needs;
}

/**
 * Turn the item CSV into a map of id -> card.
 * Expected columns: id, name, text, and — if the deck has them — effect, needs.
 */
export function itemsFromCsv(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error('item CSV is empty');

  const column = (name, required = true) => {
    const index = header.indexOf(name);
    if (index === -1) {
      if (required) throw new Error(`item CSV is missing the "${name}" column`);
      return -1;
    }
    return index;
  };

  const iId = column('id');
  const iName = column('name');
  const iText = column('text');
  const iEffect = column('effect', false);
  const iNeeds = column('needs', false);

  const cards = {};
  for (const row of rows) {
    const id = (row[iId] ?? '').trim();
    if (!id) continue;
    if (cards[id]) throw new Error(`item CSV has a duplicate id: "${id}"`);

    const name = (row[iName] ?? '').trim();
    if (!name) throw new Error(`item "${id}" has no name`);

    cards[id] = {
      id,
      name,
      effect: parseItemEffect(iEffect === -1 ? '' : row[iEffect], id),
      needs: parseNeeds(iNeeds === -1 ? '' : row[iNeeds], id),
      text: (row[iText] ?? '').trim(),
    };
  }

  if (Object.keys(cards).length === 0) throw new Error('item CSV has no items');
  return cards;
}

/* ------------------------------------------------------------------ *
 * Investigators
 *
 * One CSV for the sheets. A sheet carries the numbers the rest of the game
 * asks for — Health, Sanity, how many clue tokens can be carried — so a new
 * investigator is a row and not a code change. The trait lives on the sheet too,
 * and `traitNeeds` says in plain words what it is waiting for: a trait whose rule
 * is not in the game yet is never silently inert, the same rule as an item or an
 * event.
 * ------------------------------------------------------------------ */

/**
 * The rule behind each trait. A sheet names one in its `ability` column; the
 * words on the card stay in `traitText`, for the table to read.
 *
 *   logical-detachment    once per round, ignore the first Sanity loss from an Event
 *   steel-nerves          once per turn, reroll a failed Flee
 *   whispers-from-beyond  once per round, as an action, look at the top Encounter card
 *   field-medic           an adjacent investigator who regains Health regains 1 more
 *   hunches               once per turn, a free step after Investigating
 *   bartered-insight      as an action, spend 2 Clues to regain 1 Sanity
 */
const ABILITIES = {
  'logical-detachment': { active: false },
  'steel-nerves': { active: false },
  'whispers-from-beyond': { active: true, label: 'Look at the top Encounter card' },
  'field-medic': { active: false },
  hunches: { active: false },
  'bartered-insight': { active: true, label: 'Spend 2 Clues to regain 1 Sanity' },
};

function readAbility(value, id) {
  const text = (value ?? '').trim();
  if (text === '') return null;
  if (!ABILITIES[text]) {
    throw new Error(
      `investigator "${id}" has the ability "${text}", which is not one of ${Object.keys(ABILITIES).join(', ')}`,
    );
  }
  return text;
}

export function investigatorsFromCsv(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error('investigator CSV is empty');

  const column = (name, required = true) => {
    const index = header.indexOf(name);
    if (index === -1) {
      if (required) throw new Error(`investigator CSV is missing the "${name}" column`);
      return -1;
    }
    return index;
  };

  const iId = column('id');
  const iName = column('name');
  const iRole = column('role', false);
  const iHealth = column('health');
  const iSanity = column('sanity');
  const iClueLimit = column('clueLimit');
  const iTrait = column('trait', false);
  const iTraitText = column('traitText', false);
  const iTraitNeeds = column('traitNeeds', false);
  const iAbility = column('ability', false);
  const iBio = column('bio', false);

  const wholeNumber = (row, index, id, what) => {
    const raw = (row[index] ?? '').trim();
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`investigator "${id}" has "${raw}" for ${what}, which is not a number of ${what}`);
    }
    return n;
  };

  const sheets = {};
  for (const row of rows) {
    const id = (row[iId] ?? '').trim();
    if (!id) continue;
    if (sheets[id]) throw new Error(`investigator CSV has a duplicate id: "${id}"`);

    const name = (row[iName] ?? '').trim();
    if (!name) throw new Error(`investigator "${id}" has no name`);

    sheets[id] = {
      id,
      name,
      role: (row[iRole] ?? '').trim(),
      health: wholeNumber(row, iHealth, id, 'Health'),
      sanity: wholeNumber(row, iSanity, id, 'Sanity'),
      clueLimit: wholeNumber(row, iClueLimit, id, 'Clue Limit'),
      trait: (row[iTrait] ?? '').trim(),
      traitText: (row[iTraitText] ?? '').trim(),
      ability: readAbility(iAbility === -1 ? '' : row[iAbility], id),
      traitNeeds: (row[iTraitNeeds] ?? '').trim(),
      bio: (row[iBio] ?? '').trim(),
    };
  }

  if (Object.keys(sheets).length === 0) throw new Error('investigator CSV has no investigators');
  return sheets;
}

/* ------------------------------------------------------------------ *
 * Event cards
 *
 * An encounter card that says Event sends you to the event deck, and the card
 * that comes off it is read out and played before it is put aside: unlike an
 * item, it is never kept. So an event is a die roll and a short instruction,
 * which is exactly what the CSV carries.
 *
 *   roll    1-3, 5-6, 6 — the band of the d6 that makes it happen. Blank means
 *           the card always happens.
 *   effect  what happens, in tokens: clue:+1, clue:-1, item:+1, step:+2,
 *           teleport:random-room, teleport:foyer, rotate:nearest,
 *           investigate-fails, discard-item, swap. Blank means the card waits
 *           on a rule the house does not have yet, which `needs` names.
 *
 * The roll column is the short way to write a card with one band. A card with
 * two outcomes writes the die into the effect instead and leaves the column
 * blank: `roll:d6/1-3:sanity:-1/4-6:clue:+1`. Both are the same op once the
 * deck is read — the column is compiled into it — so there is one dice path.
 * ------------------------------------------------------------------ */

const EVENT_OPS = [
  'clue',
  'item',
  'step',
  'health',
  'sanity',
  'teleport',
  'rotate',
  'investigate-fails',
  'shuffle-back',
  'discard-item',
  'swap',
  'monster',
  'monsters-move',
  'engaged-attack',
];

function parseEventRoll(value, id) {
  const text = (value ?? '').trim();
  if (text === '') return null;

  const match = /^([1-6])(?:-([1-6]))?$/.exec(text);
  if (!match) {
    throw new Error(`event "${id}" rolls "${text}", which is not a d6 band like 1-3 or 6`);
  }
  const min = Number(match[1]);
  const max = match[2] ? Number(match[2]) : min;
  if (min > max) {
    throw new Error(`event "${id}" rolls "${text}" backwards; the low number comes first`);
  }
  return { min, max };
}

function parseEventEffect(value, id) {
  const ops = [];

  for (const token of (value ?? '').split('|').map((t) => t.trim()).filter(Boolean)) {
    if (token.startsWith('roll:')) {
      ops.push(
        parseRoll(token.slice('roll:'.length), id, 'event', (branch) => parseEventOps(branch, id)),
      );
      continue;
    }

    if (token === 'investigate-fails') {
      ops.push({ kind: 'investigate-fails' });
      continue;
    }

    if (token === 'shuffle-back') {
      ops.push({ kind: 'shuffle-back' });
      continue;
    }

    if (token === 'discard-item' || token === 'swap') {
      ops.push({ kind: token });
      continue;
    }

    const match = /^([a-z-]+):(.*)$/.exec(token);
    if (!match) {
      throw new Error(`event "${id}" has "${token}" for an effect, which is not something the table can do`);
    }
    const [, kind, argument] = match;
    if (!EVENT_OPS.includes(kind)) {
      throw new Error(`event "${id}" has "${token}"; an event can ${EVENT_OPS.join(', ')}`);
    }

    if (['clue', 'item', 'step', 'health', 'sanity'].includes(kind)) {
      const n = Number(argument);
      if (!Number.isInteger(n) || n === 0) {
        throw new Error(`event "${id}" changes ${kind} by "${argument}", which is not a number of anything`);
      }
      ops.push({ kind, n });
    } else if (kind === 'monster') {
      if (!['room', 'adjacent'].includes(argument)) {
        throw new Error(`event "${id}" spawns a monster "${argument}"; write monster:room or monster:adjacent`);
      }
      ops.push({ kind, where: argument });
    } else if (kind === 'engaged-attack') {
      const n = Number(argument);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`event "${id}" has engaged monsters deal "${argument}", which is not an amount of damage`);
      }
      ops.push({ kind, n });
    } else if (kind === 'monsters-move') {
      const n = Number(argument);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`event "${id}" moves monsters "${argument}" spaces, which is not a number of spaces`);
      }
      ops.push({ kind, n });
    } else if (kind === 'teleport') {
      if (!['random-room', 'foyer'].includes(argument)) {
        throw new Error(`event "${id}" teleports to "${argument}", which is not somewhere this house knows`);
      }
      ops.push({ kind, where: argument });
    } else {
      if (argument !== 'nearest') {
        throw new Error(`event "${id}" rotates "${argument}"; the only room it knows how to find is the nearest one`);
      }
      ops.push({ kind, where: argument });
    }
  }
  return ops;
}

/**
 * One `;`-separated branch of a die roll: the same tokens, all on one band.
 * Reading each part with the ordinary reader means a branch can do anything a
 * whole card can — including opening a choice.
 */
function parseEventOps(text, id) {
  return text
    .split(';')
    .map((token) => token.trim())
    .filter(Boolean)
    .flatMap((token) => parseEventEffect(token, id));
}

/**
 * Some cards only bite under a condition: "If you have no items" or "If your
 * Sanity is 3 or less". It is one column, and it is read strictly so a typo
 * cannot quietly turn a card into one that always fires.
 */
function parseEventWhen(value, id) {
  const text = (value ?? '').trim().toLowerCase();
  if (text === '') return null;
  if (text === 'no-items') return { kind: 'no-items' };

  const match = /^(health|sanity)<=([0-9]+)$/.exec(text);
  if (!match) {
    throw new Error(
      `event "${id}" waits on "${value}"; the when column takes no-items, health<=N or sanity<=N`,
    );
  }
  return { kind: match[1], atMost: Number(match[2]) };
}

/** Is the card's condition met for this investigator? */
function whenHolds(player, when) {
  if (!when) return true;
  if (when.kind === 'no-items') return (player.items ?? []).length === 0;
  return typeof player[when.kind] === 'number' && player[when.kind] <= when.atMost;
}

/** The condition in words, for the log when it is not met. */
function describeWhen(when) {
  if (when.kind === 'no-items') return 'nothing at all is being carried';
  return `${when.kind === 'sanity' ? 'Sanity' : 'Health'} is ${when.atMost} or less`;
}

/**
 * Turn the event CSV into a map of id -> card.
 * Expected columns: id, text, and — if the deck has them — roll, effect, needs.
 */
export function eventsFromCsv(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error('event CSV is empty');

  const column = (name, required = true) => {
    const index = header.indexOf(name);
    if (index === -1) {
      if (required) throw new Error(`event CSV is missing the "${name}" column`);
      return -1;
    }
    return index;
  };

  const iId = column('id');
  const iText = column('text');
  const iRoll = column('roll', false);
  const iEffect = column('effect', false);
  const iWhen = column('when', false);
  const iNeeds = column('needs', false);

  const cards = {};
  for (const row of rows) {
    const id = (row[iId] ?? '').trim();
    if (!id) continue;
    if (cards[id]) throw new Error(`event CSV has a duplicate id: "${id}"`);

    cards[id] = {
      id,
      roll: parseEventRoll(iRoll === -1 ? '' : row[iRoll], id),
      effect: parseEventEffect(iEffect === -1 ? '' : row[iEffect], id),
      when: parseEventWhen(iWhen === -1 ? '' : row[iWhen], id),
      needs: parseNeeds(iNeeds === -1 ? '' : row[iNeeds], id),
      text: (row[iText] ?? '').trim(),
    };
  }

  if (Object.keys(cards).length === 0) throw new Error('event CSV has no events');
  return cards;
}

/**
 * Roll a die and carry out whichever band answers to the face.
 *
 * The face is kept on the state as `lastRoll` — what was rolled, on which die,
 * and by which card — because a card that mirrors or undoes a roll needs to
 * know what it is looking at.
 */
function runRoll(state, roll, runOp, source) {
  const value = randomInt(state, roll.die) + 1;
  const branch = roll.branches.find((band) => value >= band.min && value <= band.max);

  pushLog(state, `The die comes up ${value}${branch ? '' : ' — nothing follows'}.`);
  state.lastRoll = { value, die: roll.die, source };

  if (branch) for (const op of branch.ops) runOp(op);
  return value;
}

/**
 * Read an event out and do what it says.
 *
 * The die is rolled first, because most of the deck is "nothing follows" — the
 * card is only half the card without the roll. A card whose `needs` is not empty
 * never reaches here: it was read and put aside with a note about the missing
 * rule in collectEncounter.
 */
function playEvent(state, ctx, event, player) {
  // A conditional card is read out and then does nothing if the table does not
  // meet the condition — which is not the same as being pending.
  if (!whenHolds(player, event.when)) {
    pushLog(
      state,
      `The card only bites when ${describeWhen(event.when)}; that is not the case here, so nothing follows.`,
    );
    return;
  }

  // The roll column is the short form of the same op, so a card read from the
  // column and a card that writes its die into the effect roll identically.
  const ops = event.roll
    ? [
        {
          kind: 'roll',
          die: 6,
          branches: [{ min: event.roll.min, max: event.roll.max, ops: event.effect }],
        },
      ]
    : event.effect;

  for (const op of ops) applyEventOp(state, ctx, op, player);
}

function applyEventOp(state, ctx, op, player) {
  if (op.kind === 'roll') {
    runRoll(state, op, (inner) => applyEventOp(state, ctx, inner, player), 'an event');
    return;
  }

  if (op.kind === 'health' || op.kind === 'sanity') {
    changePool(state, player, op.kind, op.n, 'this event');
    return;
  }

  if (op.kind === 'discard-item') {
    const held = player.items ?? [];
    if (held.length === 0) {
      pushLog(state, 'There is nothing in hand to give up.');
      return;
    }
    beginChoice(state, {
      kind: 'discard-item',
      playerId: player.id,
      prompt: 'The card asks for something out of your hand. Which do you give up?',
      options: held.map((id) => ({ id, label: ctx.items?.[id]?.name ?? id })),
    });
    return;
  }

  if (op.kind === 'swap') {
    const others = onTable(state).filter((someone) => someone.id !== player.id);
    if (others.length === 0) {
      pushLog(state, 'There is nobody else here to trade places with.');
      return;
    }
    beginChoice(state, {
      kind: 'swap',
      playerId: player.id,
      prompt: 'The house offers a swap. Who changes places with you?',
      options: others.map((someone) => ({ id: someone.id, label: someone.name })),
    });
    return;
  }

  if (op.kind === 'clue') {
    const held = player.clues ?? 0;
    if (op.n > 0) {
      player.clues = held + op.n;
      pushLog(state, `That is ${op.n} clue${op.n === 1 ? '' : 's'} to the good.`);
      return;
    }
    if (held === 0) {
      pushLog(state, 'There is no clue token to give up.');
      return;
    }
    const lost = Math.min(held, -op.n);
    player.clues = held - lost;
    pushLog(state, `${lost} clue token${lost === 1 ? '' : 's'} given up.`);
    return;
  }

  if (op.kind === 'item') {
    let taken = null;
    for (let i = 0; i < op.n; i++) {
      const id = drawFrom(state, 'itemDeck', 'itemDiscard', 'item');
      if (id === null) break;
      player.items ??= [];
      player.items.push(id);
      taken = id;
    }
    pushLog(
      state,
      taken === null
        ? 'There is no item left to take.'
        : `An item is taken — ${ctx.items?.[taken]?.name ?? taken}.`,
    );
    return;
  }

  if (op.kind === 'step') {
    state.stepsLeft += op.n;
    pushLog(state, `${op.n} space${op.n === 1 ? '' : 's'} of movement is in hand.`);
    return;
  }

  if (op.kind === 'investigate-fails') {
    state.investigatePenalty = (state.investigatePenalty ?? 0) + 1;
    pushLog(state, 'The next Investigate action will fail.');
    return;
  }

  if (op.kind === 'monster') {
    const squares =
      op.where === 'room'
        ? squaresInRoom(slotOf(player.pos))
        : DIRS.map((dir) => ({ gr: player.pos.gr + dir.dr, gc: player.pos.gc + dir.dc }));
    const open = squares.filter((pos) => roomEntryAt(state, slotOf(pos)));
    if (open.length === 0) {
      pushLog(state, 'There is nowhere on the table for a monster to appear.');
      return;
    }
    spawnMonster(state, ctx, open[randomInt(state, open.length)], 'it is summoned');
    return;
  }

  if (op.kind === 'engaged-attack') {
    let any = false;
    for (const someone of onTable(state)) {
      for (const monster of engagedWith(state, someone)) {
        any = true;
        monsterHits(state, monster, someone, op.n);
      }
    }
    if (!any) pushLog(state, 'Nobody is engaged with a monster, so nothing strikes.');
    return;
  }

  if (op.kind === 'monsters-move') {
    moveMonstersTowardPlayers(state, ctx, op.n);
    return;
  }

  if (op.kind === 'teleport') {
    if (op.where === 'foyer') {
      const home = startPosition(state, ctx);
      if (home) {
        player.pos = home;
        pushLog(state, `${player.name} is back in the ${ctx.rooms[ctx.scenario.startRoom].name}.`);
        return;
      }
      pushLog(state, 'The Foyer is not on the table, so there is nowhere to go.');
      return;
    }

    const here = slotOf(player.pos);
    const elsewhere = Object.keys(state.rooms).filter((id) => id !== roomKey(here.R, here.C));
    if (elsewhere.length === 0) {
      pushLog(state, 'Nothing else has been revealed, so there is nowhere to go.');
      return;
    }
    const [R, C] = elsewhere[randomInt(state, elsewhere.length)].split(',').map(Number);
    const spot = freeSquareIn(state, { R, C }, player);
    player.pos = posOf(R, C, spot.r, spot.c);
    const name = ctx.rooms[state.rooms[roomKey(R, C)].roomId].name;
    pushLog(state, `${player.name} is elsewhere — the ${name}.`);
    return;
  }

  if (op.kind === 'shuffle-back') {
    // "Shuffle one face-down Encounter Card in your room back into the deck." The
    // card on a square is a particular card, dealt when it was laid down, so it
    // can go back where it came from and leave the square empty.
    const room = slotOf(player.pos);
    const at = roomKey(room.R, room.C);
    const key = Object.keys(state.encounters).find(
      (k) => state.encounters[k].room === at && !state.encounters[k].faceUp,
    );
    if (!key) {
      pushLog(state, 'There is nothing face down in this room to put back.');
      return;
    }
    const marker = state.encounters[key];
    state.encounterDeck.push(marker.cardId);
    state.encounterDeck = shuffle(state, state.encounterDeck);
    delete state.encounters[key];
    pushLog(
      state,
      `The face-down card on [${marker.number}] goes back into the encounter deck, which is shuffled.`,
    );
    return;
  }

  // rotate: the nearest room to the investigator that they are not standing in.
  const here = slotOf(player.pos);
  let nearest = null;
  for (const id of Object.keys(state.rooms)) {
    const [R, C] = id.split(',').map(Number);
    if (R === here.R && C === here.C) continue;
    const distance = Math.abs(R - here.R) + Math.abs(C - here.C);
    if (
      !nearest ||
      distance < nearest.distance ||
      (distance === nearest.distance && (R < nearest.R || (R === nearest.R && C < nearest.C)))
    ) {
      nearest = { R, C, distance };
    }
  }
  if (!nearest) {
    pushLog(state, 'There is no other room near enough to turn.');
    return;
  }
  rotateRoom(state, ctx, nearest);
}

/**
 * Turn one room a quarter clockwise, carrying everything inside it round: the
 * investigators standing on its squares and the cards lying on its floor.
 * Returns the slot it turned, or null if nothing is there.
 */
function rotateRoom(state, ctx, slot) {
  const entry = roomEntryAt(state, slot);
  if (!entry) return null;

  entry.rot = (entry.rot + 1) % 4;
  for (const token of [...onTable(state), ...(state.monsters ?? [])]) {
    const at = slotOf(token.pos);
    if (at.R === slot.R && at.C === slot.C) rotateWithRoom(token, slot);
  }
  rotateEncounterCards(state, slot);

  pushLog(state, `The ${ctx.rooms[entry.roomId].name} turns a quarter clockwise.`);
  return { R: slot.R, C: slot.C, roomId: entry.roomId, rot: entry.rot };
}

/**
 * Where to put someone who arrives in a room without walking: any square no
 * other investigator is standing on. Falls back to the middle, because a room
 * whose whole floor is occupied still has room for one more.
 */
function freeSquareIn(state, slot, player) {
  const taken = new Set(
    onTable(state).filter((p) => p.id !== player.id).map((p) => posKey(p.pos)),
  );

  const free = [];
  for (let r = 0; r < ROOM_SIZE; r++) {
    for (let c = 0; c < ROOM_SIZE; c++) {
      if (!taken.has(posKey(posOf(slot.R, slot.C, r, c)))) free.push({ r, c });
    }
  }
  if (free.length === 0) return { r: DOOR_AT, c: DOOR_AT };
  return free[randomInt(state, free.length)];
}

/* ------------------------------------------------------------------ *
 * Doors and rotation
 * ------------------------------------------------------------------ */

/**
 * Where a door ends up after `rot` clockwise quarter-turns.
 *
 * Rotating the card clockwise sends a north door to the east side, an east door
 * to the south side. A north or south door keeps its position along the side;
 * an east or west door has its position mirrored, because the card turned.
 */
function rotateEdge(dir, offset, rot) {
  let edge = dir;
  let index = offset;
  for (let i = 0; i < rot; i++) {
    if (edge === 'n') {
      edge = 'e';
    } else if (edge === 'e') {
      edge = 's';
      index = ROOM_SIZE - 1 - index;
    } else if (edge === 's') {
      edge = 'w';
    } else {
      edge = 'n';
      index = ROOM_SIZE - 1 - index;
    }
  }
  return { dir: edge, offset: index };
}

/**
 * Every door of a room as it stands on the table at rotation `rot`:
 * { n: [bool, bool, bool], e: [...], s: [...], w: [...] }.
 */
export function doorsAt(room, rot) {
  // Every side has to exist before any door is written onto it: a turned door
  // lands on a side that may not have been visited yet.
  const out = {};
  for (const dir of DIR_KEYS) out[dir] = new Array(ROOM_SIZE).fill(false);

  for (const dir of DIR_KEYS) {
    for (let offset = 0; offset < ROOM_SIZE; offset++) {
      if (!room.doors[dir][offset]) continue;
      const turned = rotateEdge(dir, offset, rot);
      out[turned.dir][turned.offset] = true;
    }
  }
  return out;
}

/** How many distinct openings a room presents at that rotation. */
function openingsAt(room, rot) {
  const doors = doorsAt(room, rot);
  return DIR_KEYS.reduce((n, dir) => n + doors[dir].filter(Boolean).length, 0);
}

/* ------------------------------------------------------------------ *
 * Deterministic randomness
 * ------------------------------------------------------------------ */

function normaliseSeed(seed) {
  const value = Number(seed) >>> 0;
  return value === 0 ? 0x9e3779b9 : value;
}

/** xorshift32. Advances state.rngState and returns a 32-bit unsigned int. */
function nextRandom(state) {
  let x = state.rngState >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  if (x === 0) x = 0x9e3779b9;
  state.rngState = x;
  return x;
}

function randomInt(state, n) {
  return nextRandom(state) % n;
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

export function createGame(ctx, options = {}) {
  const { scenario, rooms } = ctx;
  if (!scenario) throw new Error('createGame needs a scenario');
  if (!rooms) throw new Error('createGame needs rooms');

  const [startSlotR, startSlotC] = scenario.startSlot ?? [0, 0];
  const [startR, startC] = scenario.startSpace ?? [1, 1];

  if (!rooms[scenario.startRoom]) {
    throw new Error(`scenario.startRoom "${scenario.startRoom}" is not in the room deck`);
  }
  if (startR < 0 || startC < 0 || startR >= ROOM_SIZE || startC >= ROOM_SIZE) {
    throw new Error('scenario.startSpace must be inside the room, so 0-2 on each axis');
  }

  const seed = normaliseSeed(options.seed ?? Date.now());
  const count = options.playerCount ?? scenario.players.default ?? 2;
  if (count < scenario.players.min || count > scenario.players.max) {
    throw new Error(`this scenario takes ${scenario.players.min}-${scenario.players.max} players`);
  }
  const names =
    options.playerNames ?? Array.from({ length: count }, (_, i) => `Investigator ${i + 1}`);

  // A seat can be filled from the investigator deck: the sheet brings the name,
  // the numbers and the trait, so nothing in here knows who Clara is.
  const sheets = ctx.investigators ?? null;
  let seats = null;
  if (sheets) {
    const available = Object.keys(sheets);
    if (available.length < count) {
      throw new Error(
        `this game needs ${count} investigators and the deck holds ${available.length}`,
      );
    }
    seats = options.investigatorIds ?? available.slice(0, count);
    if (seats.length !== count) {
      throw new Error(`${seats.length} investigator(s) were named for ${count} player(s)`);
    }
    if (new Set(seats).size !== seats.length) {
      throw new Error('the same investigator cannot take two seats');
    }
    for (const id of seats) {
      if (!sheets[id]) throw new Error(`there is no investigator "${id}"`);
    }
  }

  const start = posOf(startSlotR, startSlotC, startR, startC);

  // Not every room is somewhere the house hands you. The Rift Room is the end of
  // the story, so it is held out of the shuffle and put at the bottom of the
  // deck: the last card turned over, never a random draw.
  const heldBack = scenario.bossRoomAppearsLast ? scenario.bossRoom : null;
  if (heldBack) {
    if (!rooms[heldBack]) {
      throw new Error(`scenario.bossRoom "${heldBack}" is not in the room deck`);
    }
    if (heldBack === scenario.startRoom) {
      throw new Error('the boss room cannot also be the room the game starts in');
    }
  }

  const deck = Object.keys(rooms).filter(
    (id) => id !== scenario.startRoom && id !== heldBack,
  );

  const state = {
    scenarioId: scenario.id,
    seed,
    rngState: seed,
    round: 1,
    turnIndex: 0,
    actionsLeft: scenario.turn.actionsPerTurn,
    actionsPerTurn: scenario.turn.actionsPerTurn,
    moveRange: scenario.turn.moveRange,
    stepsLeft: 0,
    shift: { ...scenario.shift },
    encounterReveal: revealMode(scenario),
    shiftPressure: 0,
    drewThisTurn: false,
    entranceThisTurn: false,
    lastShift: null,
    players: Array.from({ length: count }, (_, i) => {
      const sheet = seats ? sheets[seats[i]] : null;
      const player = {
        id: `p${i + 1}`,
        name: sheet ? sheet.name : names[i] ?? `Investigator ${i + 1}`,
        pos: { ...start },
        items: [],
        // Clue tokens are held, not pooled: the sheet's Clue Limit is what one
        // investigator can carry.
        clues: 0,
      };
      if (!sheet) return player;
      return {
        ...player,
        investigatorId: sheet.id,
        role: sheet.role,
        health: sheet.health,
        healthMax: sheet.health,
        sanity: sheet.sanity,
        sanityMax: sheet.sanity,
        clueLimit: sheet.clueLimit,
        ability: sheet.ability ?? null,
      };
    }),
    rooms: { [roomKey(startSlotR, startSlotC)]: { roomId: scenario.startRoom, rot: 0 } },
    roomDeck: [],
    entranceDeck: [],
    entranceSeen: [],
    encounterDeck: [],
    encounterDiscard: [],
    itemDeck: [],
    itemDiscard: [],
    eventDeck: [],
    eventDiscard: [],
    investigatePenalty: 0,
    encounters: {},
    shiftTokens: 0,
    lastEntrance: null,
    pending: null,
    choice: null,
    // Who has been played this game, so a fallen investigator is not dealt again.
    usedInvestigators: seats ? [...seats] : [],
    // Everything standing on the board that is not an investigator: monsters
    // from the scenario's deck, investigators the house has kept, and the boss.
    monsters: [],
    nextMonster: 1,
    monsterDeck: [],
    monsterDiscard: [],
    boss: null,
    sealClues: 0,
    turnLost: null,
    over: null,
    log: [],
  };

  // Shuffle once the state exists, so the deck order is drawn from the same RNG
  // position that every later draw advances.
  state.roomDeck = shuffle(state, deck);
  // Draws take from the end, so index 0 is the bottom of the deck.
  if (heldBack) state.roomDeck.unshift(heldBack);

  // The room entrance deck, if this scenario brings one. It is shuffled after
  // the rooms so that adding this deck cannot change the order rooms come out
  // of the house.
  const entranceIds = ctx.entrances
    ? Object.keys(ctx.entrances).sort((a, b) => Number(a) - Number(b))
    : [];
  state.entranceDeck = shuffle(state, entranceIds);

  // The encounter deck is shuffled last, so a table that leaves it out gets the
  // same rooms and the same entrance cards out of the same seed.
  const encounterIds = ctx.encounterCards
    ? Object.keys(ctx.encounterCards).sort((a, b) => Number(a) - Number(b))
    : [];
  // More investigators, more clues to find: the rules may add Clue cards to the
  // encounter deck for each one at the table.
  const extraClues = ctx.encounterCards ? (scenario.encounters?.extraCluesPerPlayer ?? 0) * count : 0;
  for (let i = 1; i <= extraClues; i++) encounterIds.push(`extra-clue-${i}`);
  state.encounterDeck = shuffle(state, encounterIds);

  // The item deck is shuffled last for the same reason: a table that brings no
  // items still gets the same house and the same cards out of the same seed.
  const itemIds = ctx.items
    ? Object.keys(ctx.items).sort((a, b) => Number(a) - Number(b))
    : [];
  state.itemDeck = shuffle(state, itemIds);

  // And the event deck last of the three, for the same reason again.
  const eventIds = ctx.events
    ? Object.keys(ctx.events).sort((a, b) => Number(a) - Number(b))
    : [];
  state.eventDeck = shuffle(state, eventIds);

  // The scenario's monster deck, shuffled last of all for the same reason.
  const monsterIds = ctx.monsterCards
    ? Object.keys(ctx.monsterCards).sort((a, b) => Number(a) - Number(b))
    : [];
  state.monsterDeck = shuffle(state, monsterIds);

  pushLog(
    state,
    `The Foyer. ${names.length} investigator${names.length === 1 ? '' : 's'} begin here. Seed ${seed}.`,
  );
  return state;
}

/** An encounter card by id, including the extra Clue cards added at setup. */
function encounterCardOf(ctx, id) {
  if (String(id).startsWith('extra-clue-')) return { id, type: 'clue' };
  return ctx.encounterCards?.[id] ?? null;
}

function shuffle(state, list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(state, i + 1);
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

/* ------------------------------------------------------------------ *
 * Small state helpers
 * ------------------------------------------------------------------ */

export function currentPlayer(state) {
  return state.players[state.turnIndex];
}

function roomEntryAt(state, slot) {
  return state.rooms[roomKey(slot.R, slot.C)] ?? null;
}

function pushLog(state, text) {
  state.log.push(text);
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}

/** Turn a player's position as the card turns, so they stay on their square. */
function rotateWithRoom(player, slot) {
  const local = localOf(player.pos);
  player.pos = posOf(slot.R, slot.C, local.c, ROOM_SIZE - 1 - local.r);
}

/* ------------------------------------------------------------------ *
 * Movement legality
 * ------------------------------------------------------------------ */

/**
 * Why the player cannot step from `from` to `to`, or null if they can.
 *
 * A step inside one room is free. A step that crosses into another room has to
 * pass a door in the room being left, and — if the room beyond has been placed
 * — a door in the room being entered, at the same position along the shared
 * side. That second check is the whole mechanic.
 */
export function stepProblem(state, from, to, ctx) {
  const dir = travelDir(from, to);
  if (!dir) return 'that space does not share an edge with the current one';

  // "You cannot move through walls or through Monsters."
  const blocker = (state.monsters ?? []).find((m) => m.pos.gr === to.gr && m.pos.gc === to.gc);
  if (blocker) return `${theName(blocker.name)} stands in the way`;

  const here = slotOf(from);
  const there = slotOf(to);
  if (here.R === there.R && here.C === there.C) return null;

  const source = roomEntryAt(state, here);
  if (!source) return 'you are standing in an unexplored part of the house';
  const sourceRoom = ctx.rooms[source.roomId];

  if (!doorsAt(sourceRoom, source.rot)[dir][DOOR_AT]) {
    return `the ${sourceRoom.name} has no door on its ${DIR_WORD[dir]} side`;
  }
  // The door is the middle of the side, so the wall either side of it is still
  // wall even when that side has a door. You have to walk to the middle.
  if (edgeOffset(from, dir) !== DOOR_AT) {
    return `the ${sourceRoom.name} opens ${DIR_WORD[dir]} only at the middle of that side`;
  }

  const back = OPPOSITE[dir];
  const target = roomEntryAt(state, there);

  if (target) {
    const targetRoom = ctx.rooms[target.roomId];
    if (!doorsAt(targetRoom, target.rot)[back][DOOR_AT]) {
      return `the ${targetRoom.name} has no door on its ${DIR_WORD[back]} side`;
    }
    return null;
  }

  // The room deck is the one deck that never replenishes: once every room is on
  // the table the house is finished, and there is nowhere further to walk.
  if (state.roomDeck.length === 0) {
    return 'the house is complete — there is no room left to turn over';
  }
  // One new room a turn. Without this, a player who has steps left after laying
  // a card down can walk straight through it and open a second room on the same
  // turn, which is not how the house is supposed to explore.
  if (state.drewThisTurn) {
    return 'you have already opened a new room this turn, so the dark beyond waits until your next turn';
  }
  return null;
}

/**
 * Every space the active player can reach with the steps they have left.
 * Returns [{ pos, path }]. The search does not walk on through unexplored
 * space: you cannot know what is there until a card has been turned.
 */
export function legalDestinations(state, ctx) {
  if (state.pending || state.choice || state.over) return [];
  if (engagedWith(state, currentPlayer(state)).length > 0) return [];

  const allowance =
    state.stepsLeft > 0 ? state.stepsLeft : state.actionsLeft > 0 ? state.moveRange : 0;
  if (allowance === 0) return [];

  const player = currentPlayer(state);
  const results = [];
  const seen = new Set([`${player.pos.gr},${player.pos.gc}`]);
  let frontier = [{ pos: player.pos, path: [] }];

  for (let depth = 0; depth < allowance; depth++) {
    const next = [];
    for (const node of frontier) {
      for (const dir of DIRS) {
        const to = { gr: node.pos.gr + dir.dr, gc: node.pos.gc + dir.dc };
        const id = `${to.gr},${to.gc}`;
        if (seen.has(id)) continue;
        if (stepProblem(state, node.pos, to, ctx)) continue;
        seen.add(id);
        const path = [...node.path, to];
        results.push({ pos: to, path });
        if (roomEntryAt(state, slotOf(to))) next.push({ pos: to, path });
      }
    }
    frontier = next;
  }
  return results;
}

/** Rotations that would let the drawn card meet the doorway it came through. */
export function pendingOrientations(state, ctx) {
  const pending = state.pending;
  if (!pending || pending.kind !== 'placeRoom') return [];
  const room = ctx.rooms[pending.roomId];
  if (!room) return [];

  const dir = travelDir(pending.from, pending.at);
  if (!dir) return [];
  const back = OPPOSITE[dir];

  const valid = [];
  for (let rot = 0; rot < 4; rot++) {
    if (doorsAt(room, rot)[back][DOOR_AT]) valid.push(rot);
  }
  return valid;
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export const ACTIONS = [
  'MOVE',
  'INVESTIGATE',
  'USE_ITEM',
  'PLACE_ROOM',
  'CHOOSE',
  'END_TURN',
  'ATTACK',
  'FLEE',
  'SEAL',
  'ROOM_SPECIAL',
  'USE_TRAIT',
];

/**
 * Apply one action and return the new state. Never mutates `state`.
 * Throws with a readable message if the action is not allowed.
 */
export function reduce(state, action, ctx) {
  if (!action || typeof action.type !== 'string') {
    throw new Error('an action must have a type');
  }
  if (state.over) throw new Error('the game is over');
  const next = structuredClone(state);

  // A card that asks a question owns the table until it is answered.
  if (next.choice && action.type !== 'CHOOSE') {
    throw new Error('answer the choice on the table before doing anything else');
  }

  // "While engaged, you may only Attack or Flee." Items cost no action and the
  // turn can still be ended.
  if (['MOVE', 'INVESTIGATE', 'SEAL', 'ROOM_SPECIAL', 'USE_TRAIT', 'FORCE_WALL'].includes(action.type)) {
    const held = engagedWith(next, currentPlayer(next));
    if (held.length > 0) {
      throw new Error(
        `${currentPlayer(next).name} is engaged with the ${held.map((m) => theName(m.name)).map((n) => n).join(' and ')} — Attack or Flee first`,
      );
    }
  }

  let out;
  switch (action.type) {
    case 'CHOOSE':
      out = doChoose(next, action, ctx);
      break;
    case 'MOVE':
      out = doMove(next, action, ctx);
      break;
    case 'PLACE_ROOM':
      out = doPlace(next, action, ctx);
      break;
    case 'INVESTIGATE':
      out = doInvestigate(next, ctx);
      break;
    case 'USE_ITEM':
      out = doUseItem(next, action, ctx);
      break;
    case 'END_TURN':
      out = doEndTurn(next, ctx);
      break;
    case 'SEAL':
      out = doSeal(next, ctx);
      break;
    case 'ROOM_SPECIAL':
      out = doRoomSpecial(next, ctx);
      break;
    case 'USE_TRAIT':
      out = doTrait(next, ctx);
      break;
    case 'FORCE_WALL':
      out = doForceWall(next, ctx, action.to);
      break;
    case 'ATTACK':
      out = doCombat(next, ctx, 'attack', action.monsterId);
      break;
    case 'FLEE':
      out = doCombat(next, ctx, 'flee', action.monsterId);
      break;
    default:
      throw new Error(`unknown action type "${action.type}"`);
  }
  settleCasualties(out, ctx);
  checkSummoning(out, ctx);
  settleCasualties(out, ctx);
  return out;
}

/* ------------------------------------------------------------------ *
 * Casualties
 * ------------------------------------------------------------------ */

/**
 * Investigators at 0 Health or 0 Sanity leave the table.
 *
 * At 0 Health they have fallen. At 0 Sanity they have gone mad, and the house
 * keeps them: a monster stands where they stood. Either way, whatever they
 * carried is lost — clues gone, items to the discard — and the player takes up
 * a sheet nobody has played yet, starting again in the Foyer. With no sheets
 * left, that seat is out of the game, and when every seat is out, so is the
 * game.
 *
 * It runs after an action has finished, never in the middle of one, so a card
 * that hurts and then moves you still does both. If it was the investigator
 * whose turn it was, the rest of that turn is lost with them.
 */
function settleCasualties(state, ctx) {
  for (;;) {
    if (state.pending || state.choice || state.over) return;

    const player = state.players.find((p) => p.down && !p.out && !p.replacing);
    if (!player) break;

    const ownTurn =
      player.id === currentPlayer(state).id &&
      player.downDuring === `${state.round}:${state.turnIndex}`;
    if (ownTurn) state.turnLost = player.id;

    if (player.down === 'mad') {
      addMonster(state, {
        kind: 'mad',
        name: `${player.name}, lost to madness`,
        fromInvestigator: player.investigatorId ?? null,
        health: MAD_MONSTER_HEALTH,
        pos: { ...player.pos },
      });
      pushLog(state, `${player.name} has gone mad. Where they stood, there is now a monster.`);
    } else {
      pushLog(state, `${player.name} has fallen.`);
    }
    state.itemDiscard.push(...(player.items ?? []));
    player.items = [];
    player.clues = 0;

    const used = new Set(state.usedInvestigators ?? []);
    const options = Object.values(ctx.investigators ?? {})
      .filter((sheet) => !used.has(sheet.id))
      .map((sheet) => ({ id: sheet.id, label: `${sheet.name} — ${sheet.role}` }));

    if (options.length === 0) {
      player.out = true;
      pushLog(state, `No one is left to take ${player.name}'s place.`);
      if (state.players.every((p) => p.out)) {
        state.over = { result: 'lost', reason: 'Every investigator is gone.' };
        pushLog(state, ctx.scenario.story?.lost ?? 'Every investigator is gone. The house has won.');
        return;
      }
      continue;
    }

    player.replacing = true;
    beginChoice(state, {
      kind: 'new-investigator',
      playerId: player.id,
      prompt: `${player.name} is out. Choose a new investigator to take their seat.`,
      options,
    });
    return;
  }

  // Every casualty is dealt with. If one of them was the investigator whose
  // turn it was, that turn is over.
  if (state.turnLost) {
    const lost = state.turnLost;
    state.turnLost = null;
    if (currentPlayer(state).id === lost || currentPlayer(state).out) doEndTurn(state, ctx);
    settleCasualties(state, ctx);
  }
}

/** Seat a fresh investigator in place of one who is out. */
function seatInvestigator(state, ctx, player, sheet) {
  state.usedInvestigators = [...(state.usedInvestigators ?? []), sheet.id];
  Object.assign(player, {
    name: sheet.name,
    investigatorId: sheet.id,
    role: sheet.role,
    health: sheet.health,
    healthMax: sheet.health,
    sanity: sheet.sanity,
    sanityMax: sheet.sanity,
    clueLimit: sheet.clueLimit,
    ability: sheet.ability ?? null,
    items: [],
    clues: 0,
    pos: startPosition(state, ctx) ?? player.pos,
  });
  delete player.down;
  delete player.downDuring;
  delete player.replacing;
  pushLog(state, `${sheet.name} arrives in the Foyer to take up the search.`);
}

/** The middle of the Foyer, wherever it is on the table. */
function startPosition(state, ctx) {
  const [startR, startC] = ctx.scenario.startSpace ?? [1, 1];
  for (const [id, entry] of Object.entries(state.rooms)) {
    if (entry.roomId !== ctx.scenario.startRoom) continue;
    const [R, C] = id.split(',').map(Number);
    return posOf(R, C, startR, startC);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Monsters on the board
 * ------------------------------------------------------------------ */

/**
 * The scenario does not say how much it takes to put down an investigator the
 * house has kept, so for now one blow is enough.
 */
const MAD_MONSTER_HEALTH = 1;

function addMonster(state, monster) {
  state.monsters ??= [];
  state.nextMonster ??= state.monsters.length + 1;
  const entry = { id: `m${state.nextMonster}`, healthMax: monster.health, ...monster };
  state.nextMonster += 1;
  state.monsters.push(entry);
  return entry;
}

/** The monsters that count toward a summoning: everything but the boss. */
export function monsterCount(state) {
  return (state.monsters ?? []).filter((m) => m.kind !== 'boss').length;
}

function posOfKey(key) {
  const [gr, gc] = key.split(',').map(Number);
  return { gr, gc };
}

function squaresInRoom(slot) {
  const out = [];
  for (let r = 0; r < ROOM_SIZE; r++) {
    for (let c = 0; c < ROOM_SIZE; c++) out.push(posOf(slot.R, slot.C, r, c));
  }
  return out;
}

/**
 * Bring the next monster off the scenario's deck onto a square, and let it do
 * what it does when it is revealed.
 */
function spawnMonster(state, ctx, pos, why) {
  if (!ctx.monsterCards) {
    pushLog(state, 'This scenario brings no monster deck, so nothing comes.');
    return null;
  }
  const cardId = drawFrom(state, 'monsterDeck', 'monsterDiscard', 'monster');
  if (cardId === null) {
    pushLog(state, 'Every monster in the deck is already on the board, so nothing more comes.');
    return null;
  }
  const card = ctx.monsterCards[cardId];
  if (!card) throw new Error(`unknown monster card "${cardId}"`);

  const slot = slotOf(pos);
  const entry = roomEntryAt(state, slot);
  const room = entry ? ctx.rooms[entry.roomId].name : 'the dark';
  const monster = addMonster(state, {
    kind: 'card',
    cardId,
    name: card.name,
    health: card.health,
    power: card.power,
    movement: card.movement ?? null,
    damage: card.damage ?? undefined,
    pos: { ...pos },
  });
  pushLog(
    state,
    `${card.name} (${card.health} Health) appears in the ${room} — ${why}. Monsters on the board: ${monsterCount(state)}.`,
  );
  // "If a Monster is revealed, players in adjacent spaces become engaged immediately."
  for (const player of onTable(state)) {
    if (within(player.pos, monster.pos, 1)) engage(state, player, monster);
  }
  revealPower(state, ctx, monster, card);
  return monster;
}

function rollD6(state, source) {
  const value = randomInt(state, 6) + 1;
  state.lastRoll = { value, die: 6, source };
  return value;
}

/** What a monster does the moment it is revealed. */
function revealPower(state, ctx, monster, card) {
  const power = card.power;
  if (!power) return;

  if (power.kind === 'spawn-adjacent-room') {
    const value = rollD6(state, card.ability || card.name);
    const hits = value >= power.min && value <= power.max;
    pushLog(
      state,
      `${card.ability || card.name}: the die comes up ${value}${hits ? '' : ' — nothing follows'}.`,
    );
    if (!hits) return;
    const here = slotOf(monster.pos);
    const rooms = DIRS.map((dir) => ({ R: here.R + dir.dr, C: here.C + dir.dc })).filter((slot) =>
      roomEntryAt(state, slot),
    );
    if (rooms.length === 0) {
      pushLog(state, 'There is no room next to this one for another monster to appear in.');
      return;
    }
    const slot = rooms[randomInt(state, rooms.length)];
    const squares = squaresInRoom(slot);
    spawnMonster(state, ctx, squares[randomInt(state, squares.length)], `${theName(card.name)} splits`);
    return;
  }

  if (power.kind === 'all-players-sanity') {
    pushLog(state, `${card.ability || card.name}: every investigator rolls.`);
    for (const player of onTable(state)) {
      const value = rollD6(state, card.ability || card.name);
      if (value >= power.min && value <= power.max) {
        pushLog(state, `${player.name} rolls ${value}.`);
        changePool(state, player, 'sanity', -1, `${theName(card.name)}`);
      } else {
        pushLog(state, `${player.name} rolls ${value} and holds on.`);
      }
    }
  }
}

/**
 * "All monsters move 1 space toward the nearest player." They walk like
 * investigators do — through doors, not walls — and the boss is not a monster
 * for this, because it moves by its own card.
 */
function moveMonstersTowardPlayers(state, ctx, spaces) {
  const seated = onTable(state);
  const movers = (state.monsters ?? []).filter((m) => m.kind !== 'boss');
  if (movers.length === 0 || seated.length === 0) {
    pushLog(state, 'There are no monsters on the board to move.');
    return;
  }
  for (const monster of movers) {
    const target = nearestPlayer(state, monster.pos, false);
    const moved = drawToward(state, ctx, monster, target.pos, spaces);
    pushLog(
      state,
      moved === 0
        ? `${theName(monster.name, true)} cannot find a way closer.`
        : `${theName(monster.name, true)} moves toward ${target.name}.`,
    );
  }
}

/** The end of a round: every monster that moves takes its step. */
function monstersAtRoundEnd(state, ctx) {
  const fallback = ctx.scenario.monsterMovement ?? 'none';
  for (const monster of state.monsters ?? []) {
    if (monster.kind === 'boss') continue;
    const mode = monster.movement ?? fallback;
    if (mode === 'none') continue;
    const here = slotOf(monster.pos);
    const prey = onTable(state).filter((p) => {
      if (mode !== 'room') return true;
      const at = slotOf(p.pos);
      return at.R === here.R && at.C === here.C;
    });
    if (prey.length === 0) continue;
    const target = prey.reduce((best, p) =>
      gapOf(p.pos, monster.pos) < gapOf(best.pos, monster.pos) ? p : best,
    );
    // It closes in, but does not step onto an investigator: beside them is enough.
    if (gapOf(target.pos, monster.pos) <= 1) continue;
    if (drawToward(state, ctx, monster, target.pos, 1) > 0) {
      pushLog(state, `${theName(monster.name, true)} moves toward ${target.name}.`);
    }
  }
}

function gapOf(a, b) {
  return Math.abs(a.gr - b.gr) + Math.abs(a.gc - b.gc);
}

function nearestPlayer(state, pos, diagonal) {
  const gap = (p) =>
    diagonal
      ? Math.max(Math.abs(p.gr - pos.gr), Math.abs(p.gc - pos.gc))
      : Math.abs(p.gr - pos.gr) + Math.abs(p.gc - pos.gc);
  let best = null;
  for (const player of onTable(state)) {
    if (!best || gap(player.pos) < gap(best.pos)) best = player;
  }
  return best;
}

/** Monsters a weapon in this investigator's hand can reach. */
function strikeTargets(state, player, effect) {
  const reach = (effect.hit ?? effect.banish).reach;
  return (state.monsters ?? []).filter((m) => {
    if (effect.banish && m.kind === 'boss') return false;
    const gap = Math.abs(m.pos.gr - player.pos.gr) + Math.abs(m.pos.gc - player.pos.gc);
    return gap <= reach;
  });
}

function strikeMonster(state, ctx, monster, effect, source) {
  if (effect.banish) {
    pushLog(state, `The ${source} banishes ${theName(monster.name)}.`);
    removeMonster(state, monster);
    return;
  }
  monster.health = Math.max(0, monster.health - effect.hit.damage);
  pushLog(
    state,
    `The ${source} deals ${effect.hit.damage} damage to ${theName(monster.name)} — ${monster.health} of ${monster.healthMax} Health left.`,
  );

  if (monster.health > 0) return;

  if (monster.kind === 'boss') {
    removeMonster(state, monster);
    state.over = { result: 'won', reason: `${monster.name} is destroyed.` };
    pushLog(state, ctx.scenario.story?.bossDefeated ?? `${monster.name} is destroyed.`);
    return;
  }
  pushLog(state, `${theName(monster.name, true)} is destroyed.`);
  removeMonster(state, monster);
}

function removeMonster(state, monster) {
  state.monsters = state.monsters.filter((m) => m.id !== monster.id);
  for (const player of state.players) {
    if (player.engaged) player.engaged = player.engaged.filter((id) => id !== monster.id);
  }
  if (monster.cardId) state.monsterDiscard.push(monster.cardId);
  if (monster.kind === 'boss') state.boss = null;
}

/* ------------------------------------------------------------------ *
 * Combat
 *
 * From the rulebook:
 *   Attack — attack a Monster in an adjacent space; this engages you with it.
 *            Roll 1d6: 4-6 is a hit, 1-3 a miss and you take 1 damage.
 *   Flee   — if engaged, roll 1d6: 4+ you escape, 1-3 you fail and take 1
 *            damage.
 *   While engaged you may only Attack or Flee. Ending your turn next to a
 *   Monster engages you, and so does being next to one when it is revealed.
 *
 * "Adjacent" is the investigator's own square and the four that share an edge
 * with it — a monster turned over by Investigate appears under your feet.
 * ------------------------------------------------------------------ */

/** Damage a hit deals. The rulebook says "hit" and gives no number. */
const ATTACK_DAMAGE = 1;
const COMBAT_DAMAGE = 1;

/** "the Mourner", but "The Whisperer" — a name that brings its own article keeps it. */
function theName(name, capital = false) {
  if (/^The /.test(name)) return name;
  return `${capital ? 'The' : 'the'} ${name}`;
}

function within(a, b, reach) {
  return Math.abs(a.gr - b.gr) + Math.abs(a.gc - b.gc) <= reach;
}

/** The monsters this investigator is engaged with, still on the table. */
export function engagedWith(state, player) {
  const ids = new Set(player?.engaged ?? []);
  return (state.monsters ?? []).filter((m) => ids.has(m.id));
}

function engage(state, player, monster) {
  if ((player.bound ?? []).includes(monster.id)) return;
  player.engaged ??= [];
  if (player.engaged.includes(monster.id)) return;
  player.engaged.push(monster.id);
  pushLog(state, `${player.name} is engaged with ${theName(monster.name)}.`);
}

function disengage(player, monster) {
  player.engaged = (player.engaged ?? []).filter((id) => id !== monster.id);
}

/** A monster's blow: Health, or Sanity if it strikes at the mind. */
function monsterHits(state, monster, player, amount) {
  const pool = monster.power?.kind === 'damage-to-sanity' ? 'sanity' : 'health';
  changePool(state, player, pool, -amount, `${theName(monster.name)}`);
}

/** Why the current investigator cannot Attack or Flee, or null if they can. */
export function combatProblem(state, kind) {
  if (state.over) return 'the game is over';
  if (state.pending) return 'place the drawn room before doing anything else';
  if (state.choice) return 'answer the choice on the table first';
  if (state.actionsLeft <= 0) return 'no actions left this turn';
  const targets = combatTargets(state, currentPlayer(state), kind);
  if (targets.length > 0) return null;
  return kind === 'flee'
    ? 'you are not engaged with any monster'
    : 'there is no monster on or next to your square to attack';
}

function combatTargets(state, player, kind) {
  if (kind === 'flee') return engagedWith(state, player);
  return (state.monsters ?? []).filter((m) => within(player.pos, m.pos, 1));
}

function doCombat(state, ctx, kind, monsterId) {
  const problem = combatProblem(state, kind);
  if (problem) throw new Error(problem);
  const player = currentPlayer(state);
  const targets = combatTargets(state, player, kind);

  let target = null;
  if (monsterId !== undefined && monsterId !== null) {
    target = targets.find((m) => m.id === String(monsterId));
    if (!target) throw new Error(`there is no monster "${monsterId}" to ${kind}`);
  } else if (targets.length === 1) {
    target = targets[0];
  }

  if (!target) {
    beginChoice(state, {
      kind,
      playerId: player.id,
      prompt: kind === 'attack' ? 'Which monster do you attack?' : 'Which monster do you flee from?',
      options: targets.map((m) => ({ id: m.id, label: `${m.name} (${m.health} Health)` })),
    });
    return state;
  }
  resolveCombat(state, ctx, player, target, kind);
  return state;
}

function resolveCombat(state, ctx, player, monster, kind) {
  state.actionsLeft -= 1;
  let value = rollD6(state, kind === 'attack' ? 'an attack' : 'a flight');

  // Steel Nerves: a failed Flee is rolled again for free, once a turn.
  if (kind === 'flee' && value < 4 && player.ability === 'steel-nerves' && !player.fledReroll) {
    player.fledReroll = true;
    pushLog(state, `${player.name} rolls ${value} and steadies (Steel Nerves) — rolling again.`);
    value = rollD6(state, 'a flight');
  }

  // "Spend 1 Clue to reroll any 1d6 roll." Offered when it would matter.
  if (value < 4 && combatRules(ctx).clueReroll && (player.clues ?? 0) > 0) {
    pushLog(state, `${player.name} rolls ${value}.`);
    beginChoice(state, {
      kind: 'reroll',
      playerId: player.id,
      prompt: `${player.name} rolled ${value} — spend 1 Clue to roll again?`,
      options: [
        { id: 'yes', label: `Spend 1 Clue (${player.clues} held) and reroll` },
        { id: 'no', label: `Keep the ${value}` },
      ],
      combat: { kind, monsterId: monster.id, value },
    });
    return;
  }
  settleCombat(state, ctx, player, monster, kind, value);
}

/** What a combat roll does, once the die is final. */
function settleCombat(state, ctx, player, monster, kind, value) {
  if (kind === 'attack') {
    engage(state, player, monster);
    if (value >= 4) {
      pushLog(state, `${player.name} attacks ${theName(monster.name)}: ${value} — a hit.`);
      strikeMonster(state, ctx, monster, { hit: { damage: ATTACK_DAMAGE, reach: 1 } }, 'blow');
    } else {
      pushLog(state, `${player.name} attacks ${theName(monster.name)}: ${value} — a miss.`);
      monsterHits(state, monster, player, monsterDamage(ctx, monster));
    }
    return;
  }

  if (value >= 4) {
    disengage(player, monster);
    pushLog(state, `${player.name} flees ${theName(monster.name)}: ${value} — free.`);
  } else {
    pushLog(state, `${player.name} tries to flee ${theName(monster.name)}: ${value} — caught.`);
    monsterHits(state, monster, player, monsterDamage(ctx, monster));
  }
}

/**
 * The core combat rules, with their defaults:
 *   clueReroll     spend 1 Clue to reroll a failed Attack or Flee
 *   monsterDamage  what a monster's blow deals, unless its card says otherwise
 *   bossDamage     what the boss's blow deals, unless its card says otherwise
 */
function combatRules(ctx) {
  return { clueReroll: false, monsterDamage: 1, bossDamage: 1, ...(ctx.scenario.combat ?? {}) };
}

function monsterDamage(ctx, monster) {
  if (Number.isInteger(monster.damage)) return monster.damage;
  const rules = combatRules(ctx);
  return monster.kind === 'boss' ? rules.bossDamage : rules.monsterDamage;
}

/** Binding Chalk: this monster cannot engage the investigator this turn. */
function bindMonster(state, player, monster, source) {
  disengage(player, monster);
  player.bound = [...(player.bound ?? []), monster.id];
  pushLog(state, `The ${source} holds ${theName(monster.name)} back from ${player.name} for this turn.`);
}

/** Ghost Bell: monsters in the rooms next to yours are pushed away. */
function pushMonstersFromAdjacentRooms(state, ctx, player, spaces) {
  const here = slotOf(player.pos);
  let pushed = 0;
  for (const monster of state.monsters ?? []) {
    if (monster.kind === 'boss') continue;
    const at = slotOf(monster.pos);
    if (Math.abs(at.R - here.R) + Math.abs(at.C - here.C) !== 1) continue;
    for (let step = 0; step < spaces; step++) {
      const gap = (p) => Math.abs(p.gr - player.pos.gr) + Math.abs(p.gc - player.pos.gc);
      const away = DIRS.map((d) => ({ gr: monster.pos.gr + d.dr, gc: monster.pos.gc + d.dc }))
        .filter((to) => gap(to) > gap(monster.pos))
        .find((to) => roomEntryAt(state, slotOf(to)) && !stepProblem(state, monster.pos, to, ctx));
      if (!away) break;
      monster.pos = away;
      pushed += 1;
    }
  }
  pushLog(state, pushed === 0 ? 'The bell rings, but nothing nearby is moved.' : 'The bell rings and the monsters next door are driven back.');
}

/* ------------------------------------------------------------------ *
 * The scenario's endgame: summoning, the boss, and sealing
 * ------------------------------------------------------------------ */

function bossRoomSlot(state, ctx) {
  const roomId = ctx.scenario.bossRoom;
  for (const [key, entry] of Object.entries(state.rooms)) {
    if (entry.roomId !== roomId) continue;
    const [R, C] = key.split(',').map(Number);
    return { R, C };
  }
  return null;
}

/**
 * The boss appears once the scenario's summoning condition is met: its room is
 * on the table and enough monsters stand on the board. Checked after every
 * action, so it arrives the moment the condition holds.
 */
function checkSummoning(state, ctx) {
  const { summon, boss } = ctx.scenario;
  if (!summon || !boss || state.over || state.boss || state.bossDefeated) return;
  if (state.pending || state.choice) return;

  const slot = bossRoomSlot(state, ctx);
  if (summon.bossRoomRevealed && !slot) return;
  if (monsterCount(state) < (summon.monstersAtLeast ?? 0)) return;

  const pos = slot ? posOfNumber(slot, boss.space ?? 5) : startPosition(state, ctx);
  const entry = addMonster(state, {
    kind: 'boss',
    bossId: boss.id,
    name: boss.name,
    health: boss.health,
    movement: boss.movement ?? 1,
    damage: Number.isInteger(boss.damage) ? boss.damage : undefined,
    ignoresWalls: Boolean(boss.ignoresWalls),
    diagonal: Boolean(boss.diagonal),
    aura: boss.aura ?? null,
    onSanityLoss: boss.onSanityLoss ?? null,
    pos,
  });
  state.boss = entry.id;
  if (ctx.scenario.story?.bossArrives) pushLog(state, ctx.scenario.story.bossArrives);
  pushLog(state, `${boss.name} manifests in the ${ctx.rooms[ctx.scenario.bossRoom]?.name ?? 'house'}.`);
}

function bossOnBoard(state) {
  return (state.monsters ?? []).find((m) => m.kind === 'boss') ?? null;
}

/** "Each time a player loses Sanity: roll 1d6. On a 1-2, they lose 1 additional Sanity." */
function ruptureOfSelf(state, player) {
  const boss = bossOnBoard(state);
  const rule = boss?.onSanityLoss;
  if (!rule || state.rupturing) return;
  const value = rollD6(state, rule.name);
  if (value < rule.min || value > rule.max) {
    pushLog(state, `${rule.name}: ${value} — ${player.name} holds together.`);
    return;
  }
  pushLog(state, `${rule.name}: ${value}.`);
  state.rupturing = true;
  changePool(state, player, 'sanity', rule.sanity, rule.name);
  state.rupturing = false;
}

/**
 * The boss at the end of a round: it moves toward the nearest investigator —
 * through walls and on the diagonal, if its card says so — and then its aura
 * takes Sanity from everyone beside it.
 */
function bossAtRoundEnd(state, ctx) {
  const boss = bossOnBoard(state);
  if (!boss || onTable(state).length === 0) return;

  for (let step = 0; step < boss.movement; step++) {
    const target = nearestPlayer(state, boss.pos, boss.diagonal);
    if (!target) break;
    const dr = Math.sign(target.pos.gr - boss.pos.gr);
    const dc = Math.sign(target.pos.gc - boss.pos.gc);
    if (dr === 0 && dc === 0) break;
    const tries = boss.diagonal && dr && dc
      ? [{ dr, dc }, { dr, dc: 0 }, { dr: 0, dc }]
      : [{ dr, dc: 0 }, { dr: 0, dc }].filter((d) => d.dr || d.dc);
    const to = tries
      .map((d) => ({ gr: boss.pos.gr + d.dr, gc: boss.pos.gc + d.dc }))
      .find(
        (pos) =>
          roomEntryAt(state, slotOf(pos)) &&
          (boss.ignoresWalls || !stepProblem(state, boss.pos, pos, ctx)),
      );
    if (!to) break;
    boss.pos = to;
    pushLog(state, `${boss.name} drifts toward ${target.name}.`);
  }

  if (boss.aura) {
    for (const player of onTable(state)) {
      const near =
        Math.max(Math.abs(player.pos.gr - boss.pos.gr), Math.abs(player.pos.gc - boss.pos.gc)) <= 1;
      if (near) changePool(state, player, 'sanity', boss.aura.sanity, boss.aura.name);
    }
  }
}

/** Why the current investigator cannot spend clues on the seal, or null. */
export function sealProblem(state, ctx) {
  const seal = ctx.scenario.seal;
  if (!seal) return 'this scenario has nothing to seal';
  if (state.over) return 'the game is over';
  if (state.pending) return 'place the drawn room before doing anything else';
  if (state.choice) return 'answer the choice on the table first';
  if (state.boss) return 'the Presence has manifested — the Rift can no longer be sealed';
  if (state.actionsLeft <= 0) return 'no actions left this turn';
  if (engagedWith(state, currentPlayer(state)).length > 0) {
    return 'you are engaged with a monster — Attack or Flee first';
  }
  const slot = bossRoomSlot(state, ctx);
  const roomName = ctx.rooms[seal.room]?.name ?? seal.room;
  if (seal.allRoomsRevealed && (state.roomDeck.length > 0 || !slot)) {
    return `every room must be revealed before the ${roomName} can be sealed`;
  }
  const player = currentPlayer(state);
  const here = roomEntryAt(state, slotOf(player.pos));
  if (!here || here.roomId !== seal.room) return `clues are spent on the seal in the ${roomName}`;
  if ((player.clues ?? 0) === 0) return `${player.name} has no clues to spend`;
  return null;
}

export function sealTarget(state, ctx) {
  const seal = ctx.scenario.seal;
  return seal ? seal.cluesPerPlayer * state.players.length : 0;
}

/**
 * Spend every clue in hand on the seal, up to what it still needs. It takes one
 * action. When the last one is in, the Rift is sealed and the game is won.
 */
function doSeal(state, ctx) {
  const problem = sealProblem(state, ctx);
  if (problem) throw new Error(problem);
  const player = currentPlayer(state);
  const target = sealTarget(state, ctx);
  const spend = Math.min(player.clues, target - state.sealClues);
  player.clues -= spend;
  state.sealClues += spend;
  state.actionsLeft -= 1;
  pushLog(
    state,
    `${player.name} spends ${spend} clue${spend === 1 ? '' : 's'} on the seal — ${state.sealClues} of ${target}.`,
  );
  if (state.sealClues >= target) {
    state.over = { result: 'won', reason: 'The Rift is sealed.' };
    pushLog(state, ctx.scenario.story?.sealed ?? 'The Rift is sealed.');
  }
  return state;
}

/* ------------------------------------------------------------------ *
 * Room specials
 * ------------------------------------------------------------------ */

/** The room the current investigator stands in, if it has a special. */
export function roomSpecialHere(state, ctx) {
  const entry = roomEntryAt(state, slotOf(currentPlayer(state).pos));
  const room = entry ? ctx.rooms[entry.roomId] : null;
  return room?.special ? { room, ...ROOM_SPECIALS[room.special] } : null;
}

/** Why the current investigator cannot use the room they stand in, or null. */
export function roomSpecialProblem(state, ctx) {
  const here = roomSpecialHere(state, ctx);
  if (!here) return 'there is nothing special about this room';
  if (state.over) return 'the game is over';
  if (state.pending) return 'place the drawn room before doing anything else';
  if (state.choice) return 'answer the choice on the table first';
  if (state.actionsLeft <= 0) return 'no actions left this turn';
  const player = currentPlayer(state);
  if (engagedWith(state, player).length > 0) return 'you are engaged with a monster — Attack or Flee first';

  const pool = here.pool;
  const word = pool === 'sanity' ? 'Sanity' : 'Health';
  if ((player.clues ?? 0) < 1) return `${player.name} has no Clue to spend`;
  if (typeof player[pool] !== 'number') return `${player.name} has no ${word} on their sheet`;
  if (player[pool] >= player[`${pool}Max`]) return `${player.name} is already at full ${word}`;
  return null;
}

function doRoomSpecial(state, ctx) {
  const problem = roomSpecialProblem(state, ctx);
  if (problem) throw new Error(problem);
  const { room, pool } = roomSpecialHere(state, ctx);
  const player = currentPlayer(state);
  state.actionsLeft -= 1;
  player.clues -= 1;
  pushLog(state, `${player.name} spends a Clue in the ${room.name}.`);
  changePool(state, player, pool, 1, `the ${room.name}`);
  return state;
}

/* ------------------------------------------------------------------ *
 * Traits used as an action
 * ------------------------------------------------------------------ */

/** The current investigator's trait, if it is one they use on their turn. */
export function activeTrait(state, ctx) {
  const player = currentPlayer(state);
  const rule = ABILITIES[player?.ability];
  if (!rule?.active) return null;
  const sheet = ctx.investigators?.[player.investigatorId];
  return { ability: player.ability, name: sheet?.trait ?? player.ability, label: rule.label };
}

/** Why the current investigator cannot use their trait now, or null. */
export function traitProblem(state, ctx) {
  const trait = activeTrait(state, ctx);
  if (!trait) return 'this investigator has no trait to use as an action';
  if (state.over) return 'the game is over';
  if (state.pending) return 'place the drawn room before doing anything else';
  if (state.choice) return 'answer the choice on the table first';
  if (state.actionsLeft <= 0) return 'no actions left this turn';
  const player = currentPlayer(state);
  if (engagedWith(state, player).length > 0) return 'you are engaged with a monster — Attack or Flee first';

  if (trait.ability === 'whispers-from-beyond') {
    if (player.whisperedRound === state.round) return 'the voices have already spoken this round';
    if (state.encounterDeck.length === 0) return 'the encounter deck is empty';
  }
  if (trait.ability === 'bartered-insight') {
    if ((player.clues ?? 0) < 2) return `${player.name} needs 2 Clues to barter`;
    if (player.sanity >= player.sanityMax) return `${player.name} is already at full Sanity`;
  }
  return null;
}

function doTrait(state, ctx) {
  const problem = traitProblem(state, ctx);
  if (problem) throw new Error(problem);
  const trait = activeTrait(state, ctx);
  const player = currentPlayer(state);
  state.actionsLeft -= 1;

  if (trait.ability === 'whispers-from-beyond') {
    player.whisperedRound = state.round;
    // Draws take from the end, so the top of the deck is the last card.
    const id = state.encounterDeck[state.encounterDeck.length - 1];
    const card = encounterCardOf(ctx, id);
    const word = card ? ENCOUNTER_WORD[card.type] : 'card';
    state.peek = { by: player.id, round: state.round, cardId: id, type: card?.type ?? null };
    pushLog(state, `${player.name} listens (${trait.name}): the top Encounter card is ${/^[AEIOU]/.test(word) ? 'an' : 'a'} ${word}.`);
    return state;
  }

  if (trait.ability === 'bartered-insight') {
    player.clues -= 2;
    pushLog(state, `${player.name} trades 2 Clues for clarity (${trait.name}).`);
    changePool(state, player, 'sanity', 1, trait.name);
  }
  return state;
}

/* ------------------------------------------------------------------ *
 * Forcing a wall
 *
 * The house can close up around the investigators until there is no door
 * left that leads anywhere. The core rule `escape` lets them push through a
 * wall into the room next door, without changing a single room card:
 *
 *   "escape": { "fromRound": 10, "onlyWhenTrapped": false, "sanity": 1 }
 *
 *   fromRound        the first round it may be used (1 = from the start)
 *   onlyWhenTrapped  only when no door leads out of the investigator's room
 *   sanity           what it costs, on top of one action
 *
 * Leave it out and the walls hold.
 * ------------------------------------------------------------------ */

/** Is there any door out of this investigator's room, monsters aside? */
export function trappedInRoom(state, ctx, player) {
  const slot = slotOf(player.pos);
  const open = { ...state, monsters: [], drewThisTurn: false };
  for (const from of squaresInRoom(slot)) {
    for (const dir of DIRS) {
      const to = { gr: from.gr + dir.dr, gc: from.gc + dir.dc };
      const there = slotOf(to);
      if (there.R === slot.R && there.C === slot.C) continue;
      if (!stepProblem(open, from, to, ctx)) return false;
    }
  }
  return true;
}

/**
 * Stuck, for a forced shift:
 *   room    no door leads out of the investigator's room
 *   foyer   no path through doors leads back to the Foyer
 */
function isStuck(state, ctx, player, test) {
  if (test === 'room') return trappedInRoom(state, ctx, player);
  const open = { ...state, monsters: [], drewThisTurn: false };
  const home = ctx.scenario.startRoom;
  const seen = new Set([posKey(player.pos)]);
  let frontier = [player.pos];
  while (frontier.length > 0) {
    const next = [];
    for (const pos of frontier) {
      if (roomEntryAt(state, slotOf(pos))?.roomId === home) return false;
      for (const dir of DIRS) {
        const to = { gr: pos.gr + dir.dr, gc: pos.gc + dir.dc };
        if (seen.has(posKey(to)) || !roomEntryAt(state, slotOf(to))) continue;
        if (stepProblem(open, pos, to, ctx)) continue;
        seen.add(posKey(to));
        next.push(to);
      }
    }
    frontier = next;
  }
  return true;
}

/** The squares through a wall from here into a room already on the table. */
function wallSquares(state, player) {
  const slot = slotOf(player.pos);
  const out = [];
  for (const dir of DIRS) {
    const to = { gr: player.pos.gr + dir.dr, gc: player.pos.gc + dir.dc };
    const there = slotOf(to);
    if (there.R === slot.R && there.C === slot.C) continue;
    if (!roomEntryAt(state, there)) continue;
    if ((state.monsters ?? []).some((m) => m.pos.gr === to.gr && m.pos.gc === to.gc)) continue;
    out.push(to);
  }
  return out;
}

/** Why the current investigator cannot force a wall, or null. */
export function forceWallProblem(state, ctx) {
  const rule = ctx.scenario.escape;
  if (!rule) return 'the walls hold in this game';
  if (state.over) return 'the game is over';
  if (state.pending) return 'place the drawn room before doing anything else';
  if (state.choice) return 'answer the choice on the table first';
  if (state.actionsLeft <= 0) return 'no actions left this turn';
  if (state.round < (rule.fromRound ?? 1)) return `the walls hold until round ${rule.fromRound}`;
  const player = currentPlayer(state);
  if (engagedWith(state, player).length > 0) return 'you are engaged with a monster — Attack or Flee first';
  if (rule.onlyWhenTrapped && !trappedInRoom(state, ctx, player)) {
    return 'there is still a door out of this room';
  }
  if (rule.sanity && (player.sanity ?? 0) <= rule.sanity) {
    return `${player.name} has too little Sanity left to force a wall`;
  }
  if (wallSquares(state, player).length === 0) {
    return 'stand against a wall with a room on the other side';
  }
  return null;
}

export function forceWallTargets(state) {
  return wallSquares(state, currentPlayer(state));
}

function doForceWall(state, ctx, to) {
  const problem = forceWallProblem(state, ctx);
  if (problem) throw new Error(problem);
  const player = currentPlayer(state);
  const squares = wallSquares(state, player);

  if (to) {
    const target = squares.find((p) => p.gr === to.gr && p.gc === to.gc);
    if (!target) throw new Error('there is no room on the other side of that wall');
    forceThrough(state, ctx, player, target);
    return state;
  }
  if (squares.length === 1) {
    forceThrough(state, ctx, player, squares[0]);
    return state;
  }
  beginChoice(state, {
    kind: 'force-wall',
    playerId: player.id,
    prompt: 'Which wall do you force?',
    options: squares.map((p) => ({
      id: posKey(p),
      label: ctx.rooms[roomEntryAt(state, slotOf(p)).roomId].name,
    })),
  });
  return state;
}

function forceThrough(state, ctx, player, to) {
  const rule = ctx.scenario.escape;
  state.actionsLeft -= 1;
  const there = slotOf(to);
  const room = ctx.rooms[roomEntryAt(state, there).roomId];
  player.pos = { ...to };
  pushLog(state, `${player.name} forces a way through the wall into the ${room.name}.`);
  if (rule.sanity) changePool(state, player, 'sanity', -rule.sanity, 'forcing the wall');
  resolveEntrance(state, ctx, there, to);
  flipForSecondPlayer(state, ctx, there);
}

/** The investigators still in the game. */
export function onTable(state) {
  return state.players.filter((p) => !p.out);
}

function doMove(state, action, ctx) {
  if (state.pending) throw new Error('place the drawn room before doing anything else');

  const path = action.path;
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error('MOVE needs a non-empty path');
  }

  // A Move action buys the whole allowance at once. Steps left over after a
  // pause to turn a card stay available, so stepping into the unknown and then
  // walking on is still one action, the way it is at the table.
  if (state.stepsLeft === 0) {
    if (state.actionsLeft <= 0) throw new Error('no actions left this turn');
    state.actionsLeft -= 1;
    state.stepsLeft = state.moveRange;
  }
  if (path.length > state.stepsLeft) {
    throw new Error(
      `only ${state.stepsLeft} more space${state.stepsLeft === 1 ? '' : 's'} left in this move`,
    );
  }

  return advance(
    state,
    path.map((p) => ({ gr: p.gr, gc: p.gc })),
    ctx,
    currentPlayer(state).id,
  );
}

/**
 * Investigating the square you are standing on.
 *
 * A card face down under your feet is not just a nuisance to be walked over: one
 * of the turn's two actions turns it over deliberately. That is what makes the
 * entrance cards worth printing — a card laid on [4] can be read by walking to
 * it and investigating, rather than hoping the end of a turn catches it.
 *
 * Why the investigator cannot investigate, or null if they can.
 */
export function investigateProblem(state) {
  if (state.pending) return 'place the drawn room before doing anything else';
  if (state.choice) return 'answer the choice on the table first';
  if (state.actionsLeft <= 0) return 'no actions left this turn';
  if (engagedWith(state, currentPlayer(state)).length > 0) {
    return 'you are engaged with a monster — Attack or Flee first';
  }

  const here = slotOf(currentPlayer(state).pos);
  const mourner = (state.monsters ?? []).find((m) => {
    const at = slotOf(m.pos);
    return m.power?.kind === 'blocks-investigate-room' && at.R === here.R && at.C === here.C;
  });
  if (mourner) return `${theName(mourner.name)} is in this room, and nobody can Investigate while it weeps`;

  const marker = state.encounters?.[posKey(currentPlayer(state).pos)];
  if (!marker) return 'there is no encounter card on this square to investigate';
  if (marker.collected) return 'there is nothing left to take from this square';
  return null;
}

function doInvestigate(state, ctx) {
  const problem = investigateProblem(state);
  if (problem) throw new Error(problem);

  const player = currentPlayer(state);
  const key = posKey(player.pos);
  const number = state.encounters[key].number;

  // Looking into it is an action, not a free peek.
  state.actionsLeft -= 1;

  // "Your next Investigate action fails": the action is spent, the card stays
  // face down, and the debt is paid.
  if ((state.investigatePenalty ?? 0) > 0) {
    state.investigatePenalty -= 1;
    pushLog(
      state,
      `${player.name} investigates the card on [${number}], but finds nothing — that look was doomed.`,
    );
    return state;
  }

  pushLog(state, `${player.name} investigates the card on [${number}].`);
  // Reading it and taking it up are one action when you are the one who walked
  // over: the card turns over, and what it calls for is collected at once.
  turnUp(state, ctx, key, 'the investigator looked into it');
  collectEncounter(state, ctx, key);
  // Hunches: once a turn, a free step after Investigating.
  if (player.ability === 'hunches' && !player.hunchUsed && !player.out) {
    player.hunchUsed = true;
    state.stepsLeft += 1;
    pushLog(state, `${player.name} follows a hunch (Hunches): 1 free space of movement.`);
  }
  return state;
}

/* ------------------------------------------------------------------ *
 * Items in hand
 *
 * An item is picked up when an encounter card calls one, and kept until it is
 * spent. Using it costs no action: Dusty Pocketwatch hands back an action, and
 * a card that costs one to play would then be a card that does nothing.
 * ------------------------------------------------------------------ */

/**
 * Why this investigator cannot use an item, or null if they can.
 * The reason doubles as the tooltip on the card in the hand.
 */
export function useItemProblem(state, ctx, itemId) {
  if (state.pending) return 'place the drawn room before doing anything else';
  if (state.choice) return 'answer the choice on the table first';

  const player = currentPlayer(state);
  const id = String(itemId ?? '');
  if (!(player.items ?? []).includes(id)) return "that item is not in this investigator's hand";

  const item = ctx.items?.[id];
  if (!item) return `unknown item "${id}"`;

  if (item.needs.length > 0) {
    const words = item.needs.map((need) => NEED_WORD[need]);
    return `the ${item.name} is still pending: it needs ${words.join(' and ')}, which the game does not have yet, so it does nothing for now`;
  }
  if (item.effect.bind && strikeTargets(state, player, { banish: item.effect.bind }).length === 0) {
    return `there is no monster on or next to ${player.name}'s square for the ${item.name}`;
  }
  const strike = item.effect.hit ?? item.effect.banish;
  if (strike && strikeTargets(state, player, item.effect).length === 0) {
    return strike.reach === 1
      ? `there is no monster on or next to ${player.name}'s square for the ${item.name}`
      : `there is no monster within ${strike.reach} spaces for the ${item.name}`;
  }
  return null;
}

function doUseItem(state, action, ctx) {
  const problem = useItemProblem(state, ctx, action.itemId);
  if (problem) throw new Error(problem);

  const player = currentPlayer(state);
  const id = String(action.itemId);
  const item = ctx.items[id];

  player.items.splice(player.items.indexOf(id), 1);
  state.itemDiscard.push(id);
  pushLog(state, `${player.name} uses the ${item.name} — ${item.text}`);
  applyItemEffect(state, ctx, item, player);
  return state;
}

/**
 * Move one pool — Health or Sanity — and say what happened.
 *
 * A pool stops at 0. An investigator at 0 Health has fallen and at 0 Sanity
 * has gone mad; either way they are out, and settleCasualties deals with it
 * once the action that did it is over. A ward is one use: the item is spent when it is played and it
 * takes the whole of the next source, because one card is one source.
 */
function changePool(state, player, pool, amount, source) {
  const word = pool === 'sanity' ? 'Sanity' : 'Health';
  const max = player[`${pool}Max`];

  // A seat with no sheet has nothing to move. The card is still spent and still
  // says why it did nothing.
  if (typeof player[pool] !== 'number') {
    pushLog(state, `${player.name} has no ${word} on their sheet, so ${source} leaves them be.`);
    return;
  }

  if (amount < 0) {
    // Logical Detachment: once a round, the first Sanity an Event would take.
    if (
      pool === 'sanity' &&
      source === 'this event' &&
      player.ability === 'logical-detachment' &&
      player.detachedRound !== state.round
    ) {
      player.detachedRound = state.round;
      pushLog(state, `${player.name} keeps a cool head (Logical Detachment): no Sanity is lost to this event.`);
      return;
    }

    const wardKey = pool === 'sanity' ? 'sanityShield' : 'damageShield';
    if ((player[wardKey] ?? 0) > 0) {
      player[wardKey] -= 1;
      const charm = player[`${wardKey}Name`] ?? 'charm';
      pushLog(
        state,
        `${player.name} is warded: the ${charm} absorbs ${source}, so no ${word} is lost.`,
      );
      return;
    }

    const before = player[pool];
    const lost = Math.min(before, -amount);
    player[pool] = before - lost;
    pushLog(
      state,
      lost === 0
        ? `${player.name} has no ${word} left to lose (0 of ${max}).`
        : `${player.name} loses ${lost} ${word} (${source}) — ${player[pool]} of ${max} left.`,
    );
    if (lost > 0 && pool === 'sanity') ruptureOfSelf(state, player);
    if (before > 0 && player[pool] === 0 && !player.down) {
      // Settled once the action that caused it has finished — see settleCasualties.
      player.down = pool === 'sanity' ? 'mad' : 'fallen';
      player.downDuring = `${state.round}:${state.turnIndex}`;
    }
    return;
  }

  const before = player[pool];
  player[pool] = Math.min(max, before + amount);
  // Field Medic: someone beside Dr. Graves who regains Health regains one more.
  if (pool === 'health' && player[pool] > before && player[pool] < max) {
    const medic = onTable(state).find(
      (p) => p.id !== player.id && p.ability === 'field-medic' && within(p.pos, player.pos, 1),
    );
    if (medic) {
      player[pool] += 1;
      pushLog(state, `${medic.name} tends the wound (Field Medic): +1 Health more.`);
    }
  }
  const gained = player[pool] - before;
  pushLog(
    state,
    gained === 0
      ? `${player.name} is already at full ${word} (${before} of ${max}), so ${source} gives them nothing more.`
      : `${player.name} regains ${gained} ${word} (${source}) — ${player[pool]} of ${max}.`,
  );
}

/* ------------------------------------------------------------------ *
 * Choices
 *
 * Some cards cannot be carried out without being told who or what they mean:
 * "discard an item", "switch places with another player". The card is paused
 * rather than guessed at, and the table is asked. What is asked is plain data —
 * a kind, a question and a list of options — so a game replayed from its seed
 * and its actions asks exactly the same question in the same order.
 * ------------------------------------------------------------------ */

function beginChoice(state, choice) {
  state.choice = choice;
  pushLog(state, choice.prompt);
}

function doChoose(state, action, ctx) {
  const choice = state.choice;
  if (!choice) throw new Error('there is no choice waiting to be made');

  const picked = choice.options.find((option) => String(option.id) === String(action.optionId));
  if (!picked) {
    throw new Error(
      `"${action.optionId}" is not one of the choices: ${choice.options.map((o) => o.id).join(', ')}`,
    );
  }

  state.choice = null;
  resolveChoice(state, ctx, choice, picked);
  return state;
}

function resolveChoice(state, ctx, choice, picked) {
  const chooser = state.players.find((player) => player.id === choice.playerId);
  if (!chooser) throw new Error('the choice names an investigator who is not at the table');

  if (choice.kind === 'reroll') {
    const { kind, monsterId, value } = choice.combat;
    const monster = (state.monsters ?? []).find((m) => m.id === monsterId);
    let final = value;
    if (picked.id === 'yes') {
      chooser.clues -= 1;
      final = rollD6(state, kind === 'attack' ? 'an attack' : 'a flight');
      pushLog(state, `${chooser.name} spends a Clue and rolls again: ${final}.`);
    }
    if (monster) settleCombat(state, ctx, chooser, monster, kind, final);
    return;
  }

  if (choice.kind === 'attack' || choice.kind === 'flee') {
    const target = (state.monsters ?? []).find((m) => m.id === picked.id);
    if (!target) throw new Error('that monster is no longer on the table');
    resolveCombat(state, ctx, chooser, target, choice.kind);
    return;
  }

  if (choice.kind === 'bind') {
    const target = (state.monsters ?? []).find((m) => m.id === picked.id);
    if (!target) throw new Error('that monster is no longer on the table');
    bindMonster(state, chooser, target, choice.source);
    return;
  }

  if (choice.kind === 'force-wall') {
    forceThrough(state, ctx, chooser, posOfKey(String(picked.id)));
    return;
  }

  if (choice.kind === 'strike') {
    const target = (state.monsters ?? []).find((m) => m.id === picked.id);
    if (!target) throw new Error('that monster is no longer on the table');
    strikeMonster(state, ctx, target, choice.effect, choice.source);
    return;
  }

  if (choice.kind === 'new-investigator') {
    const sheet = ctx.investigators?.[picked.id];
    if (!sheet) throw new Error(`there is no investigator "${picked.id}"`);
    seatInvestigator(state, ctx, chooser, sheet);
    return;
  }

  // A card in hand is the only choice whose answer is not an investigator.
  if (choice.kind === 'discard-item') {
    chooser.items.splice(chooser.items.indexOf(picked.id), 1);
    state.itemDiscard.push(picked.id);
    pushLog(state, `${chooser.name} gives up the ${picked.label}.`);
    return;
  }

  const other = state.players.find((player) => player.id === picked.id);
  if (!other) throw new Error('the choice names an investigator who is not at the table');

  if (choice.kind === 'swap') {
    const there = { ...chooser.pos };
    chooser.pos = { ...other.pos };
    other.pos = there;
    pushLog(state, `${chooser.name} and ${other.name} change places.`);
    return;
  }

  if (choice.kind === 'give-clue') {
    other.clues = (other.clues ?? 0) + 1;
    pushLog(state, `${other.name} takes the token — one clue to the good.`);
    return;
  }

  if (choice.kind === 'pull') {
    const moved = drawToward(state, ctx, other, chooser.pos, choice.spaces ?? 1);
    pushLog(
      state,
      moved === 0
        ? `${other.name} has no way through to ${chooser.name}.`
        : `${other.name} is drawn ${moved} space${moved === 1 ? '' : 's'} toward ${chooser.name}.`,
    );
    return;
  }

  throw new Error(`the choice "${choice.kind}" is not one the table knows how to carry out`);
}

/**
 * Walk someone else's investigator toward a square, one space at a time.
 *
 * A card does the moving, so it costs nobody an action. It only ever steps into
 * a room already on the table: opening a new one is something an investigator
 * does themselves, walking into the dark.
 */
function drawToward(state, ctx, player, target, spaces) {
  const gap = (pos) => Math.abs(pos.gr - target.gr) + Math.abs(pos.gc - target.gc);
  let moved = 0;

  for (let step = 0; step < spaces; step++) {
    if (gap(player.pos) === 0) break;
    const options = DIRS.map((dir) => ({ gr: player.pos.gr + dir.dr, gc: player.pos.gc + dir.dc }))
      .filter((to) => gap(to) < gap(player.pos))
      .filter((to) => roomEntryAt(state, slotOf(to)))
      .filter((to) => !stepProblem(state, player.pos, to, ctx))
      .sort((a, b) => gap(a) - gap(b));

    if (options.length === 0) break;
    player.pos = options[0];
    moved += 1;
  }
  return moved;
}

/** What a used item does to the table. */
function applyItemEffect(state, ctx, item, player) {
  applyItemFields(state, ctx, item, player, item.effect);
}

/** One flat effect — a whole card, or one band of the die it rolls. */
function applyItemFields(state, ctx, item, player, effect) {
  if (effect.roll) {
    runRoll(
      state,
      effect.roll,
      (branch) => applyItemFields(state, ctx, item, player, branch),
      `the ${item.name}`,
    );
  }

  if (effect.move) {
    state.moveRange += effect.move;
    // Part-way through a move the extra steps are added to what is left rather
    // than promised for later: "this turn" includes the move already under way.
    if (state.stepsLeft > 0) state.stepsLeft += effect.move;
    pushLog(
      state,
      `The extra movement puts ${effect.move} more space${effect.move === 1 ? '' : 's'} in their stride this turn.`,
    );
  }

  if (effect.action) {
    state.actionsLeft += effect.action;
    pushLog(state, `${effect.action} extra action${effect.action === 1 ? ' is' : 's are'} taken now.`);
  }

  if (effect.clue) {
    player.clues = (player.clues ?? 0) + effect.clue;
    pushLog(state, `That is ${effect.clue} clue${effect.clue === 1 ? '' : 's'} to the good.`);
  }

  if (effect.shift) markShiftPoint(state, effect.shift);

  if (effect.health) changePool(state, player, 'health', effect.health, `the ${item.name}`);
  if (effect.sanity) changePool(state, player, 'sanity', effect.sanity, `the ${item.name}`);

  if (effect.giveClue || effect.pull) {
    const others = onTable(state).filter((someone) => someone.id !== player.id);
    if (others.length === 0) {
      pushLog(state, `The ${item.name} has nobody else to reach for.`);
    } else if (effect.giveClue) {
      beginChoice(state, {
        kind: 'give-clue',
        playerId: player.id,
        prompt: `Who takes the token the ${item.name} offers?`,
        options: others.map((someone) => ({ id: someone.id, label: someone.name })),
      });
    } else {
      beginChoice(state, {
        kind: 'pull',
        playerId: player.id,
        prompt: `Who is drawn toward ${player.name}?`,
        options: others.map((someone) => ({ id: someone.id, label: someone.name })),
        spaces: effect.pull,
      });
    }
  }

  if (effect.sanityShield) {
    player.sanityShield = (player.sanityShield ?? 0) + effect.sanityShield;
    player.sanityShieldName = item.name;
    pushLog(state, 'The next source of Sanity loss will be ignored.');
  }

  if (effect.damageShield) {
    player.damageShield = (player.damageShield ?? 0) + effect.damageShield;
    player.damageShieldName = item.name;
    pushLog(state, 'The next wound taken will be ignored, whatever it is dealt by.');
  }

  if (effect.bind) {
    const targets = strikeTargets(state, player, { banish: effect.bind });
    if (targets.length === 1) {
      bindMonster(state, player, targets[0], item.name);
    } else if (targets.length > 1) {
      beginChoice(state, {
        kind: 'bind',
        playerId: player.id,
        prompt: `Which monster does the ${item.name} hold back?`,
        options: targets.map((m) => ({ id: m.id, label: m.name })),
        source: item.name,
      });
    }
  }

  if (effect.pushRooms) pushMonstersFromAdjacentRooms(state, ctx, player, effect.pushRooms);

  if (effect.hit || effect.banish) {
    const targets = strikeTargets(state, player, effect);
    if (targets.length === 1) {
      strikeMonster(state, ctx, targets[0], effect, item.name);
    } else if (targets.length > 1) {
      beginChoice(state, {
        kind: 'strike',
        playerId: player.id,
        prompt: `Which monster does the ${item.name} strike?`,
        options: targets.map((m) => ({ id: m.id, label: `${m.name} (${m.health} Health)` })),
        effect: { hit: effect.hit, banish: effect.banish },
        source: item.name,
      });
    } else {
      pushLog(state, `There is nothing for the ${item.name} to reach.`);
    }
  }

  if (effect.revealRoom) {
    const slot = slotOf(player.pos);
    const here = roomKey(slot.R, slot.C);
    const hidden = Object.keys(state.encounters).filter(
      (key) => state.encounters[key].room === here && !state.encounters[key].faceUp,
    );
    if (hidden.length === 0) {
      pushLog(state, 'Nothing in this room is face down, so the lantern shows nothing new.');
    }
    // turnUp deletes the marker when what is under it leaves the square, so the
    // keys are read from a snapshot taken first.
    for (const key of hidden) turnUp(state, ctx, key, 'the lantern was held up');
  }
}

/**
 * Mark shift points: the house comes one step closer to turning. It is the same
 * bar the round-end roll uses, so a point does what a quiet round does, only now
 * rather than at the end of the round. Two points stack.
 */
function markShiftPoint(state, points) {
  const ladder = state.shift.ladder ?? [5, 4, 3, 2, 1, 0];
  const from = Math.min(state.shiftPressure, ladder.length - 1);
  state.shiftPressure = Math.min(from + points, ladder.length - 1);
  state.shiftTokens += points;

  const bar = ladder[state.shiftPressure];
  pushLog(
    state,
    state.shiftPressure === from
      ? 'A Shift Point is marked, but the house is already turning of its own accord this round.'
      : bar > 0
        ? `A Shift Point is marked: the house shifts on ${bar + 1}+ at the end of this round.`
        : 'A Shift Point is marked: the house turns of its own accord at the end of this round.',
  );
}

/**
 * Walk the player one space at a time. Stepping into an unexplored slot draws a
 * card and pauses; the card has to be turned and placed before the walk resumes.
 */
function advance(state, steps, ctx, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`unknown player "${playerId}"`);

  let taken = 0;
  while (steps.length > 0) {
    const to = steps[0];
    const from = player.pos;
    // Something met on the way — a monster turned up by an entrance card, or
    // one that engaged the investigator — ends the walk where they stand. The
    // steps already taken stay taken.
    if (taken > 0 && engagedWith(state, player).length > 0) {
      pushLog(state, `${player.name} is caught and stops.`);
      break;
    }
    const problem = stepProblem(state, from, to, ctx);
    if (problem && taken > 0) {
      pushLog(state, `${player.name} stops: ${problem}.`);
      break;
    }
    if (problem) throw new Error(problem);
    taken += 1;

    const here = slotOf(from);
    const there = slotOf(to);
    const sameRoom = here.R === there.R && here.C === there.C;

    if (sameRoom) {
      player.pos = to;
      state.stepsLeft -= 1;
      steps.shift();
      continue;
    }

    const target = roomEntryAt(state, there);
    if (target) {
      player.pos = to;
      state.stepsLeft -= 1;
      pushLog(state, `${player.name} passes into the ${ctx.rooms[target.roomId].name}.`);
      // Walking back into a room is entering it, so a room already on the table
      // still hands out a room entrance card.
      resolveEntrance(state, ctx, there, to);
      flipForSecondPlayer(state, ctx, there);
      steps.shift();
      continue;
    }

    // Unexplored: draw the top card. Every card carries a door on some side, so
    // it can always be turned to open onto the doorway it was reached through.
    const roomId = state.roomDeck.pop();
    // The room deck is the one deck that does not replenish: once every room is
    // on the table there is no house left to open, only the one you are in.
    if (!roomId) {
      throw new Error('the house is complete — there is no room left to turn over');
    }

    player.pos = to;
    state.stepsLeft -= 1;
    state.drewThisTurn = true;
    state.pending = {
      kind: 'placeRoom',
      playerId: player.id,
      at: to,
      from: { ...from },
      roomId,
    };
    pushLog(state, `${player.name} steps into the dark and draws the ${ctx.rooms[roomId].name}.`);
    return state;
  }
  return state;
}

function doPlace(state, action, ctx) {
  const pending = state.pending;
  if (!pending || pending.kind !== 'placeRoom') {
    throw new Error('no room is waiting to be placed');
  }
  const room = ctx.rooms[pending.roomId];
  if (!room) throw new Error(`unknown room "${pending.roomId}"`);

  const rot = Number(action.orient);
  if (!Number.isInteger(rot) || rot < 0 || rot > 3) {
    throw new Error('orient must be 0, 1, 2 or 3 (quarter turns clockwise)');
  }

  const dir = travelDir(pending.from, pending.at);
  if (!dir) throw new Error('the drawn card is not next to the space that was entered');
  const back = OPPOSITE[dir];
  if (!doorsAt(room, rot)[back][DOOR_AT]) {
    throw new Error(
      `the ${room.name} has no door on its ${DIR_WORD[back]} side, so the way in would be walled off`,
    );
  }

  const slot = slotOf(pending.at);
  state.rooms[roomKey(slot.R, slot.C)] = { roomId: pending.roomId, rot };
  pushLog(
    state,
    `The ${room.name} is set down, turned ${rot * 90}°, with ${openingsAt(room, rot)} opening${openingsAt(room, rot) === 1 ? '' : 's'}.`,
  );
  // Entering the room is what turns the entrance card: the investigator is now
  // standing on the square just inside the doorway, and everything else follows
  // from that square.
  resolveEntrance(state, ctx, slot, pending.at);

  state.pending = null;

  // No automatic continuation: at the table you look at the card you drew before
  // deciding whether to keep walking, and the unspent step stays yours.
  return state;
}

function doEndTurn(state, ctx) {
  if (state.pending) throw new Error('place the drawn room before ending the turn');

  const player = currentPlayer(state);
  pushLog(state, `${player.name} ends their turn.`);
  state.actionsLeft = 0;
  state.stepsLeft = 0;
  state.drewThisTurn = false;
  state.entranceThisTurn = false;
  // Movement bought with an item lasts one turn, so the allowance goes back to
  // what the scenario printed before the next investigator starts.
  state.moveRange = ctx.scenario.turn.moveRange;

  // A scenario may still turn cards up at the end of a turn, while the
  // investigator is standing where they stopped — see revealAtEndOfTurn. The
  // mansion does not: looking into a card costs one of the turn's two actions.
  revealAtEndOfTurn(state, ctx, player);

  // "If a Monster is in an adjacent space at the end of a player's turn, that
  // player becomes engaged."
  if (!player.out && !player.down) {
    for (const monster of state.monsters ?? []) {
      if (within(player.pos, monster.pos, 1)) engage(state, player, monster);
    }
  }
  player.bound = [];
  player.fledReroll = false;
  player.hunchUsed = false;

  let nextSeat = state.turnIndex + 1;
  while (nextSeat < state.players.length && state.players[nextSeat].out) nextSeat += 1;
  if (nextSeat < state.players.length) {
    state.turnIndex = nextSeat;
    state.actionsLeft = state.actionsPerTurn;
    return state;
  }

  // Everyone has acted: the round ends and the corridors may shift. The die goes
  // round the table one player per round, so nobody rolls twice running.
  const endingRound = state.round;
  // Cards timed to the end of a round go over before the house moves, so the
  // table sees them before the corridors turn.
  flipAtRoundEnd(state, ctx, endingRound);
  monstersAtRoundEnd(state, ctx);
  bossAtRoundEnd(state, ctx);
  const seated = onTable(state);
  const roller = seated[(endingRound - 1) % seated.length];
  state.lastShift = resolveShift(state, endingRound, roller, ctx);
  state.round = endingRound + 1;
  state.turnIndex = state.players.findIndex((p) => !p.out);
  state.actionsLeft = state.actionsPerTurn;
  return state;
}

/* ------------------------------------------------------------------ *
 * Shift phase
 * ------------------------------------------------------------------ */

/**
 * End-of-round shift.
 *
 * One player rolls a d6 and has to roll higher than the bar. The bar starts at 5
 * and drops by one for every round the house has stood still, so the first round
 * wants a 6, then 5+, 4+, 3+, 2+, and on the sixth round without a shift the bar
 * reaches zero — zero because a d6 is never lower than one, so it always beats
 * it, and the house turns of its own accord. A shift of any kind, rolled or
 * automatic, puts the bar straight back to 5.
 *
 * A Shift Point marked by a room entrance card pulls the bar down a step early,
 * exactly as if a quiet round had gone by — see resolveEntrance.
 *
 * The ladder lives in the scenario as data, so a scenario that wants a gentler
 * house changes one list rather than the rules.
 *
 * A shift turns every room orthogonally next to the roller's room a quarter
 * clockwise. Investigators inside a turning room turn with it, ending up in the
 * square the card carried them to — which is why walking can become a trap.
 */
function resolveShift(state, round, roller, ctx) {
  const cfg = state.shift;
  const ladder = cfg.ladder ?? [5, 4, 3, 2, 1, 0];
  const step = Math.min(state.shiftPressure, ladder.length - 1);
  const bar = ladder[step];
  const needed = bar > 0 ? bar + 1 : null;
  let roll = null;
  let occurs;

  // The house will not keep anyone in for good: while an investigator is
  // stuck, the shift happens without a roll (shift.forceWhenStuck).
  const force = cfg.forceWhenStuck;
  const stuck = force ? onTable(state).filter((p) => isStuck(state, ctx, p, force.test)) : [];

  if (stuck.length > 0) {
    occurs = true;
    pushLog(
      state,
      `Round ${round}: ${stuck.map((p) => p.name).join(' and ')} ${stuck.length === 1 ? 'is' : 'are'} cut off, so the house shifts without a roll.`,
    );
  } else if (bar <= 0) {
    occurs = true;
    pushLog(
      state,
      `Round ${round}: ${roller.name} rolls for the shift — the house has stood still ${step + 1} rounds, so it turns of its own accord.`,
    );
  } else {
    roll = randomInt(state, cfg.die) + 1;
    occurs = roll > bar;
    pushLog(
      state,
      `Round ${round}: ${roller.name} rolls ${roll} for the shift, needs ${needed}+. ${
        occurs ? 'The corridors twist.' : 'Nothing moves.'
      }`,
    );
  }

  if (!occurs) {
    state.shiftPressure += 1;
    return { occurred: false, round, roll, roller: roller.id, needed, rotated: [] };
  }

  state.shiftPressure = 0;
  const rotated = [];
  // Normally the rooms around the roller turn; a forced shift may instead turn
  // the rooms around whoever is stuck.
  const centres =
    stuck.length > 0 && force.centre === 'stuck' ? stuck.map((p) => slotOf(p.pos)) : [slotOf(roller.pos)];
  const around = new Map();
  for (const slot of centres) {
    for (const dir of DIRS) {
      const near = { R: slot.R + dir.dr, C: slot.C + dir.dc };
      around.set(roomKey(near.R, near.C), near);
    }
  }

  for (const near of around.values()) {
    const entry = roomEntryAt(state, near);
    if (!entry) continue;
    const room = ctx.rooms[entry.roomId];
    if (cfg.exemptRooms?.includes(entry.roomId)) {
      pushLog(state, `The ${room.name} holds its shape.`);
      continue;
    }

    const turned = rotateRoom(state, ctx, near);
    if (turned) rotated.push(turned);
  }

  if (rotated.length === 0) pushLog(state, 'Nothing near enough to move.');
  return { occurred: true, round, roll, roller: roller.id, needed, rotated };
}

/* ------------------------------------------------------------------ *
 * Room entrance resolution
 * ------------------------------------------------------------------ */

function posOfNumber(slot, number) {
  const r = Math.floor((number - 1) / ROOM_SIZE);
  const c = (number - 1) % ROOM_SIZE;
  return posOf(slot.R, slot.C, r, c);
}

function numberOfPos(pos) {
  const local = localOf(pos);
  return local.r * ROOM_SIZE + local.c + 1;
}

const posKey = (pos) => `${pos.gr},${pos.gc}`;

function listSquares(numbers) {
  const marks = numbers.map((n) => `[${n}]`);
  if (marks.length <= 1) return marks.join('');
  return `${marks.slice(0, -1).join(', ')} and ${marks[marks.length - 1]}`;
}

/**
 * Which square the next card goes on.
 *
 * Fixed placements simply read down the list. Everything else has to choose,
 * and the choice is made from the squares that are actually free: a square with
 * a card on it already, or with an investigator standing on it, is not free for
 * a card that has to be put somewhere sensible.
 */
function chooseSquare(state, placement, slot, entry, taken, index) {
  if (placement.kind === 'fixed') return placement.spaces[index] ?? null;

  const free = [];
  for (let n = 1; n <= SPACE_NUMBERS; n++) {
    if (taken.has(n)) continue;
    if (state.encounters[posKey(posOfNumber(slot, n))]) continue;
    free.push(n);
  }
  if (free.length === 0) return null;

  if (placement.kind === 'random') return free[randomInt(state, free.length)];

  let pool;
  if (placement.kind === 'corners') {
    pool = free.filter((n) => CORNER_SPACES.includes(n));
  } else if (placement.kind === 'edges') {
    pool = free.filter((n) => EDGE_SPACES.includes(n));
  } else {
    // nearest and farthest are measured from the square the investigator came in
    // on. They are standing on it, so it is never a candidate for either.
    const stood = new Set(onTable(state).map((p) => posKey(p.pos)));
    pool = free.filter((n) => !stood.has(posKey(posOfNumber(slot, n))));
    if (pool.length === 0) return null;
    const away = (n) => {
      const pos = posOfNumber(slot, n);
      return Math.abs(pos.gr - entry.gr) + Math.abs(pos.gc - entry.gc);
    };
    const best =
      placement.kind === 'nearest'
        ? Math.min(...pool.map(away))
        : Math.max(...pool.map(away));
    pool = pool.filter((n) => away(n) === best);
  }

  return pool.length > 0 ? pool[randomInt(state, pool.length)] : null;
}

/**
 * Take the top card of a deck, shuffling its discards back in when it runs dry.
 *
 * Every deck in the house replenishes this way. The room deck is the one
 * exception: there are only so many rooms, and when they are all on the table
 * the house is finished and the investigators have to live in it.
 */
function drawFrom(state, deckName, discardName, label) {
  if (state[deckName].length === 0) {
    if (state[discardName].length === 0) return null;
    state[deckName] = shuffle(state, state[discardName]);
    state[discardName] = [];
    pushLog(state, `The ${label} deck is spent, so its cards are shuffled and it begins again.`);
  }
  return state[deckName].pop();
}

/**
 * Take the next room entrance card.
 *
 * Because every entry draws — including walking back into a room you already
 * know — the deck is asked for far more cards than it holds, so it replenishes.
 */
function drawEntrance(state) {
  const id = drawFrom(state, 'entranceDeck', 'entranceSeen', 'room entrance');
  if (id === null) {
    pushLog(state, 'The room entrance deck is spent. This room is entered in silence.');
  }
  return id;
}

/**
 * Put an encounter card on one square of a room.
 *
 * The card is dealt here, when it is laid down, not when it is turned over: a
 * card lying face down on the table is a particular card already, exactly as it
 * would be in a hand of cards, and two effects depend on that being true — card
 * 18 shuffles one back into the deck, and the Mirror Shard looks at the top of
 * it. What is under it stays hidden until someone turns it, because `type` is
 * left empty until then and nothing should read a card's kind off a face-down
 * square.
 *
 * Returns how the placement went, because "that square is taken" and "there is
 * no card left to deal" want different words at the table.
 */
function placeEncounter(state, ctx, slot, number, card) {
  const key = posKey(posOfNumber(slot, number));
  if (state.encounters[key]) return 'occupied';

  const id = drawFrom(state, 'encounterDeck', 'encounterDiscard', 'encounter');
  if (id === null) return 'empty';

  state.encounters[key] = {
    entranceId: card.id,
    room: roomKey(slot.R, slot.C),
    number,
    cardId: id,
    type: null,
    faceUp: false,
    flip: card.specials.flip,
    flipRound: card.specials.flip === 'end-of-next-round' ? state.round + 1 : null,
  };
  return 'placed';
}

function turnUp(state, ctx, key, why) {
  const marker = state.encounters[key];
  if (!marker || marker.faceUp) return;

  const [R, C] = marker.room.split(',').map(Number);
  const entry = state.rooms[roomKey(R, C)];
  const name = entry ? ctx.rooms[entry.roomId].name : 'room';
  pushLog(state, `A face-down encounter card turns over in the ${name} — ${why}.`);

  // revealEncounter is the one place that turns a card over and reads it, so it
  // is also the one place that knows what a card is. Turning it over says what it
  // is and nothing more: what it is worth is taken up by investigating it.
  revealEncounter(state, ctx, key);
}

/**
 * What was under the card, and what it is replaced by.
 *
 * An encounter card is not the thing itself: it names which of the house's decks
 * to turn to, and is then replaced by whatever comes off it. A Clue and a
 * Nothing are the whole of their own answer — the token goes to the investigator
 * and the card is taken off the square, so nothing is left lying there. The
 * other three call a deck of their own. An Item is taken into the investigator's
 * hand and the square is cleared. Monster and Event decks are not in the game
 * yet, so those cards stay where they are with their type showing rather than
 * vanishing with their news untold. When those decks arrive, this is the one
 * place that has to learn what they put on the table.
 */
/**
 * Turn a card over: the encounter deck says what it is.
 *
 * This is all a reveal does. What the card is worth is taken up separately, in
 * collectEncounter, because a card laid face up by an entrance card — or turned
 * by a lantern, or by a second investigator walking into the room — tells you
 * what is lying there without putting anything in your hands. You still have to
 * walk over and look.
 */
function revealEncounter(state, ctx, key) {
  if (!ctx.encounterCards) return null;
  const marker = state.encounters[key];
  // The card was dealt when it was laid; turning it over is only the moment it
  // stops being hidden.
  if (!marker || marker.faceUp) return null;

  const card = encounterCardOf(ctx, marker.cardId);
  if (!card) throw new Error(`unknown encounter card "${marker.cardId}"`);

  marker.faceUp = true;
  marker.type = card.type;

  // An Item is a card of its own, laid face up beside the encounter card, so
  // whoever turns this one can see exactly which item is lying there — it is the
  // item that waits to be taken up, not the knowledge of it.
  if (card.type === 'item') {
    const itemId = drawFrom(state, 'itemDeck', 'itemDiscard', 'item');
    if (itemId === null) {
      pushLog(state, `It is an Item on [${marker.number}], but that deck is spent and empty.`);
    } else {
      marker.itemId = itemId;
      const item = ctx.items?.[itemId];
      pushLog(state, `It is an Item — ${item ? item.name : itemId} — lying on [${marker.number}].`);
    }
    return card;
  }

  // A Monster is the monster itself: it comes off the scenario's deck and stands
  // on the square, and the encounter card is done with.
  if (card.type === 'monster' && ctx.monsterCards) {
    if (state.monsterDeck.length > 0 || state.monsterDiscard.length > 0) {
      pushLog(state, `It is a Monster, on [${marker.number}].`);
      state.encounterDiscard.push(marker.cardId);
      delete state.encounters[key];
      spawnMonster(state, ctx, posOfKey(key), 'the card is turned over');
      return card;
    }
  }

  const word = ENCOUNTER_WORD[card.type];
  pushLog(
    state,
    `It is ${/^[AEIOU]/.test(word) ? 'an' : 'a'} ${word}, showing on [${marker.number}].`,
  );
  return card;
}

/**
 * Take up a card that has been turned over — the whole point of investigating.
 *
 * A Clue and a Nothing are the whole of their own answer: the token goes to the
 * investigator and the card leaves the square. An Item is taken into the hand,
 * and an Event is read out and played. A Monster is the card itself, so it stays
 * where it was read; that deck is not in the game yet.
 */
function collectEncounter(state, ctx, key) {
  const marker = state.encounters[key];
  if (!marker || !marker.type || marker.collected) return null;

  const player = currentPlayer(state);
  // Taking the card up spends it: the encounter card leaves the table for the
  // discard pile along with the square it was lying on.
  const setAside = () => {
    if (marker.cardId) state.encounterDiscard.push(marker.cardId);
    delete state.encounters[key];
  };

  if (marker.type === 'clue') {
    player.clues = (player.clues ?? 0) + 1;
    pushLog(state, 'That is one clue to the good, and the card is taken away.');
    setAside();
    return 'clue';
  }

  if (marker.type === 'nothing') {
    pushLog(state, 'The card is taken away and nothing follows.');
    setAside();
    return 'nothing';
  }

  if (marker.type === 'item') {
    if (!marker.itemId) {
      pushLog(state, 'There is no item lying under the card to take.');
    } else {
      player.items ??= [];
      player.items.push(marker.itemId);
      const item = ctx.items?.[marker.itemId];
      pushLog(
        state,
        `The card is an item — ${item ? item.name : marker.itemId}, kept until it is needed.`,
      );
    }
    setAside();
    return 'item';
  }

  if (marker.type === 'event') {
    const eventId = drawFrom(state, 'eventDeck', 'eventDiscard', 'event');
    if (eventId === null) {
      pushLog(state, 'The event deck is spent and empty, so nothing follows.');
      return null;
    }
    const event = ctx.events?.[eventId];
    if (!event) throw new Error(`unknown event card "${eventId}"`);
    state.eventDiscard.push(eventId);
    setAside();
    pushLog(state, `The event is read out — ${event.text}`);
    if (event.needs.length > 0) {
      const words = event.needs.map((need) => NEED_WORD[need]);
      pushLog(
        state,
        `That card is still pending: it needs ${words.join(' and ')}, which the game does not have yet, so nothing happens this time.`,
      );
    } else {
      playEvent(state, ctx, event, player);
    }
    return 'event';
  }

  // A monster is the card itself: it stays where it was read, and there is
  // nothing further to take from the square.
  marker.collected = true;
  pushLog(
    state,
    'It is a Monster. That deck is not in the game yet, so the card stays where it is.',
  );
  return 'monster';
}

function playersInRoom(state, slot) {
  return onTable(state).filter((p) => {
    const at = slotOf(p.pos);
    return at.R === slot.R && at.C === slot.C;
  });
}

function flipForSecondPlayer(state, ctx, slot) {
  if (playersInRoom(state, slot).length < 2) return;
  for (const [key, marker] of Object.entries(state.encounters)) {
    if (marker.room !== roomKey(slot.R, slot.C)) continue;
    if (marker.flip !== 'second-player') continue;
    turnUp(state, ctx, key, 'a second investigator has come in');
  }
}

/**
 * The general reveal: stopping on an encounter card, or on the square next to
 * it, brings it into the light.
 *
 * How wide that ring is belongs to the scenario, because it is the kind of thing
 * a late draft changes: "none" leaves every card face down until something else
 * turns it, "on" only counts the square you are standing on, "adjacent" only
 * the squares around you, and "on-or-adjacent" both.
 *
 * Adjacency is judged inside the room. A card on the other side of a wall is not
 * next to anything, however close the squares are on the table.
 */
function revealAtEndOfTurn(state, ctx, player) {
  const mode = state.encounterReveal ?? 'none';

  const slot = slotOf(player.pos);
  const here = { pos: player.pos, where: 'there' };
  const beside = [];
  for (const dir of DIRS) {
    const at = { gr: player.pos.gr + dir.dr, gc: player.pos.gc + dir.dc };
    const there = slotOf(at);
    if (there.R !== slot.R || there.C !== slot.C) continue;
    beside.push({ pos: at, where: 'beside it' });
  }

  const house =
    mode === 'none'
      ? []
      : mode === 'on'
        ? [here]
        : mode === 'adjacent'
          ? beside
          : [here, ...beside];

  const turned = new Set();
  for (const { pos, where } of house) {
    const marker = state.encounters[posKey(pos)];
    if (!marker || marker.faceUp) continue;
    turned.add(posKey(pos));
    turnUp(state, ctx, posKey(pos), `${player.name} ended their turn ${where}`);
  }

  // "Flip it if a player ends their turn next to it" is printed on the card, so
  // it happens whether or not the scenario turns cards over on its own.
  for (const { pos, where } of beside) {
    const key = posKey(pos);
    const marker = state.encounters[key];
    if (!marker || marker.faceUp || turned.has(key)) continue;
    if (marker.flip !== 'end-turn-adjacent') continue;
    turnUp(state, ctx, key, `${player.name} ended their turn ${where}`);
  }
}

function flipAtRoundEnd(state, ctx, endingRound) {
  for (const [key, marker] of Object.entries(state.encounters)) {
    if (marker.flip !== 'end-of-next-round') continue;
    if (marker.flipRound === null || marker.flipRound > endingRound) continue;
    turnUp(state, ctx, key, 'the round has ended');
  }
}

/** The cards on the floor of a room that is turning turn with it. */
function rotateEncounterCards(state, slot) {
  const here = roomKey(slot.R, slot.C);
  for (const [key, marker] of Object.entries(state.encounters)) {
    if (marker.room !== here) continue;
    const [gr, gc] = key.split(',').map(Number);
    const local = localOf({ gr, gc });
    const to = posOf(slot.R, slot.C, local.c, ROOM_SIZE - 1 - local.r);
    const toKey = posKey(to);
    // If the square it would land on is occupied there is nowhere for it to go,
    // so it stays where it is rather than pushing the other card off the table.
    if (toKey === key || state.encounters[toKey]) continue;
    delete state.encounters[key];
    marker.number = numberOfPos(to);
    state.encounters[toKey] = marker;
  }
}

/**
 * The room's entrance card, applied every time a room is entered — the first
 * time and every time after that.
 *
 * `entry` is the square the investigator stepped onto, which is the square just
 * inside the doorway they came through. "Nearest" and "farthest" are both
 * measured from it.
 */
function resolveEntrance(state, ctx, slot, entry) {
  state.lastEntrance = null;
  if (!ctx.entrances) return;

  // "Each player may only trigger 1 Room Entrance Card per turn."
  if (state.entranceThisTurn) {
    pushLog(state, 'A Room Entrance card has already been drawn this turn, so none is drawn here.');
    return;
  }
  state.entranceThisTurn = true;

  const id = drawEntrance(state);
  if (!id) return;
  const card = ctx.entrances[id];
  if (!card) throw new Error(`unknown room entrance card "${id}"`);
  state.entranceSeen.push(id);

  const here = roomEntryAt(state, slot);
  const roomName = ctx.rooms[here.roomId].name;
  pushLog(state, `Room entrance — ${card.text}`);

  const numbers = [];
  const taken = new Set();
  for (let i = 0; i < card.draw; i++) {
    const number = chooseSquare(state, card.placement, slot, entry, taken, i);
    if (number === null) {
      pushLog(state, `There is no square left in the ${roomName} for the rest of that.`);
      break;
    }
    taken.add(number);
    const laid = placeEncounter(state, ctx, slot, number, card);
    if (laid === 'placed') {
      numbers.push(number);
    } else if (laid === 'occupied') {
      // A fixed square can already be taken when the room is entered again.
      pushLog(state, `A card already lies on [${number}] in the ${roomName}.`);
    } else {
      pushLog(state, `The encounter deck is spent, so no card can be laid on [${number}].`);
    }
  }

  if (numbers.length > 0) {
    const way = card.face === 'up' ? 'face up' : 'face down';
    pushLog(
      state,
      `${numbers.length} card${numbers.length === 1 ? '' : 's'} ${way} in the ${roomName} on ${listSquares(numbers)}.`,
    );
  }

  // A card laid face up is revealed as it lands rather than waiting for someone
  // to walk over it. A face-down one is turned by an action, a lantern, or one of
  // the entrance card's own timings.
  if (card.face === 'up') {
    for (const number of numbers) revealEncounter(state, ctx, posKey(posOfNumber(slot, number)));
  }

  // "If Monster, place another face up on [2]." The card is laid face up, so the
  // encounter deck has already answered for it by the time this runs.
  if (card.specials.ifMonsterSpace !== null && numbers.length > 0) {
    const firstKey = posKey(posOfNumber(slot, numbers[0]));
    const first = state.encounters[firstKey];
    const monsterThere = (state.monsters ?? []).some((m) => posKey(m.pos) === firstKey);
    if ((first && first.type === 'monster') || monsterThere) {
      const number = card.specials.ifMonsterSpace;
      if (placeEncounter(state, ctx, slot, number, card) === 'placed') {
        // It counts as one of the room's cards, so the record of the entrance
        // includes it and the board can point at it.
        numbers.push(number);
        pushLog(state, `It is a monster, so a card lies face up on [${number}].`);
        // The second card is laid face up too, so it is revealed as it lands.
        revealEncounter(state, ctx, posKey(posOfNumber(slot, number)));
      }
    }
  }

  if (card.specials.discardOne) {
    pushLog(state, 'A second card is drawn and put aside unseen.');
  }

  // "Mark 1 Shift Point" — the house comes one step closer to turning. It is the
  // same bar the round-end roll uses, so a point does what a quiet round does,
  // only now rather than at the end of the round. Two points stack.
  if (card.specials.shiftPoints > 0) markShiftPoint(state, card.specials.shiftPoints);

  // "Player chooses 1 face down encounter card and turns it face up." With the
  // cards still blank there is nothing to read, so the choice is the first one
  // lying in this room. A chooser belongs in the UI once cards have faces.
  if (card.specials.playerChoice) {
    const key = Object.keys(state.encounters).find(
      (k) => state.encounters[k].room === roomKey(slot.R, slot.C) && !state.encounters[k].faceUp,
    );
    if (key) turnUp(state, ctx, key, 'the investigator chose it');
    else pushLog(state, 'There is nothing face down in this room to turn over.');
  }

  state.lastEntrance = {
    id,
    slot: roomKey(slot.R, slot.C),
    entry: { ...entry },
    numbers,
    placed: numbers.map((n) => posKey(posOfNumber(slot, n))),
  };
}

/* ------------------------------------------------------------------ *
 * Replay
 * ------------------------------------------------------------------ */

/** Rebuild a game from its seed and action list. */
export function replay(ctx, options, actions) {
  let state = createGame(ctx, options);
  for (const action of actions) state = reduce(state, action, ctx);
  return state;
}

/** The portable record of a game: everything needed to reproduce it. */
export function exportReplay(state, actions) {
  return {
    scenarioId: state.scenarioId,
    seed: state.seed,
    playerNames: state.players.map((p) => p.name),
    actions,
  };
}
