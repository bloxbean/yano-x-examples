package com.bloxbean.yano.examples.batchrelease;

import com.fasterxml.jackson.databind.JsonNode;
import org.yanoproject.x.client.Hex;
import org.yanoproject.x.roles.contracts.ActorStatementV1;
import org.yanoproject.x.roles.contracts.ApprovalProposalV1;
import org.yanoproject.x.roles.contracts.SignedActorCommandV1;

import java.util.Optional;

/**
 * Opening a stage and casting decisions on it.
 *
 * <p>Every command here is relayed by a member node and <em>authorized</em> by
 * an actor signature inside it. The member is a courier. Change which member
 * relays a decision and nothing about the decision changes — that is the point
 * the example exists to make.
 *
 * <p>A signed statement binds the chain, the proposal, the policy revision, the
 * payload domain and hash, the deadline, the actor revision, the key and the
 * clause. So a signature cannot be lifted onto a different batch, a different
 * stage, a later policy revision, or a different clause.
 */
public final class Stages {

    /** ~30 minutes at this chain's 200ms blocks, inside the policy maximum. */
    private static final long DEADLINE_BLOCKS = 9_000;

    private final Chain chain;
    private final Registry registry;

    public Stages(Chain chain, Registry registry) {
        this.chain = chain;
        this.registry = registry;
    }

    // ------------------------------------------------------------- opening

    /**
     * Open a stage. Only an actor holding a role in the policy's
     * {@code proposerRoles} may do this — here, the batch coordinator.
     */
    public String propose(Cast.Actor proposer, BatchRecord record, int viaMember) {
        long revision = requireRegistered(proposer);
        ActorStatementV1 statement = new ActorStatementV1(
                ActorStatementV1.Action.PROPOSE,
                Chain.CHAIN_ID,
                record.proposalId(),
                record.stage().policyId,
                policyRevision(record.stage().policyId),
                record.payloadDomain(),
                record.payloadHash(),
                chain.tipHeight() + DEADLINE_BLOCKS,
                proposer.id(),
                revision,
                proposer.keyId(),
                "");                       // PROPOSE carries no clause
        return submit(statement, proposer, viaMember);
    }

    // ------------------------------------------------------------ deciding

    /**
     * Cast a decision on an open stage.
     *
     * <p>The statement copies the proposal's own policy revision, payload and
     * deadline, so the signature is bound to exactly the proposal on the chain
     * rather than to whatever the caller believed it was signing.
     */
    public String decide(Cast.Actor actor, BatchRecord record, ActorStatementV1.Action action,
                         int viaMember) {
        long revision = requireRegistered(actor);
        ApprovalProposalV1 proposal = proposal(record.proposalId()).orElseThrow(
                () -> new IllegalStateException("no open proposal " + record.proposalId()
                        + " — open the stage first"));

        String clause = Policies.clauseFor(record.stage().policyId, actor);
        if (clause == null) {
            // The chain would treat this as a deterministic no-op. Saying so
            // here is friendlier than letting it vanish silently.
            throw new IllegalArgumentException(actor.displayName() + " holds roles "
                    + actor.roles() + ", none of which can sign "
                    + record.stage().policyId + " (" + Policies.describe(record.stage().policyId) + ")");
        }

        ActorStatementV1 statement = new ActorStatementV1(
                action, Chain.CHAIN_ID, proposal.proposalId(), proposal.policyId(),
                proposal.policyRevision(), proposal.payloadDomain(), proposal.payloadHash(),
                proposal.deadlineHeight(), actor.id(), revision, actor.keyId(), clause);
        return submit(statement, actor, viaMember);
    }

    private String submit(ActorStatementV1 statement, Cast.Actor actor, int viaMember) {
        // In production the seed lives in the actor's own signer, KMS or HSM and
        // the node never sees it. Here it is derived from the actor id so the
        // example is reproducible — see Cast.
        byte[] command = SignedActorCommandV1.sign(statement, actor.demoSeed()).encode();
        String messageId = chain.submit(viaMember, Chain.ROLE_TOPIC, command);
        chain.awaitFinalized(messageId);
        return messageId;
    }

    // -------------------------------------------------------------- reading

    public Optional<ApprovalProposalV1> proposal(String proposalId) {
        JsonNode record = chain.proposal(proposalId);
        if (record == null) {
            return Optional.empty();
        }
        String hex = record.path("recordValue").asText(null);
        return hex == null ? Optional.empty()
                : Optional.of(ApprovalProposalV1.decode(Hex.decode(hex)));
    }

    /** True when the stage reached its terminal APPROVED state. */
    public boolean isApproved(String batchId, BatchRecord.Stage stage) {
        return proposal(BatchRecord.proposalId(batchId, stage))
                .map(found -> found.status() == ApprovalProposalV1.ProposalStatus.APPROVED)
                .orElse(false);
    }

    /**
     * Build the record for a stage, chaining it to the previous one.
     *
     * <p>This is where the application enforces the ordering the policy cannot:
     * a later stage refuses to be built until the stage before it is terminal.
     */
    public BatchRecord recordFor(String batchId, String product, BatchRecord.Stage stage,
                                 String summary) {
        BatchRecord.Stage previous = stage.previous();
        if (previous == null) {
            return new BatchRecord(batchId, product, stage, summary, null, null);
        }

        String priorId = BatchRecord.proposalId(batchId, previous);
        ApprovalProposalV1 prior = proposal(priorId).orElseThrow(() -> new IllegalStateException(
                stage.description + " cannot start: " + previous.description
                        + " has not been opened for " + batchId));

        if (prior.status() != ApprovalProposalV1.ProposalStatus.APPROVED) {
            throw new IllegalStateException(
                    stage.description + " cannot start: " + previous.description
                            + " is " + prior.status() + ", not APPROVED.\n"
                            + "       " + priorId + " still needs "
                            + Policies.describe(previous.policyId));
        }
        return new BatchRecord(batchId, product, stage, summary,
                priorId, Hex.encode(prior.payloadHash()));
    }

    private long policyRevision(String policyId) {
        JsonNode record = chain.policyRecord(policyId);
        if (record == null || record.path("recordValue").isMissingNode()) {
            throw new IllegalStateException("policy " + policyId
                    + " is not registered — run `batch bootstrap` first");
        }
        return org.yanoproject.x.roles.contracts.ApprovalPolicyV1
                .decode(Hex.decode(record.path("recordValue").asText())).revision();
    }

    private long requireRegistered(Cast.Actor actor) {
        long revision = registry.actorRevision(actor.id());
        if (revision < 1) {
            throw new IllegalStateException(actor.displayName() + " is not in the registry — "
                    + "run `batch bootstrap`, or `batch onboard " + actor.id() + "`");
        }
        return revision;
    }
}
