// Everything cluster- and game-specific lives here.
//
// The game rules (size, palette, cooldowns) are part of the deterministic fold
// in game.js: every player replays the same finalized log with the same rules
// and sees the same wall. Changing a rule is a new season — change TOPIC too,
// or old messages would be re-judged under new rules.

export const CONFIG = {
  // An existing ordered-log app ledger on the showcase cluster. ordered-log
  // accepts any topic and never inspects bodies; the game rules live in the
  // client fold, and the ledger supplies the one agreed order and finality.
  chainId: 'orders-chain',
  topic: 'anchor-canvas.s1',
  app: 'anchor-canvas/v1',

  // The five members of the Yano X preprod showcase cluster. Writes are signed
  // by the member they are sent to; reads fail over in order.
  nodes: [
    { label: 'Member 0', url: 'https://node0-showcase.yano-x.io' },
    { label: 'Member 1', url: 'https://node1-showcase.yano-x.io' },
    { label: 'Member 2', url: 'https://node2-showcase.yano-x.io' },
    { label: 'Member 3', url: 'https://node3-showcase.yano-x.io' },
    { label: 'Member 4', url: 'https://node4-showcase.yano-x.io' },
  ],
  explorerTx: 'https://preprod.cardanoscan.io/transaction/{tx}',
  // The showcase anchors every 30 blocks, or at least hourly when there is
  // anything new (deployment lock: anchoring.everyBlocks / maxIntervalMinutes).
  anchorEveryBlocks: 30,

  size: 32,
  palette: [
    '#0b0e14', '#f4f1e8', '#7a828e', '#ff4d6d',
    '#ff9f1c', '#ffd60a', '#80ed99', '#2ec4b6',
    '#4cc9f0', '#4361ee', '#7b2cbf', '#f72585',
    '#8d5524', '#c68642', '#3a5a40', '#ade8f4',
  ],
  // Minimum gap, by finalized block timestamp, between two accepted pixels
  // from the same player. A verified Cardano wallet paints faster than a guest.
  cooldownMs: { wallet: 3000, guest: 8000 },
  // The longest session a wallet may authorize, measured from the block that
  // finalizes the join.
  maxSessionMs: 24 * 60 * 60 * 1000,
  maxNameLength: 16,
};
