package org.yanox.examples.duels;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DuelsTest {

    /** An in-memory committed state. */
    private static final class MapStore implements Duels.Store {
        final Map<String, String> data = new TreeMap<>();

        @Override
        public Optional<String> get(String key) {
            return Optional.ofNullable(data.get(key));
        }

        @Override
        public void put(String key, String value) {
            data.put(key, value);
        }
    }

    @Test
    void blake2bMatchesRfc7693() {
        assertEquals("ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
                HexFormat.of().formatHex(Blake2b.hash("abc".getBytes(StandardCharsets.UTF_8), 64)));
    }

    @Test
    void damageTable() {
        assertEquals(0, Duels.damage("laser", "shield"));
        assertEquals(1, Duels.damage("missile", "shield"));
        assertEquals(0, Duels.damage("missile", "emp"));
        assertEquals(3, Duels.damage("emp", "shield"));
        assertEquals(2, Duels.damage("laser", null));
        assertEquals(0, Duels.damage("recharge", "laser"));
    }

    /**
     * The browser rules (duels/js/duels.js) generated these vectors. The members
     * must reach the same decision on every message and the same final duel.
     */
    @Test
    @SuppressWarnings("unchecked")
    void agreesWithTheBrowserRules() throws Exception {
        Map<String, Object> vectors = (Map<String, Object>) Json.parse(Files.readString(Path.of(System.getProperty("vectors"))));
        Duels rules = new Duels((String) vectors.get("chainId"));
        MapStore state = new MapStore();
        int i = 0;
        for (Object o : (List<Object>) vectors.get("entries")) {
            Map<String, Object> e = (Map<String, Object>) o;
            Map<String, Object> expected = (Map<String, Object>) e.get("expected");
            byte[] body = HexFormat.of().parseHex((String) e.get("bodyHex"));
            Duels.Outcome outcome = rules.apply(state, (String) e.get("topic"), body,
                    (Long) e.get("timestamp"), (Long) e.get("height"), ((Long) e.get("index")).intValue(), (String) e.get("messageId"));
            assertEquals(expected.get("accepted"), outcome.accepted(),
                    "entry " + i + ": browser said " + expected.get("reason") + ", plugin said " + outcome.reason());
            i++;
        }
        Map<String, Object> want = (Map<String, Object>) vectors.get("final");
        Map<String, Object> got = (Map<String, Object>) Json.parse(state.data.get("duel/" + vectors.get("duelId")));
        for (String field : List.of("hp", "energy", "round", "phase", "winner")) {
            assertEquals(Json.write(want.get(field)), Json.write(got.get(field)), field);
        }
        List<Object> wantHistory = (List<Object>) want.get("history");
        List<Object> gotHistory = (List<Object>) got.get("history");
        assertEquals(wantHistory.size(), gotHistory.size(), "settled rounds");
        for (int r = 0; r < wantHistory.size(); r++) {
            Map<String, Object> w = (Map<String, Object>) wantHistory.get(r);
            Map<String, Object> g = (Map<String, Object>) gotHistory.get(r);
            for (String field : List.of("round", "moves", "forfeited", "die", "dealt")) {
                assertEquals(Json.write(w.get(field)), Json.write(g.get(field)), "round " + (r + 1) + " " + field);
            }
        }
    }

    /** Admission refuses the cheats before they are stored, with a public code. */
    @Test
    @SuppressWarnings("unchecked")
    void admissionRefusesMismatchedRevealsAndForgeries() throws Exception {
        Map<String, Object> vectors = (Map<String, Object>) Json.parse(Files.readString(Path.of(System.getProperty("vectors"))));
        Duels rules = new Duels((String) vectors.get("chainId"));
        MapStore state = new MapStore();
        boolean sawMismatch = false;
        boolean sawForgery = false;
        boolean sawImpostor = false;
        for (Object o : (List<Object>) vectors.get("entries")) {
            Map<String, Object> e = (Map<String, Object>) o;
            String reason = (String) ((Map<String, Object>) e.get("expected")).get("reason");
            byte[] body = HexFormat.of().parseHex((String) e.get("bodyHex"));
            Duels.Outcome admitted = rules.admit(state, (String) e.get("topic"), body);
            if ("the reveal does not match the seal".equals(reason)) {
                assertEquals("REVEAL_MISMATCH", admitted.code());
                sawMismatch = true;
            }
            if ("signature does not verify".equals(reason)) {
                assertEquals("BAD_SIGNATURE", admitted.code());
                sawForgery = true;
            }
            if ("that call sign belongs to another key on this chain".equals(reason)) {
                assertEquals("WRONG_KEY", admitted.code());
                sawImpostor = true;
            }
            rules.apply(state, (String) e.get("topic"), body, (Long) e.get("timestamp"), (Long) e.get("height"),
                    ((Long) e.get("index")).intValue(), (String) e.get("messageId"));
        }
        assertTrue(sawMismatch && sawForgery && sawImpostor, "the vectors include all three cheats");
        assertFalse(rules.admit(state, "orders.command.v1", "{}".getBytes(StandardCharsets.UTF_8)).accepted());
    }
}
