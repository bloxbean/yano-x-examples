package com.bloxbean.yano.examples.disbursement;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.metadata.cbor.CBORMetadata;
import com.bloxbean.cardano.client.metadata.cbor.CBORMetadataMap;
import com.bloxbean.cardano.client.transaction.spec.*;
import com.bloxbean.cardano.client.transaction.util.TransactionUtil;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.yanoproject.x.roles.contracts.ApprovalPolicyV1;

import java.math.BigInteger;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The claims this example rests on, checked without a chain or a node.
 *
 * <p>The important ones are about transaction identity: if signing changed a
 * transaction's id, or if two different payments could share one, the whole
 * design would be unsound.
 */
class PayoutAuthorizationTest {

    private static Transaction payment(String payee, long lovelace) {
        return Transaction.builder()
                .body(TransactionBody.builder()
                        .inputs(List.of(new TransactionInput(
                                "0".repeat(64), 0)))
                        .outputs(List.of(TransactionOutput.builder()
                                .address(payee)
                                .value(Value.builder()
                                        .coin(BigInteger.valueOf(lovelace)).build())
                                .build()))
                        .fee(BigInteger.valueOf(170_000))
                        .build())
                .build();
    }

    private static final String PAYEE_A = new Account(Networks.testnet()).baseAddress();
    private static final String PAYEE_B = new Account(Networks.testnet()).baseAddress();

    // ------------------------------------------------- transaction identity

    @Test
    @DisplayName("a different amount is a different transaction id")
    void amountChangesTheId() {
        assertNotEquals(TransactionUtil.getTxHash(payment(PAYEE_A, 500_000_000L)),
                TransactionUtil.getTxHash(payment(PAYEE_A, 900_000_000L)),
                "raising the payout must not keep the approved id");
    }

    @Test
    @DisplayName("a different recipient is a different transaction id")
    void payeeChangesTheId() {
        assertNotEquals(TransactionUtil.getTxHash(payment(PAYEE_A, 500_000_000L)),
                TransactionUtil.getTxHash(payment(PAYEE_B, 500_000_000L)),
                "redirecting the payout must not keep the approved id");
    }

    @Test
    @DisplayName("the same payment always has the same id, so a reviewer can rebuild it")
    void identicalPaymentsShareAnId() {
        assertEquals(TransactionUtil.getTxHash(payment(PAYEE_A, 500_000_000L)),
                TransactionUtil.getTxHash(payment(PAYEE_A, 500_000_000L)));
    }

    @Test
    @DisplayName("signing does not change the id — witnesses sit outside the body")
    void signingPreservesTheId() {
        Account treasury = new Account(Networks.testnet());
        Transaction unsigned = payment(PAYEE_A, 500_000_000L);
        String before = TransactionUtil.getTxHash(unsigned);

        Transaction signed = treasury.sign(unsigned);
        assertEquals(before, TransactionUtil.getTxHash(signed),
                "the whole build-approve-sign order depends on this");
        assertFalse(signed.getWitnessSet().getVkeyWitnesses().isEmpty(),
                "the signature must actually have been added");
    }

    @Test
    @DisplayName("a transaction id is 32 bytes, which is what an actor statement requires")
    void idIsThirtyTwoBytes() {
        String id = TransactionUtil.getTxHash(payment(PAYEE_A, 500_000_000L));
        assertEquals(64, id.length());
        assertEquals(32, java.util.HexFormat.of().parseHex(id).length);
    }

    // --------------------------------------------- evidence bound to the id

    private static Transaction paymentWith(String evidenceHash) {
        CBORMetadataMap entry = new CBORMetadataMap()
                .put("milestone", "M1-alpha")
                .put("evidence", evidenceHash);
        AuxiliaryData aux = AuxiliaryData.builder()
                .metadata(new CBORMetadata()
                        .put(BigInteger.valueOf(Treasury.METADATA_LABEL), entry))
                .build();
        Transaction tx = payment(PAYEE_A, 500_000_000L);
        tx.getBody().setAuxiliaryDataHash(aux.getAuxiliaryDataHash());
        tx.setAuxiliaryData(aux);
        return tx;
    }

    @Test
    @DisplayName("different deliverables give a different id, with the money unchanged")
    void evidenceIsCoveredByTheId() {
        String a = TransactionUtil.getTxHash(paymentWith(Treasury.evidenceHash("parser + tests")));
        String b = TransactionUtil.getTxHash(paymentWith(Treasury.evidenceHash("nothing delivered")));

        assertNotEquals(a, b,
                "swapping the deliverables must break the approval, even though the "
                        + "amount and recipient are identical");
    }

    @Test
    @DisplayName("attaching evidence at all changes the id")
    void evidencePresenceChangesTheId() {
        assertNotEquals(TransactionUtil.getTxHash(payment(PAYEE_A, 500_000_000L)),
                TransactionUtil.getTxHash(paymentWith(Treasury.evidenceHash("x"))));
    }

    @Test
    @DisplayName("the same deliverables give the same id, so it can be reproduced")
    void sameEvidenceSameId() {
        assertEquals(TransactionUtil.getTxHash(paymentWith(Treasury.evidenceHash("parser + tests"))),
                TransactionUtil.getTxHash(paymentWith(Treasury.evidenceHash("parser + tests"))));
    }

    @Test
    @DisplayName("the evidence hash is a 32-byte digest of the exact deliverable bytes")
    void evidenceHashShape() {
        String hash = Treasury.evidenceHash("milestone 1 deliverables");
        assertEquals(64, hash.length());
        assertNotEquals(hash, Treasury.evidenceHash("milestone 1 deliverables "));
    }

    // ------------------------------------------------------------- policy

    @Test
    @DisplayName("a payout needs two reviewers from DISTINCT ORGANIZATIONS")
    void payoutNeedsTwoOrganizations() {
        ApprovalPolicyV1.RequiredClause clause =
                Policies.milestonePayout().clause(Policies.CLAUSE_REVIEW);

        assertEquals(Cast.ROLE_REVIEWER, clause.role());
        assertEquals(2, clause.minimumCount());
        assertEquals(ApprovalPolicyV1.DistinctBy.ORGANIZATION, clause.distinctBy(),
                "money moves on this — two colleagues must not be able to release it");
    }

    @Test
    @DisplayName("only the project may open a review; reviewers cannot open their own")
    void onlyTheProposerOpensAReview() {
        assertEquals(List.of(Cast.ROLE_PROPOSER), Policies.milestonePayout().proposerRoles());
        assertFalse(Cast.actor("reviewer-omar").hasRole(Cast.ROLE_PROPOSER));
        assertFalse(Cast.actor("proposer-nia").hasRole(Cast.ROLE_REVIEWER),
                "the project must not be able to review its own milestone");
    }

    @Test
    @DisplayName("two reviewers share a guild, so the negative case is real")
    void twoReviewersShareAnOrganization() {
        assertEquals(Cast.actor("reviewer-omar").organizationId(),
                Cast.actor("reviewer-quinn").organizationId());
        assertNotEquals(Cast.actor("reviewer-pia").organizationId(),
                Cast.actor("reviewer-omar").organizationId());
    }

    @Test
    @DisplayName("the payload domain says what the hash is")
    void payloadDomainNamesTheContract() {
        assertEquals("org.cardano.transaction.id.v1", Milestones.PAYLOAD_DOMAIN);
        assertTrue(Milestones.PAYLOAD_DOMAIN.length() <= 64);
    }

    @Test
    @DisplayName("milestone ids become valid proposal identifiers")
    void proposalIdsAreValid() {
        for (String milestone : List.of("M1-alpha", "M2 Beta", "MILESTONE_3")) {
            String id = Milestones.proposalId(milestone);
            assertTrue(id.matches("[a-z0-9][a-z0-9.\\-_]*"), id);
            assertTrue(id.length() <= 63, id);
        }
    }
}
