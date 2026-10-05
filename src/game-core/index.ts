export {
  createTrainingScenario,
  trainingCoreCell,
  trainingGrid,
  trainingPlan,
  trainingSpawns,
} from './scenario.ts';
export type { TrainingPlan, TrainingRouteReading } from './scenario.ts';
export {
  MAP_FILE_REFUSAL_CLASSES,
  TOWER_FOOTPRINT_CELLS,
  cellBounds,
  cellCenter,
  cellForSpotId,
  checkSpot,
  findRouteCells,
  findSpots,
  readMapGrid,
  routePolyline,
  spotCells,
  spotCenter,
  spotIdForCell,
  MapFileError,
} from './map-grid.ts';
export type { CellKind, MapCell, MapGrid, RouteWalk, SpotCheck, SpotRefusal } from './map-grid.ts';

export { Simulation, TICK_RATE, TICK_SECONDS, createSimulation } from './simulation.ts';
export type * from './types.ts';
