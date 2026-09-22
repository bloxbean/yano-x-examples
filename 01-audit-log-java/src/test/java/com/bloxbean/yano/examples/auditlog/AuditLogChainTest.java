package com.bloxbean.yano.examples.auditlog;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.yanoproject.api.appchain.AppChainGateway;
import org.yanoproject.appchain.testkit.AppChainCluster;
import org.yanoproject.appchain.testkit.AppChainClusterExtension;
import org.yanoproject.appchain.testkit.AppChainClusterHandle;
import org.yanoproject.x.client.Hex;
import org.yanoproject.x.client.ProofSubjects;
import org.yanoproject.x.client.ProofVerifier;

import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The claims DEMO.md makes, asserted against a real three-member chain.
 *
 * <p>{@code @AppChainCluster} starts the members inside this JVM — no devnet,
 * no ports, no {@code ./cluster start}. That makes these runnable in CI and
 * fast enough to keep in the normal build, so the walkthrough's promises are
 * checked rather than just demonstrated once by hand.
 *
 * <p>These tests drive the in-process gateway directly. They verify the chain
 * behaves as the example says; the REST path the application itself uses is
 * exercised by running {@code ./demo.sh}.
 */
@ExtendWith(AppChainClusterExtension.class)
@AppChainCluster(
        nodes = 3,
        chainId = AuditLog.CHAIN_ID,
        stateMachine = "ordered-log",
        threshold = 2,
        blockIntervalMs = 200)
class AuditLogChainTest {

    private static byte[] record(AppChainClusterHandle cluster, int viaNode, AccessEvent event)
            throws InterruptedException {
        String messageId = cluster.node(viaNode).submit(AuditLog.TOPIC, event.toCanonicalBytes());
        cluster.awaitFinalized(messageId);
        return Hex.decode(messageId);
    }

    @Test
    @DisplayName("every member finalizes the same history")
    void membersAgree(AppChainClusterHandle cluster) throws Exception {
        record(cluster, 0, AccessEvent.of("grant", "alice", "bob", "prod-db", "oncall"));

        Set<String> views = new HashSet<>();
        for (int i = 0; i < cluster.size(); i++) {
            AppChainGateway member = cluster.node(i);
            views.add(member.tipHeight() + ":" + Hex.encode(member.stateRoot()));
        }
        assertEquals(1, views.size(),
                "all three members must report the same tip height and state root");
    }

    @Test
    @DisplayName("a recorded event is finalized at a definite position")
    void eventIsFinalized(AppChainClusterHandle cluster) throws Exception {
        byte[] messageId = record(cluster, 0,
                AccessEvent.of("grant", "alice", "bob", "prod-db", "oncall"));

        byte[] key = ProofSubjects.finalizedMessage(messageId).canonicalKey();
        assertTrue(cluster.node(0).stateValue(key).isPresent(),
                "ordered-log writes a record for every finalized message into state");
    }

    @Test
    @DisplayName("any member can prove an entry, and a tampered record is rejected")
    void proofVerifiesAndTamperFails(AppChainClusterHandle cluster) throws Exception {
        byte[] messageId = record(cluster, 0,
                AccessEvent.of("grant", "alice", "bob", "prod-db", "oncall"));

        // Ask a member that did NOT receive the submission.
        AppChainGateway other = cluster.node(2);
        byte[] key = ProofSubjects.finalizedMessage(messageId).canonicalKey();
        byte[] value = other.stateValue(key).orElseThrow();
        byte[] proofWire = other.stateProof(key).orElseThrow();
        byte[] root = other.stateRoot();

        assertTrue(ProofVerifier.verifyInclusion(root, key, value, proofWire),
                "the honest record must verify against the state root");

        byte[] tampered = value.clone();
        tampered[tampered.length - 1] ^= 0x01;
        assertFalse(ProofVerifier.verifyInclusion(root, key, tampered, proofWire),
                "flipping one bit of the recorded event must invalidate the proof");

        byte[] wrongRoot = root.clone();
        wrongRoot[0] ^= 0x01;
        assertFalse(ProofVerifier.verifyInclusion(wrongRoot, key, value, proofWire),
                "a proof must not verify against a root the members never agreed");
    }

    @Test
    @DisplayName("an entry that was never recorded cannot be proved")
    void unknownEntryHasNoProof(AppChainClusterHandle cluster) throws Exception {
        record(cluster, 0, AccessEvent.of("grant", "alice", "bob", "prod-db", "oncall"));

        byte[] neverSubmitted = ProofSubjects.finalizedMessage(new byte[32]).canonicalKey();
        assertTrue(cluster.node(0).stateValue(neverSubmitted).isEmpty(),
                "the chain must not vouch for a record nobody submitted");
    }

    @Test
    @DisplayName("each entry records the member that relayed it")
    void sendersAreDistinguished(AppChainClusterHandle cluster) throws Exception {
        record(cluster, 0, AccessEvent.of("grant", "alice", "bob", "prod-db", "oncall"));
        record(cluster, 1, AccessEvent.of("revoke", "carol", "bob", "prod-db", "rotation ended"));
        record(cluster, 2, AccessEvent.of("grant", "alice", "dave", "billing-api", "finance"));

        Set<String> senders = new HashSet<>();
        for (long height = 1; height <= cluster.node(0).tipHeight(); height++) {
            cluster.node(0).block(height).ifPresent(block ->
                    block.messages().forEach(message ->
                            senders.add(Hex.encode(message.getSender()))));
        }

        assertEquals(3, senders.size(),
                "three members relayed one entry each, so three distinct sender keys appear");
        for (int i = 0; i < cluster.size(); i++) {
            assertTrue(senders.contains(cluster.memberPublicKeyHex(i)),
                    "member " + i + "'s key must appear as the sender of the entry it relayed");
        }
    }
}
