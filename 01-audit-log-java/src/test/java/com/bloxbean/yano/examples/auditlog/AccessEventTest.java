package com.bloxbean.yano.examples.auditlog;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The event encoding, checked without a chain.
 *
 * <p>Message ids are derived from the body bytes, so an auditor who
 * re-serializes the same logical event has to get the same bytes back. If field
 * order or escaping drifted, old entries would stop being reproducible — which
 * is the kind of bug that only shows up years later, during a dispute.
 */
class AccessEventTest {

    private static String json(AccessEvent event) {
        return new String(event.toCanonicalBytes(), StandardCharsets.UTF_8);
    }

    @Test
    @DisplayName("fields are written in a fixed order")
    void fieldOrderIsFixed() {
        AccessEvent event = new AccessEvent("grant", "alice", "bob", "prod-db",
                "oncall", "2026-09-21T10:00:00Z");

        assertEquals("{\"action\":\"grant\",\"actor\":\"alice\",\"subject\":\"bob\","
                        + "\"resource\":\"prod-db\",\"reason\":\"oncall\","
                        + "\"at\":\"2026-09-21T10:00:00Z\"}",
                json(event));
    }

    @Test
    @DisplayName("the same logical event always produces the same bytes")
    void encodingIsStable() {
        AccessEvent first = new AccessEvent("grant", "alice", "bob", "prod-db", "oncall", "2026-09-21T10:00:00Z");
        AccessEvent second = new AccessEvent("grant", "alice", "bob", "prod-db", "oncall", "2026-09-21T10:00:00Z");

        assertArrayEquals(first.toCanonicalBytes(), second.toCanonicalBytes());
    }

    @Test
    @DisplayName("quotes and control characters cannot break out of a field")
    void valuesAreEscaped() {
        AccessEvent event = new AccessEvent("grant", "ali\"ce", "bob\\", "prod\ndb",
                "tab\there", "2026-09-21T10:00:00Z");

        String encoded = json(event);
        assertTrue(encoded.contains("\\\"ce"), "a quote must be escaped, not close the field");
        assertTrue(encoded.contains("bob\\\\"), "a backslash must be escaped");
        assertTrue(encoded.contains("prod\\ndb"), "a newline must be escaped");
        assertTrue(encoded.contains("tab\\there"), "a tab must be escaped");

        // Still one well-formed record after escaping.
        assertNotNull(AccessEvent.fromBytes(event.toCanonicalBytes()));
    }

    @Test
    @DisplayName("a body that is not one of ours decodes to null rather than throwing")
    void foreignBodiesAreTolerated() {
        assertNull(AccessEvent.fromBytes("not json at all".getBytes(StandardCharsets.UTF_8)));
        assertNull(AccessEvent.fromBytes("{\"unrelated\":true}".getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    @DisplayName("a round trip preserves every field")
    void roundTrip() {
        AccessEvent original = AccessEvent.of("revoke", "carol", "bob", "prod-db", "rotation ended");
        AccessEvent decoded = AccessEvent.fromBytes(original.toCanonicalBytes());

        assertEquals(original, decoded);
    }
}
