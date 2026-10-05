// ---------------------------------------------------------------------------------------------
// The owner's map file, read as a grid of cells.
//
// This module is the whole of the cell model, and it is a pure module: no DOM, no Three.js, no
// network, no Node API. It is handed the parsed JSON and gives back a grid, a cell-to-world
// conversion and the route between two cells. Everything it refuses, it refuses with a reason that
// names what it found, because a map that loads wrong is worse than a map that refuses to load.
//
// **One cell is one world unit, and that is stated once.** `cellCenter` is the only place a cell
// coordinate becomes a position, and it is the only place the plate's half size is subtracted. A
// second copy of that subtraction somewhere in the client is a map whose road and whose monsters
// disagree about where the road is, and nothing would say so.
//
// **A route is derived from the grid, never written down.** What is not derived from the road cannot
// stay in step with it: a route written as points survives an edit to the file that moves the road
// under it, and the monsters walk on air. So the route is the shortest walk over road cells, found by
// breadth-first search, and the order the search tries neighbours in is fixed below and commented —
// an unfixed order makes the path a function of the runtime rather than of the map.
// ---------------------------------------------------------------------------------------------

import type { Vec2 } from './types.ts';

/** The only map file version this build reads. A file declaring another one is refused, not guessed at. */
export const MAP_FILE_VERSION = 1;

/**
 * The three classes of mistake a map file can be refused for, declared once and as classes rather
 * than as messages. A reader with a bad file in hand needs to know which of the three they have —
 * "invalid map" sends them back to the file looking for all of them — and a caller that wants to react
 * to a refusal differently by cause needs something to branch on that is not the text.
 *
 *   * `version` — the file came from an editor whose output this build has no reading for.
 *   * `symbol` — a cell carries a character that is not one of the three kinds.
 *   * `grid-shape` — the rows are not the shape the file declares: wrong count, wrong length, or not text.
 */
export const MAP_FILE_REFUSAL_CLASSES: readonly string[] = ['version', 'symbol', 'grid-shape'];

/** What a cell is. Three kinds, and every permission in the game follows from which one it is. */
export type CellKind = 'free' | 'road' | 'occupied';

export type MapCell = { x: number; y: number };

/**
 * A refusal from the map file, with the reason held separately so a caller can publish it without
 * having to strip a message apart. `reason` names the value that was actually found.
 */
export class MapFileError extends Error {
  public readonly reason: string;
  /** One of `MAP_FILE_REFUSAL_CLASSES`, so a caller can react by cause without parsing the text. */
  public readonly refusal: string;

  public constructor(refusal: string, reason: string) {
    super(reason);
    this.name = 'MapFileError';
    this.reason = reason;
    this.refusal = refusal;
  }
}

export type MapGrid = {
  version: number;
  name: string;
  width: number;
  height: number;
  /** The kind at a cell, or null when the cell is off the plate. */
  kindAt: (cell: MapCell) => CellKind | null;
  counts: Record<CellKind, number>;
};

/**
 * The one thing the spot rules ask of a map: what is at a cell. Narrower than `MapGrid` on purpose,
 * because placement only reads kinds and a caller holding a whole grid should not have to be a whole
 * grid to ask a question about four cells. A `MapGrid` satisfies it, and so does the minimal reader
 * a caller builds for itself.
 */
export type SpotReader = {
  width: number;
  height: number;
  kindAt: (cell: MapCell) => CellKind | null;
};

// A Map rather than an object literal: a file carrying the symbol `constructor` is an unknown symbol
// like any other, and a plain lookup table would answer `constructor` for it.
const KIND_BY_SYMBOL = new Map<string, CellKind>([
  ['.', 'free'],
  ['#', 'road'],
  ['X', 'occupied'],
]);

/** How a value that is not the expected shape is named in a refusal, so every refusal reads alike. */
const describe = (value: unknown): string =>
  typeof value === 'string' ? JSON.stringify(value) : String(value);

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * Reads the owner's file into a grid, or refuses with one of three reasons.
 *
 * The three refusals are deliberately distinct, because they are three different mistakes: a file
 * from a newer editor, a symbol this build has no meaning for, and a grid whose shape does not match
 * what it declares. A reader who has one of those in hand has to be told which one it is — "invalid
 * map" sends them back to the file to look for all three.
 */
export const readMapGrid = (raw: unknown): MapGrid => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MapFileError(
      'grid-shape',
      `Map file is ${Array.isArray(raw) ? 'an array' : describe(raw)}, not a map object`,
    );
  }
  const file = raw as Record<string, unknown>;
  const name = typeof file.name === 'string' && file.name.length > 0 ? file.name : 'unnamed map';

  if (file.version !== MAP_FILE_VERSION) {
    throw new MapFileError(
      'version',
      `Map ${name} declares version ${describe(file.version)} · this build reads version ${MAP_FILE_VERSION}`,
    );
  }
  if (!positiveInteger(file.width) || !positiveInteger(file.height)) {
    throw new MapFileError(
      'grid-shape',
      `Map ${name} declares ${describe(file.width)} by ${describe(file.height)} · both sides must be whole positive numbers`,
    );
  }
  const width = file.width;
  const height = file.height;

  const rows = file.grid;
  if (!Array.isArray(rows)) {
    throw new MapFileError('grid-shape', `Map ${name} carries no grid · expected ${height} rows`);
  }
  if (rows.length !== height) {
    throw new MapFileError(
      'grid-shape',
      `Map ${name} declares height ${height} but carries ${rows.length} rows`,
    );
  }

  const kinds = new Array<CellKind>(width * height);
  const counts: Record<CellKind, number> = { free: 0, road: 0, occupied: 0 };
  for (let y = 0; y < height; y += 1) {
    const row = rows[y];
    if (typeof row !== 'string') {
      throw new MapFileError('grid-shape', `Map ${name} row ${y} is ${describe(row)} · every row is one string`);
    }
    if (row.length !== width) {
      throw new MapFileError(
        'grid-shape',
        `Map ${name} row ${y} carries ${row.length} cells · its width is ${width}`,
      );
    }
    for (let x = 0; x < width; x += 1) {
      const symbol = row.charAt(x);
      const kind = KIND_BY_SYMBOL.get(symbol);
      if (kind === undefined) {
        throw new MapFileError(
          'symbol',
          `Map ${name} carries unknown symbol ${describe(symbol)} at ${x}, ${y}`,
        );
      }
      kinds[y * width + x] = kind;
      counts[kind] += 1;
    }
  }

  const kindAt = (cell: MapCell): CellKind | null => {
    if (cell.x < 0 || cell.y < 0 || cell.x >= width || cell.y >= height) {
      return null;
    }
    return kinds[cell.y * width + cell.x] ?? null;
  };

  return { version: file.version as number, name, width, height, kindAt, counts };
};

// The only cell-to-world conversion in the project. The plate runs from -width/2 to +width/2, so the
// centre of cell (x, y) sits half a unit in from the near edge of that cell. One function, so a plate
// that ever grows a different size has one place to change.
export const cellCenter = (grid: SpotReader, cell: MapCell): Vec2 => ({
  x: cell.x - grid.width / 2 + 0.5,
  z: cell.y - grid.height / 2 + 0.5,
});

/** The corners of a cell in world units, taken from `cellCenter` so there is no second conversion. */
export const cellBounds = (grid: SpotReader, cell: MapCell): readonly [number, number, number, number] => {
  const centre = cellCenter(grid, cell);
  return [centre.x - 0.5, centre.z - 0.5, centre.x + 0.5, centre.z + 0.5];
};

export const sameCell = (a: MapCell, b: MapCell): boolean => a.x === b.x && a.y === b.y;

// ---------------------------------------------------------------------------------------------
// Spots: where a tower stands.
//
// **A spot is a 4×4 square of cells, and all sixteen have to be free.** Not "mostly free" and not
// "the cell you clicked is free": a tower standing partly on the carriageway is a tower the road
// walks through, and a tower standing on rock is a tower hanging off the map. So the square is the
// test, and the click only chooses which square.
//
// **The clicked cell is the square's minimum-x, minimum-y corner** — the anchor. Not its centre,
// because a four-wide square has no centre cell and "nearest cell to the click" would make the spot
// a function of sub-cell pointer position, which is the picking bug this project has already paid for
// once at 125% system scale. The anchor is the cell, and the tower stands 1.5 units in from it: the
// centre of four cells is half a cell past the centre of the second one.
//
// **The name is the cell.** `spot-47-12` is cell (47, 12) and reads back as exactly that, with no
// table and no counter: a name handed out by a counter survives an edit to the map file and then
// points at the wrong square, and a save that stored such a name would replay onto ground the player
// never chose. The prefix carries no numbers, so splitting on it is unambiguous for any cell on a
// plate under a thousand across, and `cellForSpotId` refuses rather than guesses on anything else.
// ---------------------------------------------------------------------------------------------

/** A tower stands on four cells by four. Sixteen cells, and every one of them has to be free. */
export const TOWER_FOOTPRINT_CELLS = 4;

const SPOT_PREFIX = 'spot-';

/** The name of the spot anchored at a cell. Derived from the cell, so it reads back as that cell. */
export const spotIdForCell = (cell: MapCell): string => `${SPOT_PREFIX}${cell.x}-${cell.y}`;

/** The cell a spot name reads back as, or null when the name is not a spot name of this build. */
export const cellForSpotId = (spotId: string): MapCell | null => {
  if (!spotId.startsWith(SPOT_PREFIX)) {
    return null;
  }
  const rest = spotId.slice(SPOT_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0 || dash === rest.length - 1) {
    return null;
  }
  const x = Number(rest.slice(0, dash));
  const y = Number(rest.slice(dash + 1));
  // `Number` accepts things a spot name never holds, so both halves are checked as whole positive
  // digits rather than trusted: "1e2-3" and " 4-5" would otherwise name cells that exist.
  const digits = (part: string): boolean => part.length > 0 && /^[0-9]+$/.test(part);
  if (!digits(rest.slice(0, dash)) || !digits(rest.slice(dash + 1))) {
    return null;
  }
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return null;
  }
  return { x, y };
};

/**
 * The sixteen cells a spot anchored at `cell` stands on, in the same order every time: four rows of
 * four, each row left to right. The order is stated because a caller that reads "how many of these are
 * free" should not have to care, and because a stable order means the first blocking cell a refusal
 * names is the same cell every run of the same match.
 */
export const spotCells = (cell: MapCell): MapCell[] => {
  const cells: MapCell[] = [];
  for (let dy = 0; dy < TOWER_FOOTPRINT_CELLS; dy += 1) {
    for (let dx = 0; dx < TOWER_FOOTPRINT_CELLS; dx += 1) {
      cells.push({ x: cell.x + dx, y: cell.y + dy });
    }
  }
  return cells;
};

/** Where a tower stands in world units for a spot anchored at a cell: the middle of its four cells. */
export const spotCenter = (grid: SpotReader, cell: MapCell): Vec2 => {
  const anchor = cellCenter(grid, cell);
  const half = (TOWER_FOOTPRINT_CELLS - 1) / 2;
  return { x: anchor.x + half, z: anchor.z + half };
};

/**
 * Why a spot cannot exist, as a class and not as a sentence. Three causes, and they are three
 * different facts about the map rather than three ways of saying "no": the clicked cell is part of the
 * road, the clicked cell is ground the map has taken, or the clicked cell is free but the sixteen
 * around it are not all free. A square that runs off the plate is a fourth, because a spot whose
 * sixteenth cell is not on the map is not a spot that was blocked by anything.
 *
 * Refused rather than reported as a boolean, and the reason is the spot id: the caller holds a name
 * and a name can be wrong in more ways than one, so what comes back has to say which way it was wrong.
 */
export type SpotRefusal =
  | 'spot-on-road'
  | 'spot-on-occupied'
  | 'spot-off-plate'
  | 'spot-square-blocked';

export type SpotCheck =
  | { allowed: true; cell: MapCell; cells: MapCell[] }
  | { allowed: false; refusal: SpotRefusal; cell: MapCell | null; blocked?: number };

/**
 * Whether a spot can exist at a cell, and if not, which of the four reasons stopped it. The anchor's
 * own kind is asked first, because the anchor is the cell the player pointed at and it is the reason
 * they will read; the other fifteen are counted so a caller can say how much of the square is spoken
 * for rather than only that something is.
 */
export const checkSpot = (grid: SpotReader, cell: MapCell): SpotCheck => {
  const anchorKind = grid.kindAt(cell);
  if (anchorKind === null) {
    return { allowed: false, refusal: 'spot-off-plate', cell: null };
  }
  // No count on these two, and that is the point of `blocked` being optional: the anchor is road or
  // occupied, so the fact that decides it is one cell rather than a tally of the square around it, and
  // a zero here would read as "nothing of the square is blocked" rather than "this count does not apply".
  if (anchorKind === 'road') {
    return { allowed: false, refusal: 'spot-on-road', cell };
  }
  if (anchorKind === 'occupied') {
    return { allowed: false, refusal: 'spot-on-occupied', cell };
  }
  const cells = spotCells(cell);
  let blocked = 0;
  for (const spotCell of cells) {
    if (grid.kindAt(spotCell) !== 'free') {
      blocked += 1;
    }
  }
  if (blocked > 0) {
    return { allowed: false, refusal: 'spot-square-blocked', cell, blocked };
  }
  return { allowed: true, cell, cells };
};

/**
 * Every cell on the plate where a spot can exist. The whole set, not a chosen handful of it: the
 * board is the free ground, and a map that declared forty spots and left two thousand legal squares
 * unmentioned would be a map whose places are a list again. Read once per plate and kept by the
 * caller, because it costs one pass over 9 216 cells and callers ask for it every frame.
 */
export const findSpots = (grid: SpotReader): MapCell[] => {
  const cells: MapCell[] = [];
  for (let y = 0; y + TOWER_FOOTPRINT_CELLS <= grid.height; y += 1) {
    for (let x = 0; x + TOWER_FOOTPRINT_CELLS <= grid.width; x += 1) {
      if (checkSpot(grid, { x, y }).allowed) {
        cells.push({ x, y });
      }
    }
  }
  return cells;
};

// ---------------------------------------------------------------------------------------------
// The route.
//
// Breadth-first search over road cells, and the neighbour order is written out rather than left to a
// loop over directions: an unfixed order returns a different shortest path on a different runtime or
// after an unrelated edit, and a route that changes because nothing about the map changed is not a
// route anybody can reason about. North, then east, then south, then west — declared once, used
// everywhere, and the reason a map with two equally short ways to the core always takes the same one.
//
// A route is a walk, not a cycle. It starts at the spawn cell and ends at the core cell, and there is
// no second lap: a creature that arrives has arrived, which is what makes a leak final.
// ---------------------------------------------------------------------------------------------

const NEIGHBOUR_ORDER: ReadonlyArray<readonly [dx: number, dy: number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export type RouteWalk = {
  /** Every cell on the walk, spawn first and core last. */
  cells: MapCell[];
  /** The walk in world units, straight runs collapsed to one segment each. */
  points: Vec2[];
  /** Length in cells — the number of steps between the first cell and the last. */
  lengthInCells: number;
  /** The same length in world units. One cell is one unit, so the two agree, and both are named. */
  lengthInUnits: number;
};

/**
 * The shortest walk of road cells from one cell to another, or null when the core is not reachable on
 * road from that spawn. Not a throw: one unreachable spawn is a fact about the map, and the caller
 * decides whether it is a reason to refuse.
 */
export const findRouteCells = (grid: MapGrid, from: MapCell, to: MapCell): MapCell[] | null => {
  if (grid.kindAt(from) !== 'road' || grid.kindAt(to) !== 'road') {
    return null;
  }
  const size = grid.width * grid.height;
  const index = (x: number, y: number): number => y * grid.width + x;
  const cameFrom = new Int32Array(size).fill(-1);
  const queued = new Uint8Array(size);
  const queue: number[] = [index(from.x, from.y)];
  queued[index(from.x, from.y)] = 1;
  const target = index(to.x, to.y);

  for (let head = 0; head < queue.length; head += 1) {
    const here = queue[head] as number;
    if (here === target) {
      const cells: MapCell[] = [];
      for (let step = target; step >= 0; step = cameFrom[step] as number) {
        cells.push({ x: step % grid.width, y: Math.floor(step / grid.width) });
      }
      return cells.reverse();
    }
    const x = here % grid.width;
    const y = Math.floor(here / grid.width);
    for (const [dx, dy] of NEIGHBOUR_ORDER) {
      const nx = x + dx;
      const ny = y + dy;
      if (grid.kindAt({ x: nx, y: ny }) !== 'road') {
        continue;
      }
      const next = index(nx, ny);
      if (queued[next] === 1) {
        continue;
      }
      queued[next] = 1;
      cameFrom[next] = here;
      queue.push(next);
    }
  }
  return null;
};

/**
 * The walk as a polyline: cells that continue in the same direction are one segment, so a straight
 * run of road is two points and not twenty. The corners are what is left, and the polyline passes
 * through cell centres, which is where a creature standing in that cell actually stands.
 */
export const routePolyline = (grid: MapGrid, cells: readonly MapCell[]): Vec2[] => {
  if (cells.length === 0) {
    return [];
  }
  const corners: MapCell[] = [cells[0] as MapCell];
  for (let index = 1; index < cells.length - 1; index += 1) {
    const previous = cells[index - 1] as MapCell;
    const here = cells[index] as MapCell;
    const next = cells[index + 1] as MapCell;
    const turnedX = Math.sign(here.x - previous.x) !== Math.sign(next.x - here.x);
    const turnedY = Math.sign(here.y - previous.y) !== Math.sign(next.y - here.y);
    if (turnedX || turnedY) {
      corners.push(here);
    }
  }
  corners.push(cells[cells.length - 1] as MapCell);
  return corners.map((cell) => cellCenter(grid, cell));
};

/** The walk and everything a reader needs to say how long it is, in cells and in units. */
export const buildRouteWalk = (grid: MapGrid, from: MapCell, to: MapCell): RouteWalk | null => {
  const cells = findRouteCells(grid, from, to);
  if (cells === null) {
    return null;
  }
  const lengthInCells = cells.length - 1;
  return {
    cells,
    points: routePolyline(grid, cells),
    lengthInCells,
    // One cell is one world unit, so the step count is the length. Named rather than assumed, because
    // "the length of the route" has meant several different things in this project already.
    lengthInUnits: lengthInCells,
  };
};