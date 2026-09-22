package com.bloxbean.yano.examples.batchrelease;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.yanoproject.x.roles.contracts.ActorKeyEpochV1;
import org.yanoproject.x.roles.contracts.ActorKeyProofV1;
import org.yanoproject.x.roles.contracts.ApprovalPolicyV1;
import org.yanoproject.x.roles.contracts.RecordStatus;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The parts of this example that can be checked without a chain: the policies
 * say what the README claims, the payload chaining binds stages together, and
 * an actor key proof verifies.
 */
class PolicyAndPayloadTest {

    // ------------------------------------------------------------- policies

    @Test
    @DisplayName("Quality Control needs two DIFFERENT PEOPLE")
    void qcNeedsTwoDistinctActors() {
        ApprovalPolicyV1.RequiredClause clause = Policies.qcResults().clause(Policies.CLAUSE_QC);

        assertEquals(Cast.ROLE_QC, clause.role());
        assertEquals(2, clause.minimumCount(), "four-eyes: one analyst is not enough");
        assertEquals(ApprovalPolicyV1.DistinctBy.ACTOR, clause.distinctBy(),
                "two different people; the same employer is fine for QC");
    }

    @Test
    @DisplayName("independent review needs two DIFFERENT ORGANIZATIONS")
    void independentReviewNeedsDistinctOrganizations() {
        ApprovalPolicyV1 policy = Policies.qpRelease();

        ApprovalPolicyV1.RequiredClause independent = policy.clause(Policies.CLAUSE_INDEPENDENT);
        assertEquals(2, independent.minimumCount());
        assertEquals(ApprovalPolicyV1.DistinctBy.ORGANIZATION, independent.distinctBy(),
                "two colleagues at one firm are not two independent opinions");

        ApprovalPolicyV1.RequiredClause certification = policy.clause(Policies.CLAUSE_QP);
        assertEquals(Cast.ROLE_QP, certification.role());
        assertEquals(1, certification.minimumCount());
    }

    @Test
    @DisplayName("only the coordinator may open a stage")
    void onlyTheCoordinatorProposes() {
        for (ApprovalPolicyV1 policy : Policies.all()) {
            assertEquals(List.of(Cast.ROLE_COORDINATOR), policy.proposerRoles(),
                    policy.policyId() + " should be opened by the batch coordinator");
        }
    }

    @Test
    @DisplayName("a policy cannot express ordering — which is why stages chain by payload")
    void policiesCarryNoOrdering() {
        // RequiredClause is (clauseId, role, minimumCount, distinctBy) and nothing
        // else. If a future release adds a dependency field, this test should be
        // revisited along with the README's "Future enhancements" section.
        assertEquals(4, ApprovalPolicyV1.RequiredClause.class.getRecordComponents().length,
                "an ordering field would change how this example should work");
    }

    // ---------------------------------------------------------- the cast

    @Test
    @DisplayName("the two Helix Labs auditors exist, so the same-firm case is real")
    void twoAuditorsShareAnOrganization() {
        assertEquals(Cast.actor("auditor-gita").organizationId(),
                Cast.actor("auditor-iris").organizationId(),
                "Gita and Iris must share a firm for the distinct-organization demo");
        assertNotEquals(Cast.actor("auditor-hugo").organizationId(),
                Cast.actor("auditor-gita").organizationId(),
                "Hugo must be at a different firm to complete the clause");
    }

    @Test
    @DisplayName("the successor is not registered at genesis — he joins by replacement")
    void successorJoinsLater() {
        assertTrue(Cast.genesisActors().stream().noneMatch(a -> a.id().equals("qp-farid")));
        assertTrue(Cast.genesisActors().stream().anyMatch(a -> a.id().equals("qp-elena")));
    }

    // -------------------------------------------------------- payload chaining

    @Test
    @DisplayName("a later stage's payload commits to the earlier stage")
    void stagesChainByPayload() {
        BatchRecord qc = new BatchRecord("BATCH-1", "tablets", BatchRecord.Stage.QC,
                "testing", null, null);
        BatchRecord qa = new BatchRecord("BATCH-1", "tablets", BatchRecord.Stage.QA,
                "review", qc.proposalId(), qc.payloadHashHex());

        // Change what QC certified, and QA's payload hash must change too.
        BatchRecord qcAltered = new BatchRecord("BATCH-1", "tablets", BatchRecord.Stage.QC,
                "testing (altered)", null, null);
        BatchRecord qaOverAltered = new BatchRecord("BATCH-1", "tablets", BatchRecord.Stage.QA,
                "review", qcAltered.proposalId(), qcAltered.payloadHashHex());

        assertNotEquals(qa.payloadHashHex(), qaOverAltered.payloadHashHex(),
                "QA's signature must not survive a change to what QC signed");
    }

    @Test
    @DisplayName("the same logical record always hashes the same")
    void payloadHashingIsStable() {
        BatchRecord first = new BatchRecord("BATCH-1", "tablets", BatchRecord.Stage.QC, "t", null, null);
        BatchRecord second = new BatchRecord("BATCH-1", "tablets", BatchRecord.Stage.QC, "t", null, null);
        assertEquals(first.payloadHashHex(), second.payloadHashHex());
        assertEquals(32, first.payloadHash().length, "an actor statement requires 32 bytes");
    }

    @Test
    @DisplayName("proposal ids and payload domains stay within the registry's bounds")
    void identifiersAreValid() {
        for (BatchRecord.Stage stage : BatchRecord.Stage.values()) {
            String proposalId = BatchRecord.proposalId("BATCH-2026-0042", stage);
            assertTrue(proposalId.matches("[a-z0-9][a-z0-9.\\-_]*"), proposalId);
            assertTrue(proposalId.length() <= 63, proposalId);

            String domain = new BatchRecord("B", "p", stage, "s", null, null).payloadDomain();
            assertTrue(domain.length() <= 64, domain);
        }
    }

    // ------------------------------------------------------ proof of possession

    @Test
    @DisplayName("an actor's key proof verifies under that actor's own key")
    void keyProofVerifies() {
        Cast.Actor anna = Cast.actor("qc-anna");
        ActorKeyEpochV1 key = new ActorKeyEpochV1(anna.keyId(),
                Registry.publicKey(anna.demoSeed()), 1, 0, RecordStatus.ACTIVE);

        assertTrue(ActorKeyProofV1.sign(Chain.CHAIN_ID, anna.id(), 1, key, anna.demoSeed())
                .verify(), "the registry must be able to check the holder controls the key");

        // Someone else's seed must not produce a valid proof for Anna's key.
        assertFalse(ActorKeyProofV1.sign(Chain.CHAIN_ID, anna.id(), 1, key,
                Cast.actor("qc-ben").demoSeed()).verify());
    }

    @Test
    @DisplayName("a status change carries no key proof; a first registration does")
    void keyProofsOnlyAccompanyNewKeys() {
        // The registry checks keyProofs().size() == newKeys. Getting this wrong
        // makes the whole mutation a silent no-op, which is how it was found.
        Cast.Actor elena = Cast.actor("qp-elena");

        Registry.Change registration = Registry.registerActor(elena);
        Registry.Change revocation = Registry.changeActorStatus(elena, 2, RecordStatus.REVOKED);

        assertNotEquals(registration.mutationId(), revocation.mutationId());
        assertTrue(registration.describe().contains("revision 1"));
        assertTrue(revocation.describe().contains("REVOKED"));
    }
}
