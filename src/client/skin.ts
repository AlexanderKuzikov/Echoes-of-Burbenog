// ---------------------------------------------------------------------------------------------
// The skin file, read as data.
//
// One JSON file carries everything the look of a match is made of: three ground palettes, three
// relief numbers, the sky and the sun, forty prop slots and the scatter rules for the open ground.
// This module is the whole of how that file is believed, and it is pure — no Three.js, no DOM, no
// Node API — so the same reader decides in the page and in a script.
//
// ## The unit is declared once and divided once
//
// **This is the file that already cost the project an incident.** `cellSize` is a number that
// arrived without a declared unit, and a number without a unit crosses a boundary silently. So the
// rule here is structural rather than a matter of care:
//
//   * `cellSize` is declared in exactly one place — `SKIN_CELL_SIZE_UNITS`, the only literal of its
//     kind in the project, checked against the file on read.
//   * The division happens in exactly one place — the single `skinCellSize` constant below is read
//     by `readSkin` and by nothing else, and the *result* is stored back into the definition. Every
//     length that leaves this module is already in game world units, so no other module can misuse
//     it even by accident.
//
// **Which way the conversion goes, and why that way.** One game cell is one world unit, and that is
// stated in `map-grid.ts` where `cellCenter` turns a cell into a position — this project has one
// conversion of that kind and it is not negotiable per file. The skin was written by an exporter
// whose cell was *two* world units, and it says so: `cellSize: 2`, meaning "one cell of my map is
// this many of my world units". Its relief numbers are therefore twice as tall as the same relief
// would be here, and the honest reading is to divide them. So:
//
//     skin length in skin units  ->  game length = skin length / cellSize
//
// Dividing is not a stylistic choice and it is not symmetric. Multiplying would double every height
// in the picture: `blockedLift 0.6` would become 1.2 and the occupied cells would stand as walls
// taller than the creatures walking past them, and the twenty-odd lines of this decision would come
// back in a month as "the map is the wrong size". `cellSize` is therefore a *conversion*, never a
// scale knob, and the seam publishes both the raw and the converted number so the arithmetic can be
// checked by a reader rather than taken on trust.
//
// ## Two names for the same three kinds
//
// The skin calls the third kind `blocked`, this project calls it `occupied`. That is a name crossing
// a boundary and not a fact, so the correspondence is declared once, below, and used everywhere: no
// module below this one ever sees the skin's word for a kind, and no module above it ever sees the
// skin's spelling of a length.
// ---------------------------------------------------------------------------------------------

import type { CellKind } from '../game-core/index.ts';
import { TERRAIN_KINDS, TERRAIN_SLOT_COUNT } from '../asset-registry.ts';
import type { TerrainKind } from '../asset-registry.ts';

/** The only skin file version this build reads. A file declaring another one is refused, not guessed at. */
export const SKIN_FILE_VERSION = 1;

/**
 * How many world units a cell of the exporting map occupies, and the number every skin length is
 * divided by. Declared here, in one literal, and read in exactly one function.
 *
 * It is a property of the exporter, not of this game: our own cell is one world unit by
 * `map-grid.ts`, and the file says its cell was two. So the constant is `2` and every length in the
 * file is in twice-the-size units — which is precisely why the division below exists. If a second
 * skin arrives from a different exporter this is the one number to revisit, and the seam publishes
 * it so a reader never has to open this file to find out what the picture was built from.
 */
export const SKIN_CELL_SIZE_UNITS = 2;

/**
 * The three kinds of cell, under the skin's own spelling. The mapping is one-to-one and total, so
 * there is nothing to guess: `blocked` is this project's `occupied` and nothing else is renamed.
 * A kind outside the list is refused by name, which is the point of the list being here.
 */
const SKIN_CELL_KINDS: Readonly<Record<string, CellKind>> = {
  free: 'free',
  road: 'road',
  blocked: 'occupied',
};

/** The cell kinds of this game, under the skin's spelling — the other end of the same correspondence. */
export const skinKindName = (kind: CellKind): string =>
  kind === 'occupied' ? 'blocked' : kind;

/** As the classes and not as messages, so a caller can react by cause without reading the text. */
export const SKIN_REFUSAL_CLASSES: readonly string[] = [
  'version',
  'cell-size',
  'map',
  'fingerprint',
  'ground',
  'relief',
  'light',
  'tiles',
  'scatter',
];

export class SkinFileError extends Error {
  public readonly reason: string;
  /** One of `SKIN_REFUSAL_CLASSES`. */
  public readonly refusal: string;

  public constructor(refusal: string, reason: string) {
    super(reason);
    this.name = 'SkinFileError';
    this.reason = reason;
    this.refusal = refusal;
  }
}

const refuse = (refusal: string, reason: string): never => {
  throw new SkinFileError(refusal, reason);
};

const describe = (value: unknown): string =>
  typeof value === 'string' ? JSON.stringify(value) : Array.isArray(value) ? `an array of ${value.length}` : String(value);

/** A `#rrggbb` colour as the file wrote it. Not parsed here: the renderer owns colour space. */
const readHex = (value: unknown, at: string): string => {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    return refuse('ground', `${at} must be a #rrggbb colour, found ${describe(value)}`);
  }
  return value;
};

/** The two ends of one palette. The file always gives a pair, and a single colour is a refusal. */
const readPalette = (value: unknown, at: string): readonly [string, string] => {
  if (!Array.isArray(value) || value.length !== 2) {
    return refuse('ground', `${at} must be a pair of colours, found ${describe(value)}`);
  }
  return [readHex(value[0], `${at}[0]`), readHex(value[1], `${at}[1]`)];
};

const readNumber = (value: unknown, at: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return refuse('scatter', `${at} must be a number, found ${describe(value)}`);
  }
  return value;
};

const readPositiveNumber = (value: unknown, at: string): number => {
  const number = readNumber(value, at);
  if (number <= 0) {
    return refuse('scatter', `${at} must be above zero, found ${number}`);
  }
  return number;
};

const readBoolean = (value: unknown, at: string): boolean => {
  if (typeof value !== 'boolean') {
    return refuse('scatter', `${at} must be true or false, found ${describe(value)}`);
  }
  return value;
};

const readKind = (value: unknown, at: string): CellKind => {
  const kind = typeof value === 'string' ? SKIN_CELL_KINDS[value] : undefined;
  if (kind === undefined) {
    return refuse(
      'scatter',
      `${at} is ${describe(value)}, and a cell kind is one of ${Object.keys(SKIN_CELL_KINDS).join(', ')}`,
    );
  }
  return kind;
};

// ---------------------------------------------------------------------------------------------
// The map fingerprint.
//
// FNV-1a on 32 bits, over the size and the rows. It answers one question — "was this skin written
// for this map" — and it is a fingerprint rather than a hash on purpose: it cannot be used to claim
// a file is intact, and nothing in this project treats it as if it could. Integrity is the sha256 in
// the file's own `tiles`, checked where the props are loaded.
//
// The algorithm is the published one, written out here rather than imported. It is a fixed
// specification rather than someone's helper, and the two have to agree on the bytes or the gate
// refuses a correct skin, which is the one failure a fingerprint must not have.
// ---------------------------------------------------------------------------------------------

/**
 * FNV-1a, 32 bit, over `<width>x<height>` and the rows joined by newlines. The size comes first so
 * that a 96x96 and a 96x96-shaped pair of different maps cannot produce the same string.
 */
export const mapFingerprint = (rows: readonly string[], width: number, height: number): string => {
  const text = `${width}x${height}\n${rows.join('\n')}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/**
 * The plate a skin has to match, in the form the fingerprint is defined over.
 *
 * The rows come from the map file itself rather than from the grid the match is fought on, and that
 * is the whole point of the check: a fingerprint computed from a re-serialised grid would be a
 * fingerprint of this project's reader rather than of the owner's drawing. The size and the rows are
 * therefore read side by side from one file, and the map module's own refusal of a grid whose rows
 * disagree with its declared size is what makes the two halves of this argument consistent.
 */
export type Plate = { width: number; height: number; rows: readonly string[] };

// ---------------------------------------------------------------------------------------------
// The definition, after the file has been believed.
// ---------------------------------------------------------------------------------------------

/** The sky the file describes, in its own units throughout — nothing here is a length. */
export type SkinSky = {
  top: string;
  bottom: string;
  sun: string;
  /** Where the sun is, as a direction. The renderer normalises it. */
  sunDir: readonly [number, number, number];
  fog: string;
  /**
   * The fog band as a fraction of the plate, `[near, far]`. Not distances: the exporter states
   * them against the size of the map, so a plate twice as wide in world units pushes both out
   * twice as far, and reading them as units would put the whole match inside the near band.
   */
  fogK: readonly [number, number];
  exposure: number;
  sunI: number;
  hemiSky: string;
  hemiGround: string;
  hemiI: number;
  fill: string;
  fillI: number;
  /** How wide the sun's halo is drawn in the sky. A width in the gradient, not a light. */
  glow: number;
};

export type SkinWater = {
  level: number;
  color: string;
  rough: number;
  clear: number;
  envI: number;
  wave: number;
};

export type SkinTile = {
  slot: number;
  kind: TerrainKind;
  /** How many cells the prop stands on. */
  footprint: 1 | 2;
  solid: boolean;
  file: string;
  contentHash: string;
};

export type SkinRule = {
  id: string;
  /** The exporter's name for the object it drew. For a reader; the game builds its own shape. */
  builder: string;
  cellType: CellKind;
  solid: boolean;
  layer: 'plants' | 'rocks' | 'props';
  scale: readonly [number, number];
  jitter: number;
  tilt: number;
  colors: Readonly<Record<string, readonly [string, string]>>;
  glow: Readonly<Record<string, readonly [string, number]>>;
  float: Readonly<Record<string, readonly [number, number]>>;
  /** Expected objects per `scatter.cell`-sided block, in block order: index `by * blocks + bx`. */
  count: readonly number[];
};

export type SkinDefinition = {
  version: number;
  name: string;
  /**
   * The exporter's world units in one of its cells, read from the file and checked against
   * `SKIN_CELL_SIZE_UNITS`. Published, never applied: the conversion already happened in `readSkin`.
   */
  cellSize: number;
  map: { width: number; height: number; fingerprint: string };
  ground: Record<CellKind, readonly [string, string]>;
  /**
   * The three relief numbers **in game world units**. `roadFlatten` is a fraction of a height and is
   * the one number here that no unit applies to; the other two were divided by `cellSize` in
   * `readSkin` and nowhere else.
   */
  relief: { blockedLift: number; roadSink: number; roadFlatten: number };
  /** The same three numbers as the file wrote them, so the division above can be checked by eye. */
  reliefAsWritten: { blockedLift: number; roadSink: number };
  light: { sky: SkinSky; water: SkinWater | null };
  tiles: readonly SkinTile[];
  scatter: { cell: number; blocksX: number; blocksY: number; rules: readonly SkinRule[] };
};

const readSky = (value: unknown): SkinSky => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('light', `light.sky must be an object, found ${describe(value)}`);
  }
  const sky = value as Record<string, unknown>;
  const sunDir = sky.sunDir;
  if (!Array.isArray(sunDir) || sunDir.length !== 3) {
    return refuse('light', `light.sky.sunDir must be three numbers, found ${describe(sunDir)}`);
  }
  const fogK = sky.fogK;
  if (!Array.isArray(fogK) || fogK.length !== 2) {
    return refuse('light', `light.sky.fogK must be a pair of fractions, found ${describe(fogK)}`);
  }
  return {
    top: readHex(sky.top, 'light.sky.top'),
    bottom: readHex(sky.bottom, 'light.sky.bottom'),
    sun: readHex(sky.sun, 'light.sky.sun'),
    sunDir: [readNumber(sunDir[0], 'light.sky.sunDir[0]'), readNumber(sunDir[1], 'light.sky.sunDir[1]'), readNumber(sunDir[2], 'light.sky.sunDir[2]')],
    fog: readHex(sky.fog, 'light.sky.fog'),
    fogK: [readNumber(fogK[0], 'light.sky.fogK[0]'), readNumber(fogK[1], 'light.sky.fogK[1]')],
    exposure: readNumber(sky.exposure, 'light.sky.exposure'),
    sunI: readNumber(sky.sunI, 'light.sky.sunI'),
    hemiSky: readHex(sky.hemiSky, 'light.sky.hemiSky'),
    hemiGround: readHex(sky.hemiGround, 'light.sky.hemiGround'),
    hemiI: readNumber(sky.hemiI, 'light.sky.hemiI'),
    fill: readHex(sky.fill, 'light.sky.fill'),
    fillI: readNumber(sky.fillI, 'light.sky.fillI'),
    glow: readNumber(sky.glow, 'light.sky.glow'),
  };
};

const readWater = (value: unknown): SkinWater | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || value === undefined || Array.isArray(value)) {
    return refuse('light', `light.water must be an object or null, found ${describe(value)}`);
  }
  const water = value as Record<string, unknown>;
  return {
    // The one water number with a unit in it, and it is converted the same way as every other.
    level: readNumber(water.level, 'light.water.level') / SKIN_CELL_SIZE_UNITS,
    color: readHex(water.color, 'light.water.color'),
    rough: readNumber(water.rough, 'light.water.rough'),
    clear: readNumber(water.clear, 'light.water.clear'),
    envI: readNumber(water.envI, 'light.water.envI'),
    wave: readNumber(water.wave, 'light.water.wave'),
  };
};

const readTiles = (value: unknown): readonly SkinTile[] => {
  if (!Array.isArray(value)) {
    return refuse('tiles', `tiles must be an array of the set's slots, found ${describe(value)}`);
  }
  // A set with no props cannot draw occupied cells, and a set with a gap in its slots would leave a
  // hole in the forest with nothing to say why. Both are refusals here rather than a picture that
  // quietly misses cells: the exporter already refuses to write such a set, and a reader that
  // accepted one would be the second place that decides.
  const tiles = value.map((entry, index) => {
    const at = `tiles[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return refuse('tiles', `${at} must be an object, found ${describe(entry)}`);
    }
    const tile = entry as Record<string, unknown>;
    const slot = tile.slot;
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 1 || slot > TERRAIN_SLOT_COUNT) {
      return refuse('tiles', `${at}.slot ${describe(slot)} must be a whole number in 1..${TERRAIN_SLOT_COUNT}`);
    }
    const kind = tile.kind;
    if (typeof kind !== 'string' || !(TERRAIN_KINDS as readonly string[]).includes(kind)) {
      return refuse('tiles', `${at}.kind ${describe(kind)} is not one of ${TERRAIN_KINDS.join(', ')}`);
    }
    const footprint = tile.footprint;
    if (footprint !== 1 && footprint !== 2) {
      return refuse('tiles', `${at}.footprint ${describe(footprint)} is neither 1 nor 2`);
    }
    const file = tile.file;
    if (typeof file !== 'string' || file.length === 0) {
      return refuse('tiles', `${at}.file must be a file name, found ${describe(file)}`);
    }
    if (file.includes('/') || file.includes('\\') || file.includes('..')) {
      return refuse('tiles', `${at}.file ${describe(file)} must name a file, not a path`);
    }
    const contentHash = tile.contentHash;
    if (typeof contentHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(contentHash)) {
      return refuse('tiles', `${at}.contentHash ${describe(contentHash)} must be a sha256 digest`);
    }
    return {
      slot,
      kind: kind as TerrainKind,
      footprint: footprint as 1 | 2,
      solid: readBoolean(tile.solid, `${at}.solid`),
      file,
      contentHash,
    };
  });
  if (tiles.length !== TERRAIN_SLOT_COUNT) {
    return refuse(
      'tiles',
      `tiles carries ${tiles.length} slots · a set that cannot fill the ${TERRAIN_SLOT_COUNT} the contract promises cannot draw occupied cells`,
    );
  }
  const slots = new Set(tiles.map((tile) => tile.slot));
  if (slots.size !== TERRAIN_SLOT_COUNT) {
    const missing = Array.from({ length: TERRAIN_SLOT_COUNT }, (_, index) => index + 1).filter((slot) => !slots.has(slot));
    return refuse('tiles', `tiles has no slot ${missing.join(', ')}`);
  }
  return tiles;
};

const readPartColors = (value: unknown, at: string): Record<string, readonly [string, string]> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('scatter', `${at} must be an object of part colours, found ${describe(value)}`);
  }
  const out: Record<string, readonly [string, string]> = {};
  for (const [part, pair] of Object.entries(value as Record<string, unknown>)) {
    out[part] = readPalette(pair, `${at}.${part}`);
  }
  return out;
};

const readGlow = (value: unknown, at: string): Record<string, readonly [string, number]> => {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('scatter', `${at} must be an object, found ${describe(value)}`);
  }
  const out: Record<string, readonly [string, number]> = {};
  for (const [part, pair] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      return refuse('scatter', `${at}.${part} must be a colour and a strength, found ${describe(pair)}`);
    }
    out[part] = [readHex(pair[0], `${at}.${part}[0]`), readNumber(pair[1], `${at}.${part}[1]`)];
  }
  return out;
};

const readFloat = (value: unknown, at: string): Record<string, readonly [number, number]> => {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('scatter', `${at} must be an object, found ${describe(value)}`);
  }
  const out: Record<string, readonly [number, number]> = {};
  for (const [part, pair] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      return refuse('scatter', `${at}.${part} must be two heights, found ${describe(pair)}`);
    }
    out[part] = [readNumber(pair[0], `${at}.${part}[0]`), readNumber(pair[1], `${at}.${part}[1]`)];
  }
  return out;
};

const readRules = (value: unknown, width: number, height: number, cell: number): SkinRule[] => {
  if (!Array.isArray(value)) {
    return refuse('scatter', `scatter.rules must be an array, found ${describe(value)}`);
  }
  const blocksX = Math.ceil(width / cell);
  const blocksY = Math.ceil(height / cell);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const at = `scatter.rules[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return refuse('scatter', `${at} must be an object, found ${describe(entry)}`);
    }
    const rule = entry as Record<string, unknown>;
    const id = rule.id;
    if (typeof id !== 'string' || id.length === 0) {
      return refuse('scatter', `${at}.id must be a non-empty string, found ${describe(id)}`);
    }
    if (seen.has(id)) {
      return refuse('scatter', `${at}.id ${describe(id)} is used twice in one file`);
    }
    seen.add(id);
    const layer = rule.layer;
    if (layer !== 'plants' && layer !== 'rocks' && layer !== 'props') {
      return refuse('scatter', `${at}.layer ${describe(layer)} is not one of plants, rocks, props`);
    }
    const scale = rule.scale;
    if (!Array.isArray(scale) || scale.length !== 2) {
      return refuse('scatter', `${at}.scale must be a pair, found ${describe(scale)}`);
    }
    const jitter = readNumber(rule.jitter, `${at}.jitter`);
    if (jitter < 0 || jitter > 1) {
      return refuse('scatter', `${at}.jitter ${jitter} is not between 0 and 1`);
    }
    if (rule.geometry !== null && rule.geometry !== undefined) {
      // The file reserves the field for exporting geometry and says it is a separate piece of work.
      // Reading a shape out of it would be reading a contract this build does not implement.
      return refuse('scatter', `${at}.geometry carries a shape, and this build draws the rule itself`);
    }
    const count = rule.count;
    if (!Array.isArray(count) || count.length !== blocksX * blocksY) {
      return refuse(
        'scatter',
        `${at}.count carries ${Array.isArray(count) ? count.length : describe(count)} numbers · a ${width} by ${height} plate in ${cell} cell blocks has ${blocksX * blocksY}`,
      );
    }
    return {
      id,
      builder: typeof rule.builder === 'string' ? rule.builder : '',
      cellType: readKind(rule.cellType, `${at}.cellType`),
      solid: readBoolean(rule.solid, `${at}.solid`),
      layer,
      scale: [readPositiveNumber(scale[0], `${at}.scale[0]`), readPositiveNumber(scale[1], `${at}.scale[1]`)],
      jitter,
      tilt: readNumber(rule.tilt, `${at}.tilt`),
      colors: readPartColors(rule.colors, `${at}.colors`),
      glow: readGlow(rule.glow, `${at}.glow`),
      float: readFloat(rule.float, `${at}.float`),
      count: count.map((value, position) => readNumber(value, `${at}.count[${position}]`)),
    };
  });
};

/**
 * Reads a skin file against the plate it is meant for, or refuses it.
 *
 * The plate is a parameter rather than something this module looks up, because the check that matters
 * is *this file against that map*: a skin written for another map has palettes and counts and forty
 * slots that all describe a different plate, and applying it here would produce a picture that is
 * wrong in every cell at once with nothing to say so. The fingerprint is the gate, and it is the only
 * reason a mismatch is visible before the first frame.
 */
export const readSkin = (raw: unknown, plate: Plate): SkinDefinition => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refuse('version', `skin file is ${Array.isArray(raw) ? 'an array' : describe(raw)}, not an object`);
  }
  const file = raw as Record<string, unknown>;
  const name = typeof file.name === 'string' && file.name.length > 0 ? file.name : 'unnamed set';

  if (file.version !== SKIN_FILE_VERSION) {
    return refuse('version', `skin ${name} declares version ${describe(file.version)} · this build reads version ${SKIN_FILE_VERSION}`);
  }

  // Declared, checked, and then it is only ever used as the divisor below. Nothing downstream of
  // this function holds a length in the exporter's units.
  const cellSize = file.cellSize;
  if (cellSize !== SKIN_CELL_SIZE_UNITS) {
    return refuse(
      'cell-size',
      `skin ${name} declares cellSize ${describe(cellSize)} · this build reads lengths in world units and one cell is ${SKIN_CELL_SIZE_UNITS} of them`,
    );
  }

  const map = file.map;
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    return refuse('map', `skin ${name} carries no map block, found ${describe(map)}`);
  }
  const mapBlock = map as Record<string, unknown>;
  if (mapBlock.width !== plate.width || mapBlock.height !== plate.height) {
    return refuse(
      'map',
      `skin ${name} was written for a ${describe(mapBlock.width)} by ${describe(mapBlock.height)} map · the match is fought on ${plate.width} by ${plate.height}`,
    );
  }
  const fingerprint = mapBlock.fingerprint;
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{8}$/.test(fingerprint)) {
    return refuse('map', `skin ${name} carries map.fingerprint ${describe(fingerprint)} · an eight digit fingerprint is what this build compares`);
  }
  const ours = mapFingerprint(plate.rows, plate.width, plate.height);
  if (fingerprint !== ours) {
    return refuse(
      'fingerprint',
      `skin ${name} was written for map ${describe(fingerprint)} · the plate in play reads ${ours}`,
    );
  }

  const ground = file.ground;
  if (typeof ground !== 'object' || ground === null || Array.isArray(ground)) {
    return refuse('ground', `skin ${name} carries no ground palettes, found ${describe(ground)}`);
  }
  const groundBlock = ground as Record<string, unknown>;
  const palettes = {
    free: readPalette(groundBlock.free, `ground.free`),
    road: readPalette(groundBlock.road, `ground.road`),
    occupied: readPalette(groundBlock.blocked, `ground.blocked`),
  };

  const relief = file.relief;
  if (typeof relief !== 'object' || relief === null || Array.isArray(relief)) {
    return refuse('relief', `skin ${name} carries no relief block, found ${describe(relief)}`);
  }
  const reliefBlock = relief as Record<string, unknown>;
  const blockedLiftAsWritten = readNumber(reliefBlock.blockedLift, 'relief.blockedLift');
  const roadSinkAsWritten = readNumber(reliefBlock.roadSink, 'relief.roadSink');

  const light = file.light;
  if (typeof light !== 'object' || light === null || Array.isArray(light)) {
    return refuse('light', `skin ${name} carries no light block, found ${describe(light)}`);
  }
  const lightBlock = light as Record<string, unknown>;

  const scatter = file.scatter;
  if (typeof scatter !== 'object' || scatter === null || Array.isArray(scatter)) {
    return refuse('scatter', `skin ${name} carries no scatter block, found ${describe(scatter)}`);
  }
  const scatterBlock = scatter as Record<string, unknown>;
  const scatterCell = scatterBlock.cell;
  if (typeof scatterCell !== 'number' || !Number.isInteger(scatterCell) || scatterCell <= 0) {
    return refuse('scatter', `scatter.cell ${describe(scatterCell)} must be a whole number of cells`);
  }

  const blocksX = Math.ceil(plate.width / scatterCell);
  const blocksY = Math.ceil(plate.height / scatterCell);

  return {
    version: file.version as number,
    name,
    cellSize,
    map: { width: plate.width, height: plate.height, fingerprint },
    ground: palettes,
    // ---- the one division in the project, and it is on these two lines -------------------------
    relief: {
      blockedLift: blockedLiftAsWritten / cellSize,
      roadSink: roadSinkAsWritten / cellSize,
      // A fraction of a height, not a length: dividing it would make a flatter road by a factor of
      // two for no reason at all, and the file states it as a share.
      roadFlatten: readNumber(reliefBlock.roadFlatten, 'relief.roadFlatten'),
    },
    reliefAsWritten: { blockedLift: blockedLiftAsWritten, roadSink: roadSinkAsWritten },
    light: { sky: readSky(lightBlock.sky), water: readWater(lightBlock.water) },
    tiles: readTiles(file.tiles),
    scatter: {
      cell: scatterCell,
      blocksX,
      blocksY,
      rules: readRules(scatterBlock.rules, plate.width, plate.height, scatterCell),
    },
  };
};

/**
 * The rules that draw open ground, and the rules that draw occupied ground, kept apart on purpose.
 *
 * A prop is a forty-slot model and a rule is a shape this build builds itself, so a cell that takes
 * one must not take the other: an occupied cell drawn as a rule is a cell the map says is blocked
 * and the picture says is walkable. The split is a value rather than a filter at the call site so
 * that the caller cannot ask for the wrong half by forgetting a condition.
 */
export const splitRules = (skin: SkinDefinition): { open: readonly SkinRule[]; occupied: readonly SkinRule[] } => ({
  open: skin.scatter.rules.filter((rule) => rule.cellType === 'free'),
  occupied: skin.scatter.rules.filter((rule) => rule.cellType === 'occupied'),
});

/** The tile of one slot, by the slot number the file gave it. The forty are read by number, not by order. */
export const tileBySlot = (skin: SkinDefinition, slot: number): SkinTile | null =>
  skin.tiles.find((tile) => tile.slot === slot) ?? null;