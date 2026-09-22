package com.bloxbean.yano.examples.anchorverify;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.yanoproject.x.client.AppChainClient;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * A self-contained claim about one record.
 *
 * <p>This is what gets handed to a verifier: the record, where it sits, and the
 * proof that ties it to a state root. It is data, not a promise — every field
 * is checked against Cardano before any of it is believed.
 *
 * <p>Note what it does <b>not</b> carry: where to find the anchor. If a bundle
 * could name its own anchor, a forged bundle would simply name a forged anchor.
 * That has to be pinned separately — see {@link AnchorTrust}.
 */
public record Bundle(String chainId, long height, String keyHex, String valueHex,
                     String proofWireHex, String stateRootHex, String note) {

    private static final ObjectMapper JSON = new ObjectMapper();

    public static Bundle from(AppChainClient.Proof proof, String note) {
        if (proof.committedHeight() == null) {
            throw new IllegalStateException("the proof carries no committed height");
        }
        return new Bundle(proof.chainId(), proof.committedHeight(), proof.keyHex(),
                proof.valueHex(), proof.proofWireHex(), proof.stateRootHex(), note);
    }

    public String toJson() {
        ObjectNode node = JSON.createObjectNode();
        node.put("chainId", chainId);
        node.put("height", height);
        node.put("keyHex", keyHex);
        node.put("valueHex", valueHex);
        node.put("proofWireHex", proofWireHex);
        node.put("stateRootHex", stateRootHex);
        node.put("note", note);
        try {
            return JSON.writerWithDefaultPrettyPrinter().writeValueAsString(node) + "\n";
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    public static Bundle read(Path file) {
        try {
            var node = JSON.readTree(Files.readString(file));
            return new Bundle(node.path("chainId").asText(), node.path("height").asLong(),
                    node.path("keyHex").asText(), node.path("valueHex").asText(null),
                    node.path("proofWireHex").asText(), node.path("stateRootHex").asText(),
                    node.path("note").asText(""));
        } catch (Exception malformed) {
            throw new IllegalStateException("cannot read the bundle " + file + ": "
                    + malformed.getMessage(), malformed);
        }
    }

    public void write(Path file) {
        try {
            Files.writeString(file, toJson());
        } catch (Exception failure) {
            throw new IllegalStateException("cannot write " + file, failure);
        }
    }

    /**
     * A readable description of what is committed at this key.
     *
     * <p>{@code ordered-log} commits a record of every finalized message, so
     * the proven value is that record — topic, height and index — not the
     * message body. The body itself lives in block history; what the state
     * root commits to is that the message was finalized where it says.
     */
    public String valueText() {
        if (valueHex == null) {
            return "(absent — this is an exclusion proof)";
        }
        try {
            // The subject knows how to decode its own committed value; which
            // message id built the subject does not affect that.
            var record = org.yanoproject.x.client.ProofSubjects
                    .finalizedMessage(new byte[32])
                    .decodePresentValue(java.util.HexFormat.of().parseHex(valueHex));
            return "topic " + record.topic() + ", finalized at height "
                    + record.height() + " index " + record.originalMessageIndex();
        } catch (RuntimeException notAMessageRecord) {
            return java.util.HexFormat.of().parseHex(valueHex).length + " bytes";
        }
    }
}
