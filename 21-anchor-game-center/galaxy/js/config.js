// Anchor Galaxy's settings, on top of what the game center shares.
//
// The game section is part of the deterministic simulation in galaxy.js:
// every browser replays the same finalized moves with the same constants and
// sees the same galaxy. Changing any of it is a new game version — change
// `app` too, which changes every round's topic and map.

import { CENTER } from '../../shared/config.js';

export const CONFIG = {
  get nodes() { return CENTER.nodes; },
  get explorerTx() { return CENTER.explorerTx; },
  movesChain: CENTER.movesChain,
  app: 'anchor-galaxy/v1',

  game: {
    roundMs: 5 * 60_000, // rounds are back to back, aligned to the epoch
    width: 1000,
    height: 620,
    planets: 22,
    homes: 8, // at most eight commanders per round
    homeShips: 40,
    fleetSpeed: 110, // world units per second
    maxLaunchesPerBlock: 6,
    ratios: [25, 50, 75, 100],
  },
};
