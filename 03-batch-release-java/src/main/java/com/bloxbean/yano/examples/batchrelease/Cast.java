package com.bloxbean.yano.examples.batchrelease;

import org.yanoproject.x.client.Hex;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Optional;

/**
 * Who is in this scenario.
 *
 * <p>Three organizations and nine people. The distinction the whole example
 * rests on: none of these are app-chain members. The three member nodes
 * transport and finalize commands; these actors authorize their business
 * meaning with their own keys.
 *
 * <h2>Demo keys</h2>
 * Actor seeds are derived from the actor id below, so the example needs no key
 * files and anyone can reproduce it. That makes every private key here public.
 * In a deployment each actor generates its own seed on its own machine and
 * publishes only the public half — see README.md.
 */
public final class Cast {

    /** Roles, with the full terms spelled out for anyone outside pharma. */
    public static final String ROLE_COORDINATOR = "batch-coordinator";
    public static final String ROLE_QC = "qc-analyst";          // Quality Control
    public static final String ROLE_QA = "qa-reviewer";         // Quality Assurance
    public static final String ROLE_QP = "qualified-person";    // QP, EU GMP Annex 16
    public static final String ROLE_AUDITOR = "auditor";

    public record Organization(String id, String displayName, String about) {}

    public record Actor(String id, String displayName, String organizationId,
                        List<String> roles, String about) {

        /** Demo-only: a deterministic seed so the example is reproducible. */
        public byte[] demoSeed() {
            try {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                digest.update("yano-x-example-03-demo-actor\0".getBytes(StandardCharsets.US_ASCII));
                return digest.digest(id.getBytes(StandardCharsets.UTF_8));
            } catch (Exception impossible) {
                throw new IllegalStateException(impossible);
            }
        }

        public byte[] publicKey() {
            return Registry.publicKey(demoSeed());
        }

        public String publicKeyHex() {
            return Hex.encode(publicKey());
        }

        /** Every actor holds one key in this example; rotation adds a second epoch. */
        public String keyId() {
            return id + "-key-v1";
        }

        public boolean hasRole(String role) {
            return roles.contains(role);
        }
    }

    public static final List<Organization> ORGANIZATIONS = List.of(
            new Organization("nordia-pharma", "Nordia Pharma",
                    "the manufacturer; holds the manufacturing authorisation"),
            new Organization("helix-labs", "Helix Labs",
                    "independent testing laboratory"),
            new Organization("certus-assurance", "Certus Assurance",
                    "independent assurance firm"));

    public static final List<Actor> ACTORS = List.of(
            new Actor("coordinator-mira", "Mira (Batch Coordinator)", "nordia-pharma",
                    List.of(ROLE_COORDINATOR), "opens each stage; approves nothing"),
            new Actor("qc-anna", "Anna (QC Analyst)", "nordia-pharma",
                    List.of(ROLE_QC), "runs release testing"),
            new Actor("qc-ben", "Ben (QC Analyst)", "nordia-pharma",
                    List.of(ROLE_QC), "second analyst — the four-eyes check"),
            new Actor("qc-cleo", "Cleo (QC Analyst)", "nordia-pharma",
                    List.of(ROLE_QC), "stands in when Anna or Ben is unavailable"),
            new Actor("qa-dev", "Dev (QA Reviewer)", "nordia-pharma",
                    List.of(ROLE_QA), "reviews deviations and the batch record"),
            new Actor("qp-elena", "Elena (Qualified Person)", "nordia-pharma",
                    List.of(ROLE_QP), "certifies batches for release — leaves mid-scenario"),
            new Actor("qp-farid", "Farid (Qualified Person)", "nordia-pharma",
                    List.of(ROLE_QP), "Elena's successor"),
            new Actor("auditor-gita", "Gita (Auditor)", "helix-labs",
                    List.of(ROLE_AUDITOR), "independent review, Helix Labs"),
            new Actor("auditor-hugo", "Hugo (Auditor)", "certus-assurance",
                    List.of(ROLE_AUDITOR), "independent review, Certus Assurance"),
            new Actor("auditor-iris", "Iris (Auditor)", "helix-labs",
                    List.of(ROLE_AUDITOR), "also Helix Labs — same firm as Gita"));

    private Cast() {
    }

    public static Actor actor(String id) {
        return find(id).orElseThrow(() -> new IllegalArgumentException(
                "unknown actor \"" + id + "\". Known: "
                        + ACTORS.stream().map(Actor::id).toList()));
    }

    public static Optional<Actor> find(String id) {
        return ACTORS.stream().filter(actor -> actor.id().equals(id)).findFirst();
    }

    public static Organization organization(String id) {
        return ORGANIZATIONS.stream().filter(org -> org.id().equals(id)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("unknown organization " + id));
    }

    /** Actors onboarded during the initial ceremony. Farid joins later, by rotation. */
    public static List<Actor> genesisActors() {
        return ACTORS.stream().filter(actor -> !actor.id().equals("qp-farid")).toList();
    }
}
