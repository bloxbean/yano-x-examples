package com.bloxbean.yano.examples.disbursement;

import com.fasterxml.jackson.databind.JsonNode;
import org.yanoproject.x.client.AppChainClient;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * Plumbing: the three member nodes, and the read-only domain API.
 *
 * <p>Members are interchangeable here. Which member relays a command does not
 * affect any business decision — that is decided by the actor signature inside
 * the command. The one exception is registry governance, where the relaying
 * member IS the authority: the role-approvals profile derives its
 * administrators from the genesis membership epoch.
 */
public final class Chain {

    public static final String CHAIN_ID = "disbursement-chain";

    /** Registry governance: organizations and actors. */
    public static final String ACTORS_TOPIC = "actors.command.v1";
    /** Policy governance and every actor decision. */
    public static final String ROLE_TOPIC = "role-approvals.command.v1";

    private static final String PLUGIN = "org.yanoproject.x.role-workflow";
    private static final int BASE_PORT = Integer.getInteger("yano.httpBase",
            Integer.parseInt(System.getenv().getOrDefault("YANO_HTTP_BASE", "7140")));
    private static final String API_KEY =
            System.getenv().getOrDefault("YANO_CLUSTER_API_KEY", "yano-local-cluster-full-key");

    private final int memberCount;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10)).build();

    public Chain(int memberCount) {
        this.memberCount = memberCount;
    }

    public int memberCount() {
        return memberCount;
    }

    public AppChainClient member(int index) {
        return AppChainClient.builder(baseUrl(index) + "/api/v1")
                .chainId(CHAIN_ID)
                .apiKey(API_KEY)
                .build();
    }

    private String baseUrl(int index) {
        return "http://127.0.0.1:" + (BASE_PORT + index);
    }

    public long tipHeight() {
        return member(0).tip().height();
    }

    /** Submit one command through a member and return its message id. */
    public String submit(int viaMember, String topic, byte[] body) {
        return member(viaMember).submit(topic, body).messageId();
    }

    /**
     * Wait until a submitted message is in a finalized block.
     *
     * <p>Wait for the <em>message</em>, not for a number of blocks: this chain
     * produces a block when there is something to put in it, so "wait for two
     * more blocks" waits for the next unrelated submission — or until it gives
     * up. Polling the message is both correct and immediate.
     *
     * <p>Finalized means recorded, not successful. An invalid command is a
     * deterministic no-op that still lands in a block, so the outcome is always
     * read back from state afterwards. That discipline is the point.
     */
    public void awaitFinalized(String messageId) {
        long deadline = System.nanoTime() + Duration.ofSeconds(60).toNanos();
        while (System.nanoTime() < deadline) {
            if (finalizedAt(messageId) != null) {
                return;
            }
            sleep(100);
        }
        throw new IllegalStateException("message " + messageId
                + " was accepted but not finalized within 60s");
    }

    /** Wait for every message in a governance round. */
    public void awaitAllFinalized(java.util.List<String> messageIds) {
        messageIds.forEach(this::awaitFinalized);
    }

    /** The finalized position of a message, or null while it is still pending. */
    public com.fasterxml.jackson.databind.JsonNode finalizedAt(String messageId) {
        try {
            HttpResponse<String> response = http.send(
                    HttpRequest.newBuilder(URI.create(baseUrl(0) + "/api/v1/app-chain/chains/"
                                    + CHAIN_ID + "/messages/" + messageId))
                            .header("X-API-Key", API_KEY).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            return response.statusCode() == 200
                    ? new com.fasterxml.jackson.databind.ObjectMapper().readTree(response.body())
                    : null;
        } catch (java.io.IOException | InterruptedException failure) {
            if (failure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return null;
        }
    }

    // ------------------------------------------------------------ domain API

    /** {@code GET /plugins/{bundle}/{path}?chain=...} — the role-workflow projections. */
    public JsonNode domain(String path) {
        return domain(0, path);
    }

    public JsonNode domain(int viaMember, String path) {
        String url = baseUrl(viaMember) + "/api/v1/plugins/" + PLUGIN + "/" + path
                + (path.contains("?") ? "&" : "?") + "chain=" + CHAIN_ID;
        try {
            HttpResponse<String> response = http.send(
                    HttpRequest.newBuilder(URI.create(url))
                            .header("X-API-Key", API_KEY)
                            .header("Accept", "application/json")
                            .GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 404) {
                return null;
            }
            if (response.statusCode() != 200) {
                throw new IllegalStateException("GET " + path + " -> " + response.statusCode()
                        + " " + response.body());
            }
            return new com.fasterxml.jackson.databind.ObjectMapper().readTree(response.body());
        } catch (java.io.IOException | InterruptedException failure) {
            if (failure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new IllegalStateException("cannot reach the chain — is it running? "
                    + "(./cluster start 3 --anchor-mode metadata)", failure);
        }
    }

    /**
     * The node's Cardano API root.
     *
     * <p>The same process that runs the app chain is also a Cardano node, and
     * its REST surface is Blockfrost-shaped — so an ordinary Cardano library
     * can build and submit transactions against it with no extra service.
     */
    public String cardanoApiUrl() {
        return baseUrl(0) + "/api/v1/";
    }

    public JsonNode actorRecord(String actorId) {
        return domain("actors/" + actorId);
    }

    public JsonNode organizationRecord(String organizationId) {
        return domain("organizations/" + organizationId);
    }

    public JsonNode policyRecord(String policyId) {
        return domain("policies/" + policyId);
    }

    public JsonNode proposal(String proposalId) {
        return domain("proposals/" + proposalId);
    }

    /** Per-member tip view, for showing that the members agree. */
    public List<String> memberTips() {
        List<String> tips = new ArrayList<>();
        for (int i = 0; i < memberCount; i++) {
            try {
                AppChainClient.Tip tip = member(i).tip();
                tips.add(tip.height() + ":" + tip.stateRootHex());
            } catch (RuntimeException unreachable) {
                tips.add("unreachable");
            }
        }
        return tips;
    }

    /** The Cardano L1 anchor state for this chain, if anchoring is enabled. */
    public JsonNode anchorStatus() {
        return member(0).status().path("anchor");
    }

    static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted");
        }
    }
}
