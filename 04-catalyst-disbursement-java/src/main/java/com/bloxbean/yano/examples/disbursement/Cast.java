package com.bloxbean.yano.examples.disbursement;

import org.yanoproject.x.client.Hex;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Optional;

/**
 * Who reviews a milestone, and for whom.
 *
 * <p>None of these are app-chain members. The member nodes transport and
 * finalize commands; these people authorize a payout with their own keys.
 *
 * <p>Demo keys are derived from the actor id so the example is reproducible,
 * which makes every private key here public. In a deployment each reviewer
 * generates their own seed and publishes only the public half.
 */
public final class Cast {

    public static final String ROLE_PROPOSER = "proposer";   // the funded project
    public static final String ROLE_REVIEWER = "reviewer";   // milestone reviewer

    public record Organization(String id, String displayName, String about) {}

    public record Actor(String id, String displayName, String organizationId,
                        List<String> roles, String about) {

        public byte[] demoSeed() {
            try {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                digest.update("yano-x-example-04-demo-actor\0".getBytes(StandardCharsets.US_ASCII));
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

        public String keyId() {
            return id + "-key-v1";
        }

        public boolean hasRole(String role) {
            return roles.contains(role);
        }
    }

    public static final List<Organization> ORGANIZATIONS = List.of(
            new Organization("lumen-labs", "Lumen Labs",
                    "the funded project delivering the milestones"),
            new Organization("reviewer-guild-north", "Reviewer Guild North",
                    "independent milestone reviewers"),
            new Organization("reviewer-guild-south", "Reviewer Guild South",
                    "independent milestone reviewers, a separate guild"));

    public static final List<Actor> ACTORS = List.of(
            new Actor("proposer-nia", "Nia (Lumen Labs)", "lumen-labs",
                    List.of(ROLE_PROPOSER), "submits milestone evidence; reviews nothing"),
            new Actor("reviewer-omar", "Omar (Guild North)", "reviewer-guild-north",
                    List.of(ROLE_REVIEWER), "milestone reviewer"),
            new Actor("reviewer-pia", "Pia (Guild South)", "reviewer-guild-south",
                    List.of(ROLE_REVIEWER), "milestone reviewer, a different guild"),
            new Actor("reviewer-quinn", "Quinn (Guild North)", "reviewer-guild-north",
                    List.of(ROLE_REVIEWER), "also Guild North — same guild as Omar"));

    private Cast() {
    }

    public static Actor actor(String id) {
        return find(id).orElseThrow(() -> new IllegalArgumentException(
                "unknown actor \"" + id + "\". Known: " + ACTORS.stream().map(Actor::id).toList()));
    }

    public static Optional<Actor> find(String id) {
        return ACTORS.stream().filter(actor -> actor.id().equals(id)).findFirst();
    }

    public static List<Actor> genesisActors() {
        return ACTORS;
    }
}
