// Reef's settings, on top of what the game center shares. The world rules in
// reef.js depend on these; changing them, or `app`, is a new game version.

import { CENTER } from '../../shared/config.js';

export const CONFIG = {
  get nodes() { return CENTER.nodes; },
  get explorerTx() { return CENTER.explorerTx; },
  movesChain: CENTER.movesChain,
  app: 'ledger-reef/v1',

  seasonMs: 20 * 60_000, // a new reef every 20 minutes, aligned to the epoch
  genMs: 200, // five generations a second, on certified block time
  width: 160,
  height: 100,
  maxPlayers: 6,
  spores: { start: 6, max: 10, regenMs: 3000 },
  species: [
    null,
    { name: 'Cyan', color: [62, 230, 255] },
    { name: 'Rose', color: [255, 79, 216] },
    { name: 'Amber', color: [255, 176, 32] },
    { name: 'Lime', color: [125, 255, 106] },
    { name: 'Violet', color: [167, 139, 255] },
    { name: 'Coral', color: [255, 110, 90] },
    { name: 'Wild', color: [58, 72, 98] },
  ],
};
