package com.bloxbean.yano.examples.auditlog;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;

/**
 * One access-control change: "alice granted bob read access to prod-db".
 *
 * <p>The body an app chain stores is opaque bytes, so the application owns the
 * encoding. What matters for an audit log is that the bytes are <em>canonical</em>:
 * the message id is derived from the content, and an auditor who re-serializes
 * the same logical event must get the same bytes back. Two semantically
 * identical JSON documents can hash differently because of key order or
 * whitespace, so this record writes its fields in a fixed order with a compact
 * separator rather than relying on a mapper's defaults.
 */
public record AccessEvent(
        String action,     // "grant" or "revoke"
        String actor,      // who made the change
        String subject,    // whose access changed
        String resource,   // what they now can or cannot reach
        String reason,     // free text for the auditor
        String at          // ISO-8601 instant, recorded by the submitter
) {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    public static AccessEvent of(String action, String actor, String subject,
                                 String resource, String reason) {
        return new AccessEvent(action, actor, subject, resource, reason,
                Instant.now().toString());
    }

    /**
     * Canonical UTF-8 bytes for this event. Field order is fixed by this method,
     * not by a map's iteration order.
     */
    public byte[] toCanonicalBytes() {
        StringBuilder json = new StringBuilder(160);
        json.append('{');
        appendField(json, "action", action).append(',');
        appendField(json, "actor", actor).append(',');
        appendField(json, "subject", subject).append(',');
        appendField(json, "resource", resource).append(',');
        appendField(json, "reason", reason).append(',');
        appendField(json, "at", at);
        json.append('}');
        return json.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** Best-effort decode for display. Returns null when the body is not one of ours. */
    public static AccessEvent fromBytes(byte[] body) {
        try {
            JsonNode node = MAPPER.readTree(body);
            if (!node.isObject() || !node.has("action")) {
                return null;
            }
            return new AccessEvent(
                    text(node, "action"), text(node, "actor"), text(node, "subject"),
                    text(node, "resource"), text(node, "reason"), text(node, "at"));
        } catch (IOException notOurs) {
            return null;
        }
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? "" : value.asText();
    }

    private static StringBuilder appendField(StringBuilder json, String name, String value) {
        json.append('"').append(name).append("\":\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"'  -> json.append("\\\"");
                case '\\' -> json.append("\\\\");
                case '\n' -> json.append("\\n");
                case '\r' -> json.append("\\r");
                case '\t' -> json.append("\\t");
                default   -> {
                    if (c < 0x20) {
                        json.append(String.format("\\u%04x", (int) c));
                    } else {
                        json.append(c);
                    }
                }
            }
        }
        return json.append('"');
    }
}
