package com.bloxbean.yano.examples.auditlog;

import com.fasterxml.jackson.databind.JsonNode;
import org.yanoproject.api.appchain.transition.FinalizedMessageIndex;
import org.yanoproject.x.client.AppChainClient;
import org.yanoproject.x.client.Hex;
import org.yanoproject.x.client.ProofSubjects;
import org.yanoproject.x.client.ProofVerifier;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Everything this example does against the chain.
 *
 * <p>The three members of {@code access-log-chain} are ordinary peers. Any of
 * them accepts a submission and any of them can serve a proof, which is the
 * whole point: the auditor never has to pick a node to trust.
 */
public final class AuditLog {

    public static final String CHAIN_ID = "access-log-chain";
    public static final String TOPIC = "access.event.v1";

    /** Default HTTP base of node 0; node i listens on BASE_PORT + i. */
    private static final int BASE_PORT =
            Integer.getInteger("yano.httpBase",
                    Integer.parseInt(System.getenv().getOrDefault("YANO_HTTP_BASE", "7100")));

    private final int nodeCount;

    public AuditLog(int nodeCount) {
        this.nodeCount = nodeCount;
    }

    public int nodeCount() {
        return nodeCount;
    }

    /** A client bound to one specific member. */
    public AppChainClient node(int index) {
        if (index < 0 || index >= nodeCount) {
            throw new IllegalArgumentException("node index must be 0.." + (nodeCount - 1));
        }
        return AppChainClient.builder("http://127.0.0.1:" + (BASE_PORT + index) + "/api/v1")
                .chainId(CHAIN_ID)
                .build();
    }

    // ---------------------------------------------------------------- record

    /**
     * Submit one event through {@code viaNode} and wait until a threshold of
     * members has finalized it.
     *
     * <p>A successful submission is <em>admission to the message pool</em>, not
     * finality. The returned message id is the handle used to ask any member,
     * later, whether and where that exact event was finalized.
     */
    public Recorded record(AccessEvent event, int viaNode, Duration timeout) {
        AppChainClient client = node(viaNode);
        byte[] body = event.toCanonicalBytes();

        AppChainClient.SubmitResult submitted = client.submit(TOPIC, body);
        byte[] messageId = Hex.decode(submitted.messageId());

        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            Optional<FinalizedMessageIndex.MessageRecord> finalized = lookup(client, messageId);
            if (finalized.isPresent()) {
                return new Recorded(submitted.messageId(), finalized.orElseThrow(), viaNode);
            }
            sleep(250);
        }
        throw new IllegalStateException(
                "message " + submitted.messageId() + " was accepted but not finalized within " + timeout);
    }

    /**
     * Ask one member where a message was finalized.
     *
     * <p>{@code ordered-log} writes a record for every finalized message into
     * authenticated state, so the answer is not a database lookup the node
     * could fake — it is backed by the same MPF the state root commits to.
     * {@link Optional#empty()} means "this member has not finalized it (yet)".
     */
    public Optional<FinalizedMessageIndex.MessageRecord> lookup(AppChainClient client, byte[] messageId) {
        return client.proof(ProofSubjects.finalizedMessage(messageId))
                .map(AppChainClient.TypedProof::decodedValue)
                .filter(record -> record != null);
    }

    // ------------------------------------------------------------------ read

    /** Walk finalized blocks on one member and collect this example's entries. */
    public List<Entry> history(int fromNode, int limit) {
        AppChainClient client = node(fromNode);
        long tip = client.tip().height();
        List<Entry> entries = new ArrayList<>();

        for (long height = tip; height >= 1 && entries.size() < limit; height--) {
            Optional<AppChainClient.Block> block = client.block(height);
            if (block.isEmpty()) {
                continue;
            }
            List<AppChainClient.Message> messages = block.orElseThrow().messages();
            // Newest first, so walk the block's messages backwards too.
            for (int i = messages.size() - 1; i >= 0 && entries.size() < limit; i--) {
                AppChainClient.Message message = messages.get(i);
                if (!TOPIC.equals(message.topic())) {
                    continue;
                }
                entries.add(new Entry(height, i, message.messageId(), message.senderHex(),
                        AccessEvent.fromBytes(message.body())));
            }
        }
        return entries;
    }

    /** Tip height and state root as each member currently sees them. */
    public List<Tip> tips() {
        List<Tip> tips = new ArrayList<>();
        for (int i = 0; i < nodeCount; i++) {
            try {
                AppChainClient.Tip tip = node(i).tip();
                tips.add(new Tip(i, tip.height(), tip.stateRootHex(), null));
            } catch (RuntimeException unreachable) {
                tips.add(new Tip(i, -1, null, unreachable.getMessage()));
            }
        }
        return tips;
    }

    // ----------------------------------------------------------------- prove

    /**
     * The verification this example exists to show.
     *
     * <p>{@code servingNode} produces the proof. {@code trustingNode} supplies
     * the state root the proof is checked against, taken from its own copy of
     * the block at the height the proof commits to. If the serving node had
     * invented the record, its proof would not reconcile with a root that a
     * different member independently finalized.
     *
     * <p>In production the trusted root should come from something stronger
     * still — a threshold certificate under membership you pinned yourself
     * ({@code ProofVerifier.verifyCertified}) or a Cardano anchor transaction
     * ({@code ProofVerifier.trustedRootFromCardanoAnchor}). A peer member is
     * the weakest of the three and the easiest to run locally.
     */
    public Verification prove(String messageIdHex, int servingNode, int trustingNode) {
        byte[] messageId = Hex.decode(messageIdHex);

        AppChainClient server = node(servingNode);
        AppChainClient.TypedProof<FinalizedMessageIndex.MessageRecord> typed =
                server.proof(ProofSubjects.finalizedMessage(messageId))
                        .orElseThrow(() -> new IllegalStateException(
                                "node " + servingNode + " has no proof for " + messageIdHex));

        AppChainClient.Proof proof = typed.proof();
        if (proof.committedHeight() == null) {
            throw new IllegalStateException("proof carries no committed height");
        }
        long height = proof.committedHeight();

        // Step 1 — the proof mathematics alone, against the root the serving
        // node itself reported. This is a self-consistency check, NOT a trust
        // boundary: a lying node could hand out a consistent proof for a root
        // it made up.
        boolean selfConsistent = ProofVerifier.verifyAgainstRoot(proof, proof.stateRootHex());

        // Step 2 — the real check. Take the state identity and the root at that
        // exact height from a different member, and verify against those.
        AppChainClient trustee = node(trustingNode);
        JsonNode identity = trustee.stateIdentity();
        AppChainClient.Block blockOnTrustee = awaitBlock(trustee, height, Duration.ofSeconds(20))
                .orElseThrow(() -> new IllegalStateException(
                        "node " + trustingNode + " has not finalized height " + height));

        ProofVerifier.TrustedStateRoot trusted = new ProofVerifier.TrustedStateRoot(
                CHAIN_ID,
                identity.path("profile").asText(),
                identity.path("genesisId").asText(),
                height,
                blockOnTrustee.stateRootHex(),
                ProofVerifier.TrustedRootSource.LOCALLY_VERIFIED_BLOCK);

        boolean verified = ProofVerifier.verify(proof, trusted);

        // Step 3 — tamper evidence. Flip one bit of the proven value and check
        // the same proof against the same honest root. It must fail.
        byte[] key = Hex.decode(proof.keyHex());
        byte[] value = Hex.decode(proof.valueHex());
        byte[] tampered = value.clone();
        tampered[tampered.length - 1] ^= 0x01;

        byte[] root = Hex.decode(blockOnTrustee.stateRootHex());
        byte[] wire = Hex.decode(proof.proofWireHex());
        boolean honestValueAccepted = ProofVerifier.verifyInclusion(root, key, value, wire);
        boolean tamperedValueAccepted = ProofVerifier.verifyInclusion(root, key, tampered, wire);

        return new Verification(messageIdHex, typed.decodedValue(), proof, servingNode,
                trustingNode, blockOnTrustee.stateRootHex(), selfConsistent, verified,
                honestValueAccepted, tamperedValueAccepted);
    }

    /**
     * Wait for one member to finalize a given height.
     *
     * <p>Members converge within a block or two, so the node serving a proof is
     * often a block ahead of the node being asked to vouch for the root. That
     * is normal operation, not disagreement — give the peer a moment to catch
     * up rather than reporting a mismatch.
     */
    private Optional<AppChainClient.Block> awaitBlock(AppChainClient client, long height, Duration timeout) {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (true) {
            Optional<AppChainClient.Block> block = client.block(height);
            if (block.isPresent() || System.nanoTime() >= deadline) {
                return block;
            }
            sleep(250);
        }
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while waiting for finality");
        }
    }

    // --------------------------------------------------------------- results

    public record Recorded(String messageId, FinalizedMessageIndex.MessageRecord record, int viaNode) {}

    public record Entry(long height, int index, String messageId, String senderHex, AccessEvent event) {}

    public record Tip(int node, long height, String stateRootHex, String error) {}

    public record Verification(
            String messageId,
            FinalizedMessageIndex.MessageRecord record,
            AppChainClient.Proof proof,
            int servingNode,
            int trustingNode,
            String trustedRootHex,
            boolean selfConsistent,
            boolean verifiedAgainstPeer,
            boolean honestValueAccepted,
            boolean tamperedValueAccepted
    ) {
        /** The example's overall pass condition. */
        public boolean passed() {
            return selfConsistent && verifiedAgainstPeer && honestValueAccepted && !tamperedValueAccepted;
        }
    }
}
