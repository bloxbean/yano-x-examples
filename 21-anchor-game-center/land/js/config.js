// Land Rush's settings, on top of what the game center shares.
//
// Claims live in the same authenticated-map collection as commander profiles
// (ACCOUNTS.profilesCollection), under this game's own key prefix. Changing
// any rule here, or `app`, is a new game version.

import { ACCOUNTS, CENTER } from '../../shared/config.js';

export const CONFIG = {
  get nodes() { return CENTER.nodes; },
  get explorerTx() { return CENTER.explorerTx; },
  app: 'anchor-land/v1',
  chain: ACCOUNTS.profilesChain,
  collection: ACCOUNTS.profilesCollection,

  seasonMs: 60 * 60_000, // one season an hour, aligned to the epoch
  cols: 30,
  rows: 18,
  terrain: [
    { name: 'Plains', value: 1, color: '#3d6b45' },
    { name: 'Forest', value: 2, color: '#2a5135' },
    { name: 'Peaks', value: 3, color: '#6d6a7d' },
    { name: 'Crystal', value: 5, color: '#2f7f9a' },
  ],
  realmBonus: 2, // score = land value + realmBonus × your largest connected realm
  stamina: { start: 4, max: 8, regenMs: 4000 },
};
