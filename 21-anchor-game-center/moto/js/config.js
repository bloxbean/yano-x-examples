// Neon Rush's settings, on top of what the game center shares. The physics
// and the track generator live in sim.js; changing them, or `app`, is a new
// game version: old runs would no longer replay to their times.

import { CENTER } from '../../shared/config.js';

export const CONFIG = {
  get nodes() { return CENTER.nodes; },
  get explorerTx() { return CENTER.explorerTx; },
  movesChain: 'neon-rush-chain',
  generationId: null, // public topic-config.json pins the fresh chain generation
  app: 'neon-rush/v1',
  seasonMs: 15 * 60_000, // a new city circuit every 15 minutes, aligned to the epoch
  ghosts: 3, // the fastest runs race alongside you by default
  liveMs: 20_000, // a rider whose last split is older than this is no longer "live"
};
