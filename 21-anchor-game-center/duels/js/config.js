// Sealed Duels' settings, on top of what the game center shares. The duel
// rules here are part of the deterministic fold in duels.js; changing them,
// or `app`, is a new game version.

import { CENTER, scopeOf } from '../../shared/config.js';

// Two editions of the same game (README: "Sealed Duels · plugin edition"):
//   browser  moves on games-chain under games/duels/, signed by the player's
//            session key; every browser runs the rules (duels.js)
//   plugin   moves on duels-chain, each carrying the commander's signature; the
//            members run the same rules in Java (plugin/) and the browser checks
//            their result: ?engine=plugin
const PLUGIN = typeof location !== 'undefined' && new URLSearchParams(location.search).get('engine') === 'plugin';

const GAME = {
  app: 'anchor-duels/v1',
  lobbyMs: 60 * 60_000, // one lobby topic per hour; the page reads this hour and the last
  challengeMs: 10 * 60_000, // an open challenge expires after ten minutes
  roundOptions: [5, 7],
  hp: 12,
  energy: { start: 2, max: 6 },
  sealMs: 30_000, // each player must seal within 30 s of a round starting
  revealMs: 15_000, // and reveal within 15 s of both seals being final
  forfeitDamage: 4, // missing a seal or reveal costs this much
  moves: [
    { id: 'laser', name: 'Laser', icon: '⚡', cost: 0, color: '#3ee6ff', fx: '2 damage. Free.' },
    { id: 'missile', name: 'Missile', icon: '🚀', cost: 2, color: '#ff6b6b', fx: '4 damage. An EMP knocks it out; a shield takes 1.' },
    { id: 'shield', name: 'Shield', icon: '⬡', cost: 1, color: '#7dff6a', fx: 'Blocks lasers and missiles. Weak to EMP.' },
    { id: 'emp', name: 'EMP', icon: '◎', cost: 1, color: '#a78bff', fx: 'Kills missiles, breaks shields for 3. Otherwise 1.' },
    { id: 'recharge', name: 'Recharge', icon: '✚', cost: -2, color: '#ffcc4d', fx: '+2 energy. You are open.' },
  ],
};

/** One edition's settings. The plugin's topic names are fixed by plugin/ (Duels.java). */
export function edition(plugin) {
  return {
    ...GAME,
    get nodes() { return CENTER.nodes; },
    get explorerTx() { return CENTER.explorerTx; },
    engine: plugin ? 'plugin' : 'browser',
    movesChain: plugin ? CENTER.duelsChain : CENTER.movesChain,
    sessions: !plugin,
    scope: plugin ? null : scopeOf('duels'),
    topicBase: plugin ? 'anchor-duels.v1.' : scopeOf('duels'),
    // Who owns a call sign. The browser checks the commander profile on the
    // profile chain; a state machine sees only its own chain, so the plugin
    // edition binds a call sign to the first key that uses it there.
    keyBinding: plugin ? 'first-seen' : 'profile-chain',
  };
}

export const CONFIG = edition(PLUGIN);
export const PLUGIN_CONFIG = edition(true);
