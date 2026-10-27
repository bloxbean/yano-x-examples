// What every game in the center shares: the members, the moves chain, and
// the commander accounts. A game adds its own section on top (see GAMES).

export const CENTER = {
  // The members. Writes are signed by the member they are sent to; reads
  // fail over in order. serve.mjs can stand a local cluster in for these.
  nodes: [
    { label: 'Member 0', url: 'https://node0-showcase.yano-x.io' },
    { label: 'Member 1', url: 'https://node1-showcase.yano-x.io' },
    { label: 'Member 2', url: 'https://node2-showcase.yano-x.io' },
    { label: 'Member 3', url: 'https://node3-showcase.yano-x.io' },
    { label: 'Member 4', url: 'https://node4-showcase.yano-x.io' },
  ],
  explorerTx: 'https://preprod.cardanoscan.io/transaction/{tx}',
  // Game moves: the stock ordered-log machine. Each game uses its own topics.
  movesChain: 'orders-chain',
  // Sealed Duels' plugin edition: the example's own state machine (plugin/),
  // which runs the duel rules on the members. Not on the showcase until it is
  // installed there (README: "Adding duels-chain to the showcase").
  duelsChain: 'duels-chain',
};

// One commander, every game. Profiles live in the stock authenticated-map
// machine's owner-controlled `attachments` collection. The namespace keeps the
// name it was born with in Anchor Galaxy, so existing commanders keep working.
export const ACCOUNTS = {
  app: 'anchor-galaxy/v1',
  profilesChain: 'authenticated-map-chain',
  profilesCollection: 'attachments',
  kdfIterations: 600_000,
  minPasswordLength: 10,
};

export const GAMES = [
  {
    id: 'galaxy',
    title: 'Anchor Galaxy',
    tagline: 'Real-time space conquest',
    blurb: 'Drag fleets between planets. Every launch is a ledger move, final in about a second; '
      + 'every browser simulates the same battles.',
    players: 'up to 8 per round · 5-minute rounds',
    color: '#3ee6ff',
  },
  {
    id: 'arcade',
    title: 'Anchor Arcade',
    tagline: 'Replay-verified shooter',
    blurb: 'Sixty seconds of rocks on a field seeded by the ledger. You submit inputs, not a score — '
      + 'every browser replays your run, so the leaderboard cannot be faked.',
    players: 'solo · race the ghosts of the best runs',
    color: '#ff4fd8',
  },
  {
    id: 'land',
    title: 'Land Rush',
    tagline: 'Ledger-enforced territory',
    blurb: 'Found a capital and grow a realm, tile by tile. The members themselves refuse a second claim on a tile, '
      + 'and any tile — claimed or still free — can be proven against Cardano.',
    players: 'everyone at once · hourly seasons',
    color: '#7dff6a',
  },
  {
    id: 'duels',
    title: 'Sealed Duels',
    tagline: 'Hidden moves, fair dice',
    blurb: 'Rocket duels where both sides seal a move before either reveals it. Nobody — not even the members — '
      + 'can peek, nobody can change their mind, and the dice come from both players’ secrets.',
    players: '1 v 1 · best of 5 or 7',
    color: '#a78bff',
  },
  {
    id: 'derby',
    title: 'Comet Derby',
    tagline: 'A race nobody can fix',
    blurb: 'Bet credits on six comets. The race is seeded by a block certified after betting closes — a number nobody, '
      + 'not even the members, could know while bets were open — and every browser runs the same race and pays the same pool.',
    players: 'everyone at once · a race every 75 s',
    color: '#ffd84d',
  },
  {
    id: 'reef',
    title: 'Reef',
    tagline: 'A living world, rewindable',
    blurb: 'Drop gliders, spaceships and glider guns into a shared Game of Life that runs on certified block time. '
      + 'A few kilobytes of placements grow 16,000 cells identically everywhere — and you can travel back to any generation.',
    players: 'up to 6 species · 20-minute seasons',
    color: '#7dff6a',
  },
  {
    id: 'sonar',
    title: 'Deep Sonar',
    tagline: 'Hidden fleets, no referee',
    blurb: 'Battleship where your fleet is a Merkle root. Every hit or miss arrives with a 7-hash proof against it, '
      + 'so nobody can lie about a shot or move a ship — and the full boards are checked at the end.',
    players: '1 v 1 · 40 s turns',
    color: '#66ffb4',
  },
  {
    id: 'moto',
    title: 'Neon Rush',
    tagline: 'Night-city bike racing',
    blurb: 'Two laps through neon streets, weaving through traffic and riding slipstreams. The circuit comes from a block, '
      + 'every browser replays your inputs to time you, and rivals appear on your road live from their signed checkpoint splits.',
    players: 'time trial · ghosts and live riders · 15-minute seasons',
    color: '#ff3fd0',
  },
  {
    id: 'duels-plugin',
    href: 'duels/?engine=plugin',
    preview: 'duels',
    title: 'Sealed Duels · plugin edition',
    tagline: 'The same duel, rules on the ledger',
    blurb: 'Identical game, but the members run the rules in a Java state machine on duels-chain: a bad move is '
      + 'refused before it is stored, and each duel’s result sits in the state root — one proof, no replay.',
    players: '1 v 1 · needs duels-chain (local cluster)',
    color: '#ffcc4d',
  },
];

/** Under serve.mjs (?proxy), use its same-origin routes — and a local cluster if it stands one in. */
export async function applyProxy() {
  const proxy = new URLSearchParams(location.search).has('proxy');
  if (!proxy) return false;
  try {
    const info = await (await fetch('/proxy/nodes')).json();
    if (info.custom) {
      CENTER.nodes = info.nodes.map((url, i) => ({ label: `Member ${i} · ${new URL(url).host}`, url }));
      CENTER.explorerTx = null; // a local devnet has no public explorer
    }
  } catch { /* a plain static server: keep the showcase members */ }
  return true;
}

/** Keep ?proxy on links between pages. */
export function withQuery(href) {
  if (!new URLSearchParams(location.search).has('proxy')) return href;
  return `${href}${href.includes('?') ? '&' : '?'}proxy`;
}
