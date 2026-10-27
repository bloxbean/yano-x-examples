// Comet Derby's settings, on top of what the game center shares. The race and
// payout rules in derby.js depend on these; changing them, or `app`, is a new
// game version.

import { CENTER } from '../../shared/config.js';

export const CONFIG = {
  get nodes() { return CENTER.nodes; },
  get explorerTx() { return CENTER.explorerTx; },
  movesChain: CENTER.movesChain,
  app: 'comet-derby/v1',

  hourMs: 60 * 60_000, // one topic and one set of balances per hour
  raceMs: 75_000, // a race every 75 s (48 an hour), aligned to the epoch
  betMs: 45_000, // betting is open for the first 45 s of each race slot
  grant: 1000, // credits each commander starts every hour with
  minStake: 10,
  maxStake: 500,
  comets: [
    { name: 'Vega', color: '#3ee6ff' },
    { name: 'Nova', color: '#ff4fd8' },
    { name: 'Ember', color: '#ff8a3d' },
    { name: 'Halley', color: '#7dff6a' },
    { name: 'Lyra', color: '#a78bff' },
    { name: 'Sol', color: '#ffd84d' },
  ],
};
