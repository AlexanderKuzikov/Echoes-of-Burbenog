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
export const cellCenter = (grid: MapGrid, cell: MapCell): Vec2 => ({
  x: cell.x - grid.width / 2 + 0.5,
  z: cell.y - grid.height / 2 + 0.5,
});

/** The corners of a cell in world units, taken from `cellCenter` so there is no second conversion. */
export const cellBounds = (grid: MapGrid, cell: MapCell): readonly [number, number, number, number] => {
  const centre = cellCenter(grid, cell);
  return [centre.x - 0.5, centre.z - 0.5, centre.x + 0.5, centre.z + 0.5];
};

export const sameCell = (a: MapCell, b: MapCell): boolean => a.x === b.x && a.y === b.y;

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