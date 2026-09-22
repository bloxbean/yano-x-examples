package com.bloxbean.yano.examples.disbursement;

import com.fasterxml.jackson.databind.JsonNode;
import org.yanoproject.x.client.Hex;
import org.yanoproject.x.roles.contracts.ActorStatementV1;
import org.yanoproject.x.roles.contracts.ApprovalProposalV1;
import org.yanoproject.x.roles.contracts.SignedActorCommandV1;

import java.util.Locale;
import java.util.Optional;

/**
 * Opening a milestone payout for review, and reviewing it.
 *
 * <p>What is signed is the payout transaction's id. Everything else — the
 * milestone label, the amount, the payee — is derivable from the transaction
 * the id refers to, so there is nothing to keep in sync.
 */
public final class Milestones {

    /** Names the byte contract: this hash is a Cardano transaction id. */
    public static final String PAYLOAD_DOMAIN = "org.cardano.transaction.id.v1";

    private static final long DEADLINE_BLOCKS = 9_000;

    private final Chain chain;
    private final Registry registry;

    public Milestones(Chain chain, Registry registry) {
        this.chain = chain;
        this.registry = registry;
    }

    public static String proposalId(String milestoneId) {
        return milestoneId.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9-]", "-");
    }

    /** Open the payout for review. The payload hash is the transaction id. */
    public String propose(Cast.Actor proposer, Treasury.Prepared payout, int viaMember) {
        long revision = requireRegistered(proposer);
        ActorStatementV1 statement = new ActorStatementV1(
                ActorStatementV1.Action.PROPOSE, Chain.CHAIN_ID,
                proposalId(payout.milestoneId()), Policies.MILESTONE_PAYOUT,
                policyRevision(), PAYLOAD_DOMAIN, payout.payloadHash(),
                chain.tipHeight() + DEADLINE_BLOCKS,
                proposer.id(), revision, proposer.keyId(), "");
        return submit(statement, proposer, viaMember);
    }

    /** Cast a review decision on an open payout. */
    public String review(Cast.Actor actor, String milestoneId,
                         ActorStatementV1.Action action, int viaMember) {
        long revision = requireRegistered(actor);
        ApprovalProposalV1 proposal = proposal(milestoneId).orElseThrow(
                () -> new IllegalStateException("no open review for " + milestoneId
                        + " — run `disburse propose` first"));

        String clause = Policies.clauseFor(Policies.MILESTONE_PAYOUT, actor);
        if (clause == null) {
            throw new IllegalArgumentException(actor.displayName() + " holds roles "
                    + actor.roles() + " and cannot review a payout");
        }

        ActorStatementV1 statement = new ActorStatementV1(
                action, Chain.CHAIN_ID, proposal.proposalId(), proposal.policyId(),
                proposal.policyRevision(), proposal.payloadDomain(), proposal.payloadHash(),
                proposal.deadlineHeight(), actor.id(), revision, actor.keyId(), clause);
        return submit(statement, actor, viaMember);
    }

    private String submit(ActorStatementV1 statement, Cast.Actor actor, int viaMember) {
        byte[] command = SignedActorCommandV1.sign(statement, actor.demoSeed()).encode();
        String messageId = chain.submit(viaMember, Chain.ROLE_TOPIC, command);
        chain.awaitFinalized(messageId);
        return messageId;
    }

    public Optional<ApprovalProposalV1> proposal(String milestoneId) {
        JsonNode record = chain.proposal(proposalId(milestoneId));
        if (record == null) {
            return Optional.empty();
        }
        String hex = record.path("recordValue").asText(null);
        return hex == null ? Optional.empty() : Optional.of(ApprovalProposalV1.decode(Hex.decode(hex)));
    }

    /**
     * The gate before money moves.
     *
     * <p>Two separate questions, and both must hold: is there a terminal
     * APPROVED decision, and does it name <em>this</em> transaction? A payout
     * authorized for a different transaction is not authorization for this one.
     */
    public void requireAuthorized(Treasury.Prepared payout) {
        ApprovalProposalV1 proposal = proposal(payout.milestoneId()).orElseThrow(
                () -> new IllegalStateException("no review has been opened for "
                        + payout.milestoneId() + " — nothing authorizes this payout"));

        if (proposal.status() != ApprovalProposalV1.ProposalStatus.APPROVED) {
            throw new IllegalStateException("the review for " + payout.milestoneId()
                    + " is " + proposal.status() + ", not APPROVED.\n"
                    + "       It still needs " + Policies.describe(Policies.MILESTONE_PAYOUT) + ".");
        }

        String approved = Hex.encode(proposal.payloadHash());
        if (!approved.equals(payout.transactionId())) {
            throw new IllegalStateException("""
                    the approved transaction is not the one about to be submitted.
                           approved : %s
                           prepared : %s
                           Reviewers authorized a different payment. Refusing."""
                    .formatted(approved, payout.transactionId()));
        }
    }

    private long policyRevision() {
        JsonNode record = chain.policyRecord(Policies.MILESTONE_PAYOUT);
        if (record == null || record.path("recordValue").isMissingNode()) {
            throw new IllegalStateException("the payout policy is not registered — "
                    + "run `disburse bootstrap` first");
        }
        return org.yanoproject.x.roles.contracts.ApprovalPolicyV1
                .decode(Hex.decode(record.path("recordValue").asText())).revision();
    }

    private long requireRegistered(Cast.Actor actor) {
        long revision = registry.actorRevision(actor.id());
        if (revision < 1) {
            throw new IllegalStateException(actor.displayName()
                    + " is not in the registry — run `disburse bootstrap`");
        }
        return revision;
    }
}
