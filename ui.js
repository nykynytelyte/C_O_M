/**
 * Corridors of Madness — table UI.
 *
 * This file renders state and sends actions. It decides no rules: every
 * legality question is answered by the engine, and anything the engine rejects
 * is shown to the player as a message rather than silently ignored.
 *
 * The board is drawn as the house actually exists in the engine: a grid of room
 * slots, each slot a 3x3 grid of squares, each door sitting at a position along
 * its side. Where two rooms share a side, the door bars line up — or they do
 * not, and then there is no way through.
 */

import {
  createGame,
  reduce,
  legalDestinations,
  pendingOrientations,
  investigateProblem,
  currentPlayer,
  roomsFromCsv,
  entrancesFromCsv,
  encountersFromCsv,
  eventsFromCsv,
  itemsFromCsv,
  investigatorsFromCsv,
  useItemProblem,
  doorsAt,
  roomKey,
  slotOf,
  OPPOSITE,
  ROOM_SIZE,
} from './engine.js';

const DIRS = [
  { key: 'n', dr: -1, dc: 0 },
  { key: 'e', dr: 0, dc: 1 },
  { key: 's', dr: 1, dc: 0 },
  { key: 'w', dr: 0, dc: -1 },
];

const DIR_KEYS = ['n', 'e', 's', 'w'];

let ctx = null;
let state = null;
let actions = [];
let reachable = new Map();
let flashTimer = null;

const el = {};

async function boot() {
  for (const id of [
    'board',
    'status',
    'log',
    'pending',
    'seed',
    'players',
    'investigate',
    'hand',
    'party',
    'seats',
    'endturn',
    'newgame',
    'copy',
    'diag',
    'flash',
  ]) {
    el[id] = document.getElementById(id);
  }

  try {
    const [scenario, roomsText, entranceText, encounterText, itemText, eventText, sheetText] =
      await Promise.all([
        fetchJson('./scenarios/mansion/scenario.json'),
        fetchText('./decks/rooms.csv'),
        fetchText('./decks/entrance.csv'),
        fetchText('./decks/encounters.csv'),
        fetchText('./decks/items.csv'),
        fetchText('./decks/events.csv'),
        fetchText('./decks/investigators.csv'),
      ]);
    ctx = {
      scenario,
      rooms: roomsFromCsv(roomsText),
      entrances: entrancesFromCsv(entranceText),
      encounterCards: encountersFromCsv(encounterText),
      items: itemsFromCsv(itemText),
      events: eventsFromCsv(eventText),
      investigators: investigatorsFromCsv(sheetText),
    };
  } catch (err) {
    el.status.textContent = `Could not load the scenario: ${err.message}`;
    return;
  }

  el.players.innerHTML = '';
  for (let n = ctx.scenario.players.min; n <= ctx.scenario.players.max; n++) {
    const option = document.createElement('option');
    option.value = String(n);
    option.textContent = `${n} investigator${n === 1 ? '' : 's'}`;
    el.players.appendChild(option);
  }
  el.players.value = String(ctx.scenario.players.default);
  buildSeats();
  el.players.addEventListener('change', buildSeats);

  el.board.addEventListener('click', onBoardClick);
  el.investigate.addEventListener('click', () => dispatch({ type: 'INVESTIGATE' }));
  el.endturn.addEventListener('click', () => dispatch({ type: 'END_TURN' }));
  el.newgame.addEventListener('click', () => newGame(true));
  el.copy.addEventListener('click', copyReplay);

  // Diagnostics explain how the engine is thinking. They are on by default while
  // the game is being built and can be switched off here or with ?debug=0.
  if (new URLSearchParams(document.location.search).get('debug') === '0') el.diag.checked = false;
  applyDebug();
  el.diag.addEventListener('change', applyDebug);

  newGame(false);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

/* ------------------------------------------------------------------ *
 * Game lifecycle
 * ------------------------------------------------------------------ */

/**
 * One drop-down per seat. The deck holds six sheets and the scenario takes up to
 * four investigators, so the seats start on different characters and any of them
 * can be swapped before the first move.
 */
function buildSeats() {
  const wanted = Number(el.players.value);
  const kept = [...el.seats.querySelectorAll('select')].map((select) => select.value);
  const ids = Object.keys(ctx.investigators ?? {});

  el.seats.innerHTML = '';
  for (let seat = 0; seat < wanted; seat++) {
    const select = document.createElement('select');
    select.dataset.seat = String(seat + 1);
    for (const id of ids) {
      const sheet = ctx.investigators[id];
      const option = document.createElement('option');
      option.value = id;
      option.textContent = sheet.name;
      select.appendChild(option);
    }
    select.value = kept[seat] ?? ids[seat] ?? ids[0];
    select.addEventListener('change', () => keepSeatsDistinct(select));
    el.seats.appendChild(select);
  }
}

/** Two seats cannot hold the same investigator. The engine refuses it, so make
 * the clash impossible here instead of explaining it after the click. */
function keepSeatsDistinct(changed) {
  const selects = [...el.seats.querySelectorAll('select')];
  for (const other of selects) {
    if (other === changed || other.value !== changed.value) continue;
    const free = Object.keys(ctx.investigators ?? {}).find(
      (id) => !selects.some((select) => select !== other && select.value === id),
    );
    if (free) other.value = free;
  }
}

function seatIds() {
  return [...el.seats.querySelectorAll('select')].map((select) => select.value);
}

function newGame(useSeedField) {
  const typed = useSeedField ? el.seed.value.trim() : '';
  const seed = typed === '' ? Math.floor(Math.random() * 0xffffffff) >>> 0 : Number(typed);
  const playerCount = Number(el.players.value);

  try {
    state = createGame(ctx, { seed, playerCount, investigatorIds: seatIds() });
    actions = [];
    el.seed.value = String(state.seed);
    render();
  } catch (err) {
    flash(err.message);
  }
}

function dispatch(action) {
  try {
    state = reduce(state, action, ctx);
    actions.push(action);
    render();
  } catch (err) {
    flash(err.message);
  }
}

function applyDebug() {
  document.body.classList.toggle('no-debug', !el.diag.checked);
}

function flash(message) {
  el.flash.textContent = message;
  el.flash.classList.add('on');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.flash.classList.remove('on'), 3600);
}

async function copyReplay() {
  const record = {
    scenarioId: state.scenarioId,
    seed: state.seed,
    playerNames: state.players.map((p) => p.name),
    actions,
  };
  const text = JSON.stringify(record);
  try {
    await navigator.clipboard.writeText(text);
    flash(`Copied ${actions.length} actions. This reproduces the game exactly.`);
  } catch {
    flash(`Clipboard blocked. Replay record: ${text}`);
  }
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

function onBoardClick(event) {
  if (state.pending || state.choice) return;
  const space = event.target.closest('[data-space]');
  if (!space) return;
  const path = reachable.get(space.dataset.space);
  if (!path) return;
  dispatch({ type: 'MOVE', path: path.map((pos) => ({ gr: pos.gr, gc: pos.gc })) });
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render() {
  reachable = new Map(
    legalDestinations(state, ctx).map((dest) => [`${dest.pos.gr},${dest.pos.gc}`, dest.path]),
  );
  renderStatus();
  renderParty();
  renderBoard();
  renderPending();
  renderHand();
  renderLog();
}

function renderStatus() {
  const player = currentPlayer(state);
  const slot = slotOf(player.pos);
  const entry = state.rooms[roomKey(slot.R, slot.C)];
  const where = entry ? ctx.rooms[entry.roomId].name : 'nowhere';
  const steps =
    state.stepsLeft > 0 ? state.stepsLeft : state.actionsLeft > 0 ? state.moveRange : 0;
  const markers = Object.values(state.encounters ?? {});
  const faceDown = markers.filter((marker) => !marker.faceUp).length;

  el.status.innerHTML =
    `<span class="stat"><b>Round</b> ${state.round}</span>` +
    `<span class="stat"><b>Turn</b> ${player.name}</span>` +
    `<span class="stat"><b>Room</b> ${where}</span>` +
    `<span class="stat"><b>Actions</b> ${state.actionsLeft} of ${state.actionsPerTurn}</span>` +
    `<span class="stat"><b>Steps</b> ${steps}</span>` +
    `<span class="stat"><b>Clues</b> ${player.clues ?? 0}${
      player.clueLimit ? ` of ${player.clueLimit}` : ''
    }</span>` +
    `<span class="stat"><b>Items</b> ${(player.items ?? []).length}</span>` +
    `<span class="stat" data-debug><b>Cards left</b> ${state.roomDeck.length}</span>` +
    `<span class="stat" data-debug><b>Encounters</b> ${faceDown} down, ${markers.length - faceDown} up</span>` +
    (state.shiftTokens
      ? `<span class="stat" data-debug><b>Shift points</b> ${state.shiftTokens}</span>`
      : '') +
    `<span class="stat" data-debug><b>Shift</b> ${shiftBarLabel(state)}</span>` +
    (state.drewThisTurn
      ? `<span class="stat" data-debug><b>New room</b> already drawn this turn</span>`
      : '');

  el.endturn.disabled = Boolean(state.pending || state.choice);

  // Investigating is only a legal action when there is a face-down card under
  // the investigator's feet and an action left to spend on it; the engine's
  // reason doubles as the button's tooltip.
  const investigate = investigateProblem(state);
  el.investigate.disabled = Boolean(investigate);
  el.investigate.title =
    investigate ??
    'Investigate the card on your square — turn it over, or take up one already showing. Costs one action.';
}

/** What the die has to beat at the end of this round: the bar slides as the
 * house stands still, and reaches automatic on the last step of the ladder. */
function shiftBarLabel(state) {
  const ladder = state.shift.ladder ?? [5, 4, 3, 2, 1, 0];
  const bar = ladder[Math.min(state.shiftPressure, ladder.length - 1)];
  return bar <= 0 ? 'automatic this round' : `${bar + 1}+ this round`;
}

function renderBoard() {
  const entries = Object.keys(state.rooms);
  let minR = Infinity;
  let maxR = -Infinity;
  let minC = Infinity;
  let maxC = -Infinity;

  for (const id of entries) {
    const [R, C] = id.split(',').map(Number);
    minR = Math.min(minR, R);
    maxR = Math.max(maxR, R);
    minC = Math.min(minC, C);
    maxC = Math.max(maxC, C);
  }

  // One ring of unexplored slots, so the growth of the house is visible.
  minR -= 1;
  maxR += 1;
  minC -= 1;
  maxC += 1;

  const cols = maxC - minC + 1;
  el.board.style.gridTemplateColumns = `repeat(${cols}, minmax(104px, 1fr))`;
  el.board.innerHTML = '';

  for (let R = minR; R <= maxR; R++) {
    for (let C = minC; C <= maxC; C++) {
      el.board.appendChild(buildSlot(R, C));
    }
  }
}

function buildSlot(R, C) {
  const slot = document.createElement('div');
  slot.className = 'slot';
  slot.dataset.slot = roomKey(R, C);

  const entry = state.rooms[roomKey(R, C)];

  if (!entry) {
    // Unexplored. The squares are still drawn, because the square just past a
    // doorway is the one you click to walk into the dark and draw the next card.
    slot.classList.add('void');
    slot.appendChild(buildSpaces(R, C, false));
    return slot;
  }

  const room = ctx.rooms[entry.roomId];
  const doors = doorsAt(room, entry.rot);

  for (const dir of DIR_KEYS) {
    doors[dir].forEach((open, offset) => {
      if (!open) return;
      const bar = document.createElement('span');
      bar.className = `door ${dir}${doorLinked(R, C, dir, offset) ? ' linked' : ''}`;
      if (dir === 'n' || dir === 's') {
        bar.style.left = `calc(${offset} * 33.333% + 6%)`;
        bar.style.width = '22%';
      } else {
        bar.style.top = `calc(${offset} * 33.333% + 6%)`;
        bar.style.height = '22%';
      }
      slot.appendChild(bar);
    });
  }

  slot.appendChild(buildSpaces(R, C, true));

  const name = document.createElement('span');
  name.className = 'slot-name';
  name.textContent = room.name;
  slot.appendChild(name);

  if (entry.roomId === ctx.scenario.startRoom) {
    const tag = document.createElement('span');
    tag.className = 'slot-tag';
    tag.dataset.debug = '';
    tag.textContent = 'fixed';
    slot.appendChild(tag);
  }

  return slot;
}

/**
 * The nine squares of a slot. In a room they are floor. In unexplored space they
 * are mostly nothing, except where a walk could step into them: those squares
 * are the only way a card gets drawn, so they have to be there to click.
 */
function buildSpaces(R, C, isRoom) {
  const spaces = document.createElement('div');
  spaces.className = 'spaces';

  for (let r = 0; r < ROOM_SIZE; r++) {
    for (let c = 0; c < ROOM_SIZE; c++) {
      const gr = R * ROOM_SIZE + r;
      const gc = C * ROOM_SIZE + c;
      const key = `${gr},${gc}`;
      const space = document.createElement('div');
      space.className = 'space';
      space.dataset.space = key;

      // An encounter card lying on this square. Face down it is a pale mark in a
      // dark tile; face up it takes the gold.
      const marker = isRoom ? state.encounters?.[key] : null;
      if (marker) {
        const chip = document.createElement('span');
        chip.className = marker.faceUp ? 'encounter up' : 'encounter';
        // Face up, the chip can say what it is — M, C, N, E or I. Face down it
        // says only that something is lying there.
        chip.textContent = marker.faceUp ? (marker.type ?? '!')[0].toUpperCase() : '?';
        chip.title = marker.faceUp
          ? `A face-up ${marker.type ?? 'encounter'} card`
          : 'A face-down encounter card';
        space.appendChild(chip);
      }

      if (isRoom) {
        state.players.forEach((player, index) => {
          if (player.pos.gr !== gr || player.pos.gc !== gc) return;
          const token = document.createElement('span');
          token.className = `token p${(index % 4) + 1}`;
          token.textContent = String(index + 1);
          token.title = player.name;
          space.appendChild(token);
        });
      }

      if (reachable.has(key)) {
        space.classList.add('reachable');
        if (!isRoom) space.classList.add('unexplored');
      }

      spaces.appendChild(space);
    }
  }

  return spaces;
}

/**
 * A door only leads anywhere if the room beyond has a door at the same place on
 * its facing side. This is what the gold bars mean.
 */
function doorLinked(R, C, dir, offset) {
  const delta = DIRS.find((d) => d.key === dir);
  const neighbour = state.rooms[roomKey(R + delta.dr, C + delta.dc)];
  if (!neighbour) return false;
  const room = ctx.rooms[neighbour.roomId];
  return doorsAt(room, neighbour.rot)[OPPOSITE[dir]][offset];
}

function renderPending() {
  if (state.choice) return renderChoice();

  if (!state.pending) {
    el.pending.hidden = true;
    el.pending.innerHTML = '';
    return;
  }

  const room = ctx.rooms[state.pending.roomId];
  const valid = pendingOrientations(state, ctx);

  el.pending.hidden = false;
  el.pending.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = room.name;
  heading.setAttribute('tabindex', '-1');
  el.pending.appendChild(heading);

  const text = document.createElement('p');
  text.textContent = room.text;
  el.pending.appendChild(text);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = `One of the doorways must meet the opening you came through. Greyed turns cannot.`;
  el.pending.appendChild(hint);

  const row = document.createElement('div');
  row.className = 'orient-row';

  for (let rot = 0; rot < 4; rot++) {
    const button = document.createElement('button');
    button.className = 'orient';
    button.disabled = !valid.includes(rot);
    button.innerHTML = `${cardGlyph(room, rot)}<span>${rot * 90}°</span>`;
    button.addEventListener('click', () => dispatch({ type: 'PLACE_ROOM', orient: rot }));
    row.appendChild(button);
  }

  el.pending.appendChild(row);
}

/**
 * A card that asks a question. The engine has paused on it and listed the
 * options; the table picks one and play carries on.
 */
function renderChoice() {
  const choice = state.choice;

  el.pending.hidden = false;
  el.pending.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = 'A choice to make';
  heading.setAttribute('tabindex', '-1');
  el.pending.appendChild(heading);

  const text = document.createElement('p');
  text.textContent = choice.prompt;
  el.pending.appendChild(text);

  const row = document.createElement('div');
  row.className = 'choice-row';
  for (const option of choice.options) {
    const button = document.createElement('button');
    button.className = 'choice';
    button.textContent = option.label;
    button.addEventListener('click', () => dispatch({ type: 'CHOOSE', optionId: option.id }));
    row.appendChild(button);
  }
  el.pending.appendChild(row);
}

function cardGlyph(room, rot) {
  const doors = doorsAt(room, rot);
  let marks = '';
  for (const dir of DIR_KEYS) {
    doors[dir].forEach((open, offset) => {
      if (!open) return;
      if (dir === 'n' || dir === 's') {
        marks += `<i class="${dir}" style="left:calc(${offset} * 33.333% + 6%);width:22%"></i>`;
      } else {
        marks += `<i class="${dir}" style="top:calc(${offset} * 33.333% + 6%);height:22%"></i>`;
      }
    });
  }
  return `<span class="card">${marks}</span>`;
}

/**
 * The party, as the table sees it: one block per investigator with the numbers
 * off their sheet. A trait whose rule is not in the game yet says so, rather
 * than looking like a power that is already in play.
 */
function renderParty() {
  el.party.innerHTML = '';

  for (const [index, player] of state.players.entries()) {
    const sheet = ctx.investigators?.[player.investigatorId];
    const block = document.createElement('div');
    block.className = index === state.turnIndex ? 'investigator turn' : 'investigator';

    const name = document.createElement('h3');
    name.textContent = player.name;
    block.appendChild(name);

    if (sheet?.role) {
      const role = document.createElement('div');
      role.className = 'role';
      role.textContent = sheet.role;
      block.appendChild(role);
    }

    const pools = document.createElement('div');
    pools.className = 'pools';
    const pool = (label, value) => {
      const span = document.createElement('span');
      const head = document.createElement('b');
      head.textContent = label;
      span.append(head, ` ${value}`);
      return span;
    };
    pools.append(
      pool('Health', sheet ? `${player.health} / ${player.healthMax}` : '—'),
      pool('Sanity', sheet ? `${player.sanity} / ${player.sanityMax}` : '—'),
      pool('Clues', sheet ? `${player.clues ?? 0} / ${player.clueLimit}` : `${player.clues ?? 0}`),
      pool('Items', `${(player.items ?? []).length}`),
    );
    block.appendChild(pools);

    if (sheet?.trait) {
      const trait = document.createElement('div');
      trait.className = 'trait';
      trait.textContent = sheet.traitNeeds
        ? `${sheet.trait} — pending: ${sheet.traitNeeds}`
        : sheet.trait;
      trait.title = sheet.traitText;
      block.appendChild(trait);
    }

    el.party.appendChild(block);
  }
}

/**
 * The active investigator's hand.
 *
 * A card whose rule is not in the game yet is shown anyway, greyed with the
 * reason in its tooltip: the table should see what it is holding and what it is
 * waiting for, rather than a card that silently does nothing.
 */
function renderHand() {
  const player = currentPlayer(state);
  const held = player.items ?? [];

  el.hand.innerHTML = '';
  if (held.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Empty.';
    el.hand.appendChild(empty);
    return;
  }

  for (const id of held) {
    const item = ctx.items?.[id];
    const button = document.createElement('button');
    button.className = 'item';

    const name = document.createElement('b');
    name.textContent = item ? item.name : id;
    const text = document.createElement('span');
    text.textContent = item ? item.text : '';
    button.append(name, text);

    const problem = useItemProblem(state, ctx, id);
    button.disabled = Boolean(problem);
    button.title = problem ?? `Use the ${item.name} — costs no action.`;
    button.addEventListener('click', () => dispatch({ type: 'USE_ITEM', itemId: id }));
    el.hand.appendChild(button);
  }
}

function renderLog() {
  el.log.innerHTML = '';
  for (const line of state.log.slice(-120)) {
    const item = document.createElement('li');
    item.textContent = line;
    el.log.appendChild(item);
  }
  el.log.scrollTop = el.log.scrollHeight;
}

boot();
