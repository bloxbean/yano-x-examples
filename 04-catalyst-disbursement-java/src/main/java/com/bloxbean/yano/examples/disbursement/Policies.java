package com.bloxbean.yano.examples.disbursement;

import org.yanoproject.x.roles.contracts.ApprovalPolicyV1;
import org.yanoproject.x.roles.contracts.RecordStatus;

import java.util.List;

/**
 * One policy: a milestone payout needs two reviewers from <em>distinct
 * organizations</em>.
 *
 * <p>{@code DistinctBy.ORGANIZATION} is the whole control here. Money moves on
 * this decision, so two reviewers from the same guild must not be able to
 * release it between them — the clause counts organizations, not signatures.
 */
public final class Policies {

    public static final String MILESTONE_PAYOUT = "milestone-payout";
    public static final String CLAUSE_REVIEW = "milestone-review";

    /** ~1 hour at this chain's 200ms blocks. */
    private static final long MAX_LIFETIME_BLOCKS = 18_000;

    private Policies() {
    }

    public static List<ApprovalPolicyV1> all() {
        return List.of(milestonePayout());
    }

    public static ApprovalPolicyV1 milestonePayout() {
        return new ApprovalPolicyV1(MILESTONE_PAYOUT, 1, RecordStatus.ACTIVE,
                List.of(Cast.ROLE_PROPOSER),
                List.of(new ApprovalPolicyV1.RequiredClause(
                        CLAUSE_REVIEW, Cast.ROLE_REVIEWER, 2,
                        ApprovalPolicyV1.DistinctBy.ORGANIZATION)),
                ApprovalPolicyV1.RejectionMode.ANY_ELIGIBLE, MAX_LIFETIME_BLOCKS);
    }

    public static String describe(String policyId) {
        return "2 reviewers from different organizations";
    }

    public static String clauseFor(String policyId, Cast.Actor actor) {
        return actor.hasRole(Cast.ROLE_REVIEWER) ? CLAUSE_REVIEW : null;
    }
}
