package com.bloxbean.yano.examples.batchrelease;

import org.yanoproject.x.roles.contracts.ApprovalPolicyV1;
import org.yanoproject.x.roles.contracts.RecordStatus;

import java.util.List;

/**
 * The three release stages, as policies.
 *
 * <p>A policy is a bounded <b>AND of clauses</b>. Every clause must be
 * satisfied for the proposal to become APPROVED. A clause names a role, how
 * many decisions it needs, and what makes two decisions count as different.
 *
 * <p>That last part is the interesting one, and both modes are used here for
 * reasons that come from the domain rather than from the framework:
 *
 * <ul>
 *   <li>{@code DistinctBy.ACTOR} — two different <em>people</em>. Same employer
 *       is fine. This is the four-eyes check inside one laboratory.</li>
 *   <li>{@code DistinctBy.ORGANIZATION} — two different <em>firms</em>. Two
 *       signatures from the same company satisfy it once, not twice. This is
 *       what "independent review" has to mean if it is to mean anything.</li>
 * </ul>
 *
 * <p>Note what a policy cannot say: there is no ordering between clauses and no
 * dependency between policies. Sequencing is handled by chaining payloads
 * across stages — see {@link BatchRecord}.
 */
public final class Policies {

    /** Stage 1 — Quality Control: release testing, signed by two analysts. */
    public static final String QC_RESULTS = "qc-results";
    /** Stage 2 — Quality Assurance: deviations and batch-record review. */
    public static final String QA_REVIEW = "qa-review";
    /** Stage 3 — Qualified Person certification plus independent review. */
    public static final String QP_RELEASE = "qp-release";

    /** Clause ids. An actor names the clause its decision is cast under. */
    public static final String CLAUSE_QC = "qc-testing";
    public static final String CLAUSE_QA = "qa-review";
    public static final String CLAUSE_QP = "qp-certification";
    public static final String CLAUSE_INDEPENDENT = "independent-review";

    /**
     * How long a proposal may stay open, in BLOCKS. At this chain's 200ms
     * cadence that is about an hour — chosen so a stage cannot expire while a
     * presenter is paused mid-walkthrough. A real deployment would size this
     * against its own block interval and how long a sign-off realistically
     * takes.
     */
    private static final long MAX_LIFETIME_BLOCKS = 18_000;

    private Policies() {
    }

    public static List<ApprovalPolicyV1> all() {
        return List.of(qcResults(), qaReview(), qpRelease());
    }

    /**
     * Two Quality Control analysts must sign, and they must be two different
     * people. Both work for the manufacturer — that is expected, and
     * {@code DistinctBy.ACTOR} is what says so.
     */
    public static ApprovalPolicyV1 qcResults() {
        return new ApprovalPolicyV1(QC_RESULTS, 1, RecordStatus.ACTIVE,
                List.of(Cast.ROLE_COORDINATOR),
                List.of(new ApprovalPolicyV1.RequiredClause(
                        CLAUSE_QC, Cast.ROLE_QC, 2, ApprovalPolicyV1.DistinctBy.ACTOR)),
                ApprovalPolicyV1.RejectionMode.ANY_ELIGIBLE, MAX_LIFETIME_BLOCKS);
    }

    /** One Quality Assurance reviewer signs off the batch record. */
    public static ApprovalPolicyV1 qaReview() {
        return new ApprovalPolicyV1(QA_REVIEW, 1, RecordStatus.ACTIVE,
                List.of(Cast.ROLE_COORDINATOR),
                List.of(new ApprovalPolicyV1.RequiredClause(
                        CLAUSE_QA, Cast.ROLE_QA, 1, ApprovalPolicyV1.DistinctBy.ACTOR)),
                ApprovalPolicyV1.RejectionMode.ANY_ELIGIBLE, MAX_LIFETIME_BLOCKS);
    }

    /**
     * The Qualified Person certifies, and two auditors from <em>distinct
     * organizations</em> review independently. Two auditors from the same firm
     * count once against that clause, so the proposal stays pending.
     */
    public static ApprovalPolicyV1 qpRelease() {
        return new ApprovalPolicyV1(QP_RELEASE, 1, RecordStatus.ACTIVE,
                List.of(Cast.ROLE_COORDINATOR),
                List.of(
                        new ApprovalPolicyV1.RequiredClause(
                                CLAUSE_QP, Cast.ROLE_QP, 1, ApprovalPolicyV1.DistinctBy.ACTOR),
                        new ApprovalPolicyV1.RequiredClause(
                                CLAUSE_INDEPENDENT, Cast.ROLE_AUDITOR, 2,
                                ApprovalPolicyV1.DistinctBy.ORGANIZATION)),
                ApprovalPolicyV1.RejectionMode.ANY_ELIGIBLE, MAX_LIFETIME_BLOCKS);
    }

    /** Human-readable description of what a stage needs, for the CLI. */
    public static String describe(String policyId) {
        return switch (policyId) {
            case QC_RESULTS -> "2 QC analysts, two different people";
            case QA_REVIEW -> "1 QA reviewer";
            case QP_RELEASE -> "1 Qualified Person + 2 auditors from different organizations";
            default -> policyId;
        };
    }

    /** Which clause an actor's role lets them sign under, for a given stage. */
    public static String clauseFor(String policyId, Cast.Actor actor) {
        return switch (policyId) {
            case QC_RESULTS -> actor.hasRole(Cast.ROLE_QC) ? CLAUSE_QC : null;
            case QA_REVIEW -> actor.hasRole(Cast.ROLE_QA) ? CLAUSE_QA : null;
            case QP_RELEASE -> actor.hasRole(Cast.ROLE_QP) ? CLAUSE_QP
                    : actor.hasRole(Cast.ROLE_AUDITOR) ? CLAUSE_INDEPENDENT : null;
            default -> null;
        };
    }
}
