// Neon Rush's settings, on top of what the game center shares. The physics
// and the track generator live in sim.js; changing them, or `app`, is a new
// game version: old runs would no longer replay to their times.

import { CENTER, scopeOf } from '../../shared/config.js';

export const CONFIG = {
  get nodes() { return CENTER.nodes; },
  get explorerTx() { return CENTER.explorerTx; },
  movesChain: CENTER.movesChain,
  sessions: true, // moves are signed by the commander's session key (shared/sessions.js)
  scope: scopeOf('moto'), // each season is a topic below it
  app: 'neon-rush/v1',
  seasonMs: 15 * 60_000, // a new city circuit every 15 minutes, aligned to the epoch
  ghosts: 3, // the fastest runs race alongside you by default
  liveMs: 20_000, // a rider whose last split is older than this is no longer "live"
};
