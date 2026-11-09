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
  // Race lobbies (races.js): riders gather on the season's circuit and start together.
  // Every time here is ledger time: the timestamps of the finalized blocks.
  race: {
    waits: [15_000, 30_000, 60_000, 120_000], // how long a lobby stays open, the host's choice
    alone: ['wait', 'ride', 'cancel'], // if nobody joined by then: wait once more, ride solo, or cancel
    maxRiders: 8, // a lobby's grid, host included (the host picks 2..8)
    maxOpen: 8, // lobbies not yet finished, per season
    leadMs: 5_000, // lobby closes → start: time for every browser to see the final grid
    earlyMs: 3_000, // a race ride may be finalized this much before start + its own time (clock skew)
    graceMs: 20_000, // … and up to this much after: a later ride missed the start
  },
};
