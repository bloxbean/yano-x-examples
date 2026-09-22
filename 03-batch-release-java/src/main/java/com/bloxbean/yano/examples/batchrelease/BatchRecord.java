package com.bloxbean.yano.examples.batchrelease;

import org.yanoproject.x.client.Hex;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * What is actually being signed at each stage.
 *
 * <p>The chain never stores these bytes. An actor signs a
 * {@code (payloadDomain, payloadHash)} pair, and the application is responsible
 * for knowing which bytes that hash stands for. So the bytes have to be
 * canonical: anyone re-deriving this record must get the identical hash, or the
 * signature proves nothing about it.
 *
 * <h2>How the stages are chained</h2>
 * A policy is an unordered AND of clauses — it cannot say "stage 2 before
 * stage 3". The ordering is created by the payload instead:
 *
 * <pre>
 *   stage 1 (QC)  payload = batch + test summary
 *   stage 2 (QA)  payload = batch + stage-1 proposal id + stage-1 payload hash
 *   stage 3 (QP)  payload = batch + stage-2 proposal id + stage-2 payload hash
 * </pre>
 *
 * Because each stage's signed hash covers the previous stage's identity, a QP
 * certification that does not reference a real, terminal QA approval is
 * visibly not the certification for that batch. The application still has to
 * check that the referenced stage is APPROVED before asking anyone to sign —
 * consensus does not enforce the ordering. See "Future enhancements" in the
 * README.
 */
public record BatchRecord(
        String batchId,
        String product,
        Stage stage,
        String summary,
        String priorProposalId,
        String priorPayloadHashHex
) {

    public enum Stage {
        QC("qc-results", Policies.QC_RESULTS, "Quality Control — release testing"),
        QA("qa-review", Policies.QA_REVIEW, "Quality Assurance — batch record review"),
        QP("qp-release", Policies.QP_RELEASE, "Qualified Person — certification for release");

        public final String id;
        public final String policyId;
        public final String description;

        Stage(String id, String policyId, String description) {
            this.id = id;
            this.policyId = policyId;
            this.description = description;
        }

        public static Stage of(String value) {
            for (Stage stage : values()) {
                if (stage.id.equalsIgnoreCase(value) || stage.name().equalsIgnoreCase(value)) {
                    return stage;
                }
            }
            throw new IllegalArgumentException("stage must be one of qc-results, qa-review, qp-release");
        }

        public Stage previous() {
            return this == QC ? null : this == QA ? QC : QA;
        }
    }

    /** Identifiers are lowercase and hyphenated; the registry enforces that. */
    public static String normalise(String batchId) {
        return batchId.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9-]", "-");
    }

    public static String proposalId(String batchId, Stage stage) {
        return normalise(batchId) + "-" + stage.id;
    }

    public String proposalId() {
        return proposalId(batchId, stage);
    }

    /** Names the byte contract this hash stands for. Bounded to 64 bytes. */
    public String payloadDomain() {
        return "com.nordia.batch." + stage.id + ".v1";
    }

    /**
     * Canonical bytes. Field order is fixed here, not by a serializer's
     * defaults, so the same logical record always hashes the same.
     */
    public byte[] canonicalBytes() {
        StringBuilder json = new StringBuilder(256);
        json.append('{');
        field(json, "batchId", batchId).append(',');
        field(json, "product", product).append(',');
        field(json, "stage", stage.id).append(',');
        field(json, "summary", summary).append(',');
        field(json, "priorProposalId", priorProposalId == null ? "" : priorProposalId).append(',');
        field(json, "priorPayloadHash", priorPayloadHashHex == null ? "" : priorPayloadHashHex);
        json.append('}');
        return json.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** The 32 bytes an actor signs. */
    public byte[] payloadHash() {
        try {
            return MessageDigest.getInstance("SHA-256").digest(canonicalBytes());
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    public String payloadHashHex() {
        return Hex.encode(payloadHash());
    }

    private static StringBuilder field(StringBuilder json, String name, String value) {
        json.append('"').append(name).append("\":\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> json.append("\\\"");
                case '\\' -> json.append("\\\\");
                case '\n' -> json.append("\\n");
                default -> {
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
