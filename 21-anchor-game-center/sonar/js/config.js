// Deep Sonar's settings, on top of what the game center shares. The rules in
// sonar.js depend on these; changing them, or `app`, is a new game version.

import { CENTER } from '../../shared/config.js';

export const CONFIG = {
  get nodes() { return CENTER.nodes; },
  get explorerTx() { return CENTER.explorerTx; },
  movesChain: CENTER.movesChain,
  app: 'deep-sonar/v1',

  lobbyMs: 60 * 60_000, // one lobby topic per hour; the page reads this hour and the last
  challengeMs: 10 * 60_000, // an open challenge expires after ten minutes
  size: 10, // a 10 × 10 sea
  fleet: [5, 4, 3, 3, 2], // ship lengths; ship ids 1..5
  shipNames: ['Carrier', 'Cruiser', 'Destroyer', 'Frigate', 'Corvette'],
  shotMs: 40_000, // the player on turn must fire within 40 s of block time
  answerMs: 20_000, // and the target must answer within 20 s (the page answers by itself)
  revealMs: 60_000, // at the end, both reveal their whole board within 60 s
};
