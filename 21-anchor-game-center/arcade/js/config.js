// Anchor Arcade's settings, on top of what the game center shares.
//
// The simulation's constants live in sim.js; changing them, or `app`, is a new
// game version: old runs would no longer replay to their scores.

import { CENTER } from '../../shared/config.js';

export const CONFIG = {
  get nodes() { return CENTER.nodes; },
  get explorerTx() { return CENTER.explorerTx; },
  movesChain: CENTER.movesChain,
  app: 'anchor-arcade/v1',
  fieldMs: 15 * 60_000, // a new field of rocks every 15 minutes, aligned to the epoch
  ghosts: 3, // the top runs race alongside you by default
};
