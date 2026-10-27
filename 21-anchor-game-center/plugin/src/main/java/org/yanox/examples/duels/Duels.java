package org.yanox.examples.duels;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The Sealed Duels rules — the same rules as the game center's
 * duels/js/duels.js, run by the members instead of only by the browsers.
 *
 * <p>Messages are byte-for-byte the ones the browser edition sends: a lobby
 * topic per hour carries challenges and accepts, and each duel has its own
 * topic carrying seals, reveals and deadline claims. The difference is where
 * the rules run. Here every member applies them in {@code apply} and commits
 * each duel's record (HP, energy, round, phase, history, winner) to the state
 * root under {@code duel/<id>}, so a result is one state proof away; and
 * {@link #admit} refuses a broken move before it is ever stored.
 *
 * <p>Deterministic by construction: certified block time only, no clock, no
 * randomness, integer arithmetic, insertion-ordered records.
 */
public final class Duels {
    public static final String APP = "anchor-duels/v1";
    static final long CHALLENGE_MS = 10 * 60_000;
    static final long SEAL_MS = 30_000;
    static final long REVEAL_MS = 15_000;
    static final long HP = 12;
    static final long ENERGY_START = 2;
    static final long ENERGY_MAX = 6;
    static final long FORFEIT_DAMAGE = 4;
    static final List<Long> ROUND_OPTIONS = List.of(5L, 7L);
    static final Map<String, Long> MOVE_COST = Map.of(
            "laser", 0L, "missile", 2L, "shield", 1L, "emp", 1L, "recharge", -2L);

    private static final Pattern LOBBY_TOPIC = Pattern.compile("anchor-duels\\.v1\\.lobby\\.h\\d{1,12}");
    private static final Pattern DUEL_TOPIC = Pattern.compile("anchor-duels\\.v1\\.d([0-9a-f]{16})");
    private static final Pattern CALLSIGN = Pattern.compile("[a-z0-9][a-z0-9_-]{2,19}");
    private static final Pattern HEX32 = Pattern.compile("[0-9a-f]{32}");
    private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern HEX128 = Pattern.compile("[0-9a-f]{128}");
    private static final int MAX_BODY_BYTES = 2048;
    private static final byte[] ED25519_X509 = HexFormat.of().parseHex("302a300506032b6570032100");

    /** Committed key–value state, as strings. */
    public interface Store {
        Optional<String> get(String key);

        void put(String key, String value);
    }

    /** Outcome of a message. {@code code} is the public rejection code (uppercase), or null if accepted. */
    public record Outcome(String code, String reason) {
        static final Outcome OK = new Outcome(null, null);

        public boolean accepted() {
            return code == null;
        }
    }

    private final String chainId;

    public Duels(String chainId) {
        this.chainId = chainId;
    }

    /** The topic each message belongs on, as the browsers build it. */
    public static boolean isGameTopic(String topic) {
        return topic != null && (LOBBY_TOPIC.matcher(topic).matches() || DUEL_TOPIC.matcher(topic).matches());
    }

    // ------------------------------------------------------------ admission

    /**
     * Check a message against committed state before it is pooled. Advisory —
     * {@code apply} re-checks everything — but it keeps the obvious cheats
     * off the ledger: a forged signature, a stranger in a duel, or a reveal
     * that does not match its seal is refused with HTTP 400.
     */
    public Outcome admit(Store state, String topic, byte[] body) {
        Map<String, Object> b = parse(body);
        if (b == null) {
            return reject("MALFORMED", "not a JSON object");
        }
        if (topic != null && LOBBY_TOPIC.matcher(topic).matches()) {
            return checkLobby(state, b, Long.MIN_VALUE, false);
        }
        Matcher m = topic == null ? null : DUEL_TOPIC.matcher(topic);
        if (m == null || !m.matches()) {
            return reject("WRONG_TOPIC", "not a Sealed Duels topic");
        }
        Optional<Map<String, Object>> duel = loadDuel(state, m.group(1));
        if (duel.isEmpty()) {
            return reject("NO_SUCH_DUEL", "no accepted duel on this topic");
        }
        return checkDuelMessage(duel.get(), b, false);
    }

    // ------------------------------------------------------------ apply

    /** Apply one finalized message. Never throws for bad input: a refused message changes nothing. */
    public Outcome apply(Store state, String topic, byte[] body, long timestamp, long height, int index, String messageId) {
        Map<String, Object> b = parse(body);
        if (topic != null && LOBBY_TOPIC.matcher(topic).matches()) {
            if (b == null) {
                return reject("MALFORMED", "not a JSON object");
            }
            Outcome check = checkLobby(state, b, timestamp, true);
            if (!check.accepted()) {
                return check;
            }
            commitLobby(state, b, timestamp, height, index, messageId);
            return Outcome.OK;
        }
        Matcher m = topic == null ? null : DUEL_TOPIC.matcher(topic);
        if (m == null || !m.matches()) {
            return reject("WRONG_TOPIC", "not a Sealed Duels topic");
        }
        Optional<Map<String, Object>> loaded = loadDuel(state, m.group(1));
        if (loaded.isEmpty()) {
            return reject("NO_SUCH_DUEL", "no accepted duel on this topic");
        }
        Map<String, Object> duel = loaded.get();
        expire(duel, timestamp);
        Outcome result = b == null ? reject("MALFORMED", "not a JSON object") : checkDuelMessage(duel, b, true);
        if (result.accepted()) {
            applyDuelMessage(duel, b, timestamp, height, index, messageId);
        }
        state.put("duel/" + duel.get("duel"), Json.write(duel));
        return result;
    }

    // ------------------------------------------------------------ lobby

    private Outcome checkLobby(Store state, Map<String, Object> b, long timestamp, boolean final_) {
        String t = str(b, "t");
        if (!"challenge".equals(t) && !"accept".equals(t)) {
            return reject("NOT_A_MOVE", "not a lobby message");
        }
        String id = str(b, "id");
        String pub = str(b, "pub");
        Long n = num(b, "n");
        String sig = str(b, "sig");
        if (id == null || !CALLSIGN.matcher(id).matches() || pub == null || !HEX64.matcher(pub).matches()
                || n == null || n < 1 || sig == null || !HEX128.matcher(sig).matches()) {
            return reject("MALFORMED", "malformed");
        }
        Object field = "challenge".equals(t) ? b.get("rounds") : b.get("challenge");
        if (!verify(pub, sig, statement("lobby", t, id, n, field))) {
            return reject("BAD_SIGNATURE", "signature does not verify");
        }
        long last = state.get("nonce/" + id).map(Long::parseLong).orElse(0L);
        if (n <= last) {
            return reject("STALE_NONCE", "stale nonce (replayed)");
        }
        // The rules see only this chain's state, not the commander profiles on
        // authenticated-map-chain: the first key to use a call sign here owns it.
        if (!state.get("key/" + id).orElse(pub).equals(pub)) {
            return reject("WRONG_KEY", "that call sign belongs to another key on this chain");
        }
        if ("challenge".equals(t)) {
            if (!(field instanceof Long rounds) || !ROUND_OPTIONS.contains(rounds)) {
                return reject("BAD_LENGTH", "unsupported duel length");
            }
            return Outcome.OK;
        }
        if (!(field instanceof String challengeId) || !HEX64.matcher(challengeId).matches()) {
            return reject("NO_SUCH_CHALLENGE", "no such challenge");
        }
        Optional<Map<String, Object>> challenge = state.get("duel/" + challengeId).map(Duels::object);
        if (challenge.isEmpty()) {
            return reject("NO_SUCH_CHALLENGE", "no such challenge");
        }
        Map<String, Object> c = challenge.get();
        if (c.get("opponent") != null) {
            return reject("ALREADY_ACCEPTED", "already accepted");
        }
        long challengedAt = (Long) ((Map<?, ?>) c.get("challenger")).get("ts");
        if (final_ && timestamp > challengedAt + CHALLENGE_MS) {
            return reject("CHALLENGE_EXPIRED", "the challenge expired");
        }
        if (id.equals(((Map<?, ?>) c.get("challenger")).get("id"))) {
            return reject("OWN_CHALLENGE", "you cannot accept your own challenge");
        }
        return Outcome.OK;
    }

    private void commitLobby(Store state, Map<String, Object> b, long timestamp, long height, int index, String messageId) {
        String id = str(b, "id");
        state.put("nonce/" + id, Long.toString(num(b, "n")));
        if (state.get("key/" + id).isEmpty()) {
            state.put("key/" + id, str(b, "pub"));
        }
        Map<String, Object> who = new LinkedHashMap<>();
        who.put("id", id);
        who.put("pub", str(b, "pub"));
        who.put("ts", timestamp);
        who.put("height", height);
        if ("challenge".equals(str(b, "t"))) {
            Map<String, Object> duel = new LinkedHashMap<>();
            duel.put("v", 1L);
            duel.put("duel", messageId);
            duel.put("rounds", num(b, "rounds"));
            duel.put("challenger", who);
            duel.put("opponent", null);
            duel.put("status", "open");
            state.put("duel/" + messageId, Json.write(duel));
            return;
        }
        String duelId = str(b, "challenge");
        Map<String, Object> duel = object(state.get("duel/" + duelId).orElseThrow());
        duel.put("opponent", who);
        duel.put("status", "active");
        duel.put("round", 1L);
        duel.put("phase", "seal");
        duel.put("roundStart", timestamp);
        duel.put("revealDeadline", null);
        duel.put("hp", new ArrayList<>(List.of(HP, HP)));
        duel.put("energy", new ArrayList<>(List.of(ENERGY_START, ENERGY_START)));
        duel.put("seals", nulls());
        duel.put("reveals", nulls());
        duel.put("history", new ArrayList<>());
        duel.put("winner", null);
        state.put("duel/" + duelId, Json.write(duel));
        String prefix = duelId.substring(0, 16);
        if (state.get("topic/" + prefix).isEmpty()) {
            state.put("topic/" + prefix, duelId);
        }
    }

    private static Optional<Map<String, Object>> loadDuel(Store state, String topicPrefix) {
        return state.get("topic/" + topicPrefix)
                .flatMap(id -> state.get("duel/" + id))
                .map(Duels::object)
                .filter(d -> "active".equals(d.get("status")) || "done".equals(d.get("status")));
    }

    // ------------------------------------------------------------ rounds

    private Outcome checkDuelMessage(Map<String, Object> duel, Map<String, Object> b, boolean final_) {
        String id = str(b, "id");
        String sig = str(b, "sig");
        if (id == null || sig == null || !HEX128.matcher(sig).matches()) {
            return reject("MALFORMED", "malformed");
        }
        int seat = seat(duel, id);
        if (seat < 0) {
            return reject("NOT_IN_DUEL", "not in this duel");
        }
        if ("done".equals(duel.get("phase"))) {
            return reject("DUEL_OVER", "the duel is over");
        }
        String pub = (String) player(duel, seat).get("pub");
        String duelId = (String) duel.get("duel");
        String t = str(b, "t");
        Object round = b.get("round");
        if ("forfeit".equals(t)) {
            return verify(pub, sig, statementIn(duelId, "forfeit", id, round))
                    ? Outcome.OK : reject("BAD_SIGNATURE", "signature does not verify");
        }
        if (!(round instanceof Long r) || r != (Long) duel.get("round")) {
            return reject("WRONG_ROUND", "not round " + round);
        }
        String phase = (String) duel.get("phase");
        if ("seal".equals(t)) {
            if (!"seal".equals(phase)) {
                return reject("SEALING_CLOSED", "sealing is closed");
            }
            if (list(duel, "seals").get(seat) != null) {
                return reject("ALREADY_SEALED", "already sealed");
            }
            String hash = str(b, "hash");
            if (hash == null || !HEX64.matcher(hash).matches()) {
                return reject("MALFORMED", "malformed seal");
            }
            return verify(pub, sig, statementIn(duelId, "seal", id, round, hash))
                    ? Outcome.OK : reject("BAD_SIGNATURE", "signature does not verify");
        }
        if ("reveal".equals(t)) {
            if (!"reveal".equals(phase)) {
                return reject("NOTHING_TO_REVEAL", "nothing to reveal yet");
            }
            if (list(duel, "reveals").get(seat) != null) {
                return reject("ALREADY_REVEALED", "already revealed");
            }
            String move = str(b, "move");
            String secret = str(b, "secret");
            if (move == null || !MOVE_COST.containsKey(move) || secret == null || !HEX32.matcher(secret).matches()) {
                return reject("MALFORMED", "malformed reveal");
            }
            if (!verify(pub, sig, statementIn(duelId, "reveal", id, round, move, secret))) {
                return reject("BAD_SIGNATURE", "signature does not verify");
            }
            String sealed = (String) ((Map<?, ?>) list(duel, "seals").get(seat)).get("hash");
            if (!sealHash(duelId, (Long) round, id, move, secret).equals(sealed)) {
                return reject("REVEAL_MISMATCH", "the reveal does not match the seal");
            }
            return Outcome.OK;
        }
        return reject("NOT_A_MOVE", "not a duel message");
    }

    private void applyDuelMessage(Map<String, Object> duel, Map<String, Object> b, long ts, long height, int index, String messageId) {
        String t = str(b, "t");
        int seat = seat(duel, str(b, "id"));
        if ("seal".equals(t)) {
            Map<String, Object> seal = new LinkedHashMap<>();
            seal.put("hash", str(b, "hash"));
            seal.put("ts", ts);
            seal.put("height", height);
            seal.put("index", (long) index);
            seal.put("messageId", messageId);
            list(duel, "seals").set(seat, seal);
            if (list(duel, "seals").get(1 - seat) != null) {
                duel.put("phase", "reveal");
                duel.put("revealDeadline", ts + REVEAL_MS);
            }
        } else if ("reveal".equals(t)) {
            String move = str(b, "move");
            long energy = (Long) list(duel, "energy").get(seat);
            Map<String, Object> reveal = new LinkedHashMap<>();
            reveal.put("move", move);
            reveal.put("secret", str(b, "secret"));
            reveal.put("legal", MOVE_COST.get(move) <= energy);
            reveal.put("ts", ts);
            reveal.put("height", height);
            reveal.put("index", (long) index);
            reveal.put("messageId", messageId);
            list(duel, "reveals").set(seat, reveal);
            if (list(duel, "reveals").get(1 - seat) != null) {
                resolve(duel, ts);
            }
        }
    }

    /** Settle every deadline that passed before {@code ts}. */
    private void expire(Map<String, Object> duel, long ts) {
        while (!"done".equals(duel.get("phase"))) {
            String phase = (String) duel.get("phase");
            if ("seal".equals(phase) && ts > (Long) duel.get("roundStart") + SEAL_MS) {
                resolve(duel, (Long) duel.get("roundStart") + SEAL_MS);
            } else if ("reveal".equals(phase) && ts > (Long) duel.get("revealDeadline")) {
                resolve(duel, (Long) duel.get("revealDeadline"));
            } else {
                break;
            }
        }
    }

    /**
     * Settle the round at {@code at}. If sealing timed out, whoever did not
     * seal forfeits; otherwise whoever did not reveal an affordable move does.
     */
    private void resolve(Map<String, Object> duel, long at) {
        List<Object> seals = list(duel, "seals");
        List<Object> reveals = list(duel, "reveals");
        List<Object> energy = list(duel, "energy");
        List<Object> hp = list(duel, "hp");
        boolean sealingTimedOut = "seal".equals(duel.get("phase"));
        String[] moves = new String[2];
        boolean[] forfeited = new boolean[2];
        for (int i = 0; i < 2; i++) {
            Map<?, ?> r = (Map<?, ?>) reveals.get(i);
            moves[i] = r != null && Boolean.TRUE.equals(r.get("legal")) ? (String) r.get("move") : null;
            forfeited[i] = sealingTimedOut ? seals.get(i) == null : moves[i] == null;
        }
        for (int i = 0; i < 2; i++) {
            if (moves[i] != null) {
                energy.set(i, Math.min(ENERGY_MAX, (Long) energy.get(i) - MOVE_COST.get(moves[i])));
            }
        }
        Long die = moves[0] != null && moves[1] != null
                ? rollDie((String) duel.get("duel"), (Long) duel.get("round"),
                        (String) ((Map<?, ?>) reveals.get(0)).get("secret"), (String) ((Map<?, ?>) reveals.get(1)).get("secret"))
                : null;
        long crit = die != null && die == 6 ? 3 : 2;
        long[] dealt = new long[2];
        for (int i = 0; i < 2; i++) {
            if (forfeited[1 - i]) {
                dealt[i] = FORFEIT_DAMAGE;
            } else if (moves[i] != null) {
                dealt[i] = Math.floorDiv(damage(moves[i], moves[1 - i]) * crit, 2);
            }
        }
        for (int i = 0; i < 2; i++) {
            hp.set(1 - i, Math.max(0, (Long) hp.get(1 - i) - dealt[i]));
        }
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("round", duel.get("round"));
        record.put("moves", Arrays.asList(moves[0], moves[1]));
        record.put("forfeited", List.of(forfeited[0], forfeited[1]));
        record.put("die", die);
        record.put("dealt", List.of(dealt[0], dealt[1]));
        record.put("at", at);
        record.put("hp", List.of(hp.get(0), hp.get(1)));
        record.put("energy", List.of(energy.get(0), energy.get(1)));
        record.put("seals", new ArrayList<>(seals));
        record.put("reveals", new ArrayList<>(reveals));
        list(duel, "history").add(record);

        long round = (Long) duel.get("round");
        if ((Long) hp.get(0) == 0 || (Long) hp.get(1) == 0 || round == (Long) duel.get("rounds")) {
            long a = (Long) hp.get(0);
            long c = (Long) hp.get(1);
            duel.put("winner", a == c ? -1L : a > c ? 0L : 1L);
            duel.put("phase", "done");
            duel.put("status", "done");
            return;
        }
        duel.put("round", round + 1);
        duel.put("phase", "seal");
        duel.put("roundStart", at);
        duel.put("revealDeadline", null);
        duel.put("seals", nulls());
        duel.put("reveals", nulls());
    }

    // ------------------------------------------------------------ the shared formulas

    /** Damage {@code attack} deals to a defender who played {@code defend} (null: they forfeited). */
    static long damage(String attack, String defend) {
        return switch (attack) {
            case "laser" -> "shield".equals(defend) ? 0 : 2;
            case "missile" -> "emp".equals(defend) ? 0 : "shield".equals(defend) ? 1 : 4;
            case "emp" -> "shield".equals(defend) ? 3 : "missile".equals(defend) ? 0 : 1;
            default -> 0;
        };
    }

    static String sealHash(String duelId, long round, String id, String move, String secret) {
        return HexFormat.of().formatHex(Blake2b.hash(
                String.join("|", APP, duelId, Long.toString(round), id, move, secret).getBytes(StandardCharsets.UTF_8), 32));
    }

    static long rollDie(String duelId, long round, String secretA, String secretB) {
        byte[] h = Blake2b.hash(String.join("|", APP, "dice", duelId, Long.toString(round), secretA, secretB)
                .getBytes(StandardCharsets.UTF_8), 32);
        long word = new BigInteger(1, Arrays.copyOf(h, 4)).longValue();
        return 1 + word % 6;
    }

    private String statement(String scope, String kind, String id, Object... fields) {
        StringBuilder s = new StringBuilder(String.join("|", APP, chainId, scope, kind, id));
        for (Object f : fields) {
            s.append('|').append(f == null ? "" : f);
        }
        return s.toString();
    }

    private String statementIn(String duelId, String kind, String id, Object... fields) {
        return statement(duelId, kind, id, fields);
    }

    private static boolean verify(String pubHex, String sigHex, String statement) {
        try {
            byte[] raw = HexFormat.of().parseHex(pubHex);
            byte[] encoded = new byte[ED25519_X509.length + raw.length];
            System.arraycopy(ED25519_X509, 0, encoded, 0, ED25519_X509.length);
            System.arraycopy(raw, 0, encoded, ED25519_X509.length, raw.length);
            PublicKey key = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(encoded));
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(key);
            verifier.update(statement.getBytes(StandardCharsets.UTF_8));
            return verifier.verify(HexFormat.of().parseHex(sigHex));
        } catch (Exception e) {
            return false;
        }
    }

    // ------------------------------------------------------------ helpers

    private static Map<String, Object> parse(byte[] body) {
        if (body == null || body.length == 0 || body.length > MAX_BODY_BYTES) {
            return null;
        }
        try {
            Object value = Json.parse(StandardCharsets.UTF_8.newDecoder()
                    .decode(java.nio.ByteBuffer.wrap(body)).toString());
            return value instanceof Map ? object(value) : null;
        } catch (Exception e) {
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value) {
        return (Map<String, Object>) value;
    }

    private static Map<String, Object> object(String json) {
        return object(Json.parse(json));
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Map<String, Object> duel, String key) {
        return (List<Object>) duel.get(key);
    }

    private static List<Object> nulls() {
        return new ArrayList<>(Arrays.asList(null, null));
    }

    private static Map<?, ?> player(Map<String, Object> duel, int seat) {
        return (Map<?, ?>) duel.get(seat == 0 ? "challenger" : "opponent");
    }

    private static int seat(Map<String, Object> duel, String id) {
        if (id == null) {
            return -1;
        }
        for (int i = 0; i < 2; i++) {
            if (id.equals(player(duel, i).get("id"))) {
                return i;
            }
        }
        return -1;
    }

    private static String str(Map<String, Object> b, String key) {
        return b.get(key) instanceof String s ? s : null;
    }

    private static Long num(Map<String, Object> b, String key) {
        return b.get(key) instanceof Long n ? n : null;
    }

    private static Outcome reject(String code, String reason) {
        return new Outcome(code, reason);
    }
}
