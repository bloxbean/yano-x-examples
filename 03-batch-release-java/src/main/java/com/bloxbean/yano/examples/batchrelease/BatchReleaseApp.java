package com.bloxbean.yano.examples.batchrelease;

import org.yanoproject.x.client.Hex;
import org.yanoproject.x.roles.contracts.ActorRecordV1;
import org.yanoproject.x.roles.contracts.ActorStatementV1;
import org.yanoproject.x.roles.contracts.ApprovalProposalV1;
import org.yanoproject.x.roles.contracts.RecordStatus;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Pharmaceutical batch release — Yano X example 03.
 *
 * <pre>
 *   batch bootstrap                              register organizations, people, policies
 *   batch cast                                   who exists and what they may sign
 *   batch open    &lt;batch&gt; --stage &lt;s&gt;            open a release stage
 *   batch sign    &lt;batch&gt; --stage &lt;s&gt; --actor &lt;a&gt; [--via N]   approve it
 *   batch reject  &lt;batch&gt; --stage &lt;s&gt; --actor &lt;a&gt;
 *   batch show    &lt;batch&gt; [--stage &lt;s&gt;]          status and decision trail
 *   batch replace --leaving &lt;a&gt; --joining &lt;a&gt;    hand a role to a successor
 *   batch onboard &lt;actor&gt;                        add a person
 *   batch offboard &lt;actor&gt;                       revoke a person
 *   batch anchor                                 Cardano L1 anchor state
 * </pre>
 */
public final class BatchReleaseApp {

    private static final int MEMBERS = 3;

    private final Chain chain = new Chain(MEMBERS);
    private final Registry registry = new Registry(chain);
    private final Stages stages = new Stages(chain, registry);

    public static void main(String[] args) {
        if (args.length == 0 || args[0].equals("help") || args[0].equals("--help")) {
            usage();
            System.exit(args.length == 0 ? 1 : 0);
        }
        try {
            new BatchReleaseApp().run(args[0], new ArrayDeque<>(List.of(args).subList(1, args.length)));
        } catch (IllegalArgumentException | IllegalStateException failure) {
            System.err.println("\nerror: " + failure.getMessage());
            System.exit(2);
        }
    }

    private void run(String command, Deque<String> rest) {
        switch (command) {
            case "bootstrap" -> bootstrap();
            case "cast" -> cast();
            case "open" -> open(require(rest.poll(), "open needs a batch id"), Options.parse(rest));
            case "sign" -> decide(require(rest.poll(), "sign needs a batch id"),
                    Options.parse(rest), ActorStatementV1.Action.APPROVE);
            case "reject" -> decide(require(rest.poll(), "reject needs a batch id"),
                    Options.parse(rest), ActorStatementV1.Action.REJECT);
            case "show" -> show(require(rest.poll(), "show needs a batch id"), Options.parse(rest));
            case "replace" -> replace(Options.parse(rest));
            case "onboard" -> onboard(Cast.actor(require(rest.poll(), "onboard needs an actor id")));
            case "offboard" -> offboard(Cast.actor(require(rest.poll(), "offboard needs an actor id")));
            case "anchor" -> anchor();
            default -> {
                System.err.println("unknown command: " + command);
                usage();
                System.exit(1);
            }
        }
    }

    // ----------------------------------------------------------- bootstrap

    private void bootstrap() {
        if (registry.isBootstrapped()) {
            System.out.println("Registry is already bootstrapped. `batch cast` shows it.");
            return;
        }
        System.out.println("""
                Registering the cast.

                The app-chain members govern this registry — the role-approvals profile
                derives its administrators from the genesis membership epoch. So every
                change below is proposed by one member, approved by another to reach the
                2-of-3 threshold, and then activated.
                """);

        List<Registry.Change> changes = registry.genesisChanges();
        System.out.println("  " + changes.size() + " changes: "
                + Cast.ORGANIZATIONS.size() + " organizations, "
                + Cast.genesisActors().size() + " people, "
                + Policies.all().size() + " policies\n");
        registry.apply(changes, step -> System.out.println("  " + step));

        long registered = Cast.genesisActors().stream()
                .filter(actor -> registry.actorRevision(actor.id()) >= 1).count();
        System.out.printf("%nRegistered %d of %d people.%n", registered, Cast.genesisActors().size());
        if (registered != Cast.genesisActors().size()) {
            throw new IllegalStateException("bootstrap did not complete — check ./cluster logs 0");
        }
        System.out.println("Run `batch cast` to see who can sign what.");
    }

    private void cast() {
        System.out.println("Organizations\n");
        for (Cast.Organization org : Cast.ORGANIZATIONS) {
            System.out.printf("  %-18s %-22s %s%n", org.id(), org.displayName(), org.about());
        }

        System.out.println("\nPeople — none of these are app-chain members\n");
        System.out.printf("  %-18s %-26s %-18s %-18s %s%n",
                "ACTOR", "NAME", "ORGANIZATION", "ROLE", "REGISTRY");
        for (Cast.Actor actor : Cast.ACTORS) {
            long revision = registry.actorRevision(actor.id());
            ActorRecordV1 record = revision >= 1 ? registry.actor(actor.id()) : null;
            String state = record == null ? "not registered"
                    : "revision " + record.revision() + ", " + record.status();
            System.out.printf("  %-18s %-26s %-18s %-18s %s%n",
                    actor.id(), actor.displayName(), actor.organizationId(),
                    String.join(",", actor.roles()), state);
        }

        System.out.println("\nRelease stages\n");
        for (BatchRecord.Stage stage : BatchRecord.Stage.values()) {
            System.out.printf("  %d. %-12s %s%n     needs: %s%n",
                    stage.ordinal() + 1, stage.id, stage.description,
                    Policies.describe(stage.policyId));
        }
    }

    // --------------------------------------------------------------- stages

    private void open(String batchId, Options options) {
        BatchRecord.Stage stage = BatchRecord.Stage.of(options.required("stage"));
        String product = options.orDefault("product", "Paracetamol 500mg tablets");
        String summary = options.orDefault("summary", stage.description + " for " + batchId);
        int via = Integer.parseInt(options.orDefault("via", "0"));

        BatchRecord record = stages.recordFor(batchId, product, stage, summary);

        System.out.printf("Opening %s for %s%n%n", stage.description, batchId);
        if (record.priorProposalId() != null) {
            System.out.printf("  chained to  %s%n", record.priorProposalId());
            System.out.printf("  prior hash  %s%n", record.priorPayloadHashHex());
        }
        System.out.printf("  proposal    %s%n", record.proposalId());
        System.out.printf("  domain      %s%n", record.payloadDomain());
        System.out.printf("  payload     %s%n", record.payloadHashHex());
        System.out.printf("  opened by   %s, relayed by member %d%n",
                Cast.actor("coordinator-mira").displayName(), via);

        stages.propose(Cast.actor("coordinator-mira"), record, via);

        ApprovalProposalV1 proposal = stages.proposal(record.proposalId()).orElseThrow(
                () -> new IllegalStateException("the proposal was not accepted — "
                        + "check that the coordinator holds a proposer role"));
        System.out.printf("%n  status      %s — needs %s%n",
                proposal.status(), Policies.describe(stage.policyId));
    }

    private void decide(String batchId, Options options, ActorStatementV1.Action action) {
        BatchRecord.Stage stage = BatchRecord.Stage.of(options.required("stage"));
        Cast.Actor actor = Cast.actor(options.required("actor"));
        int via = Integer.parseInt(options.orDefault("via", "0"));

        ApprovalProposalV1 before = stages.proposal(BatchRecord.proposalId(batchId, stage))
                .orElseThrow(() -> new IllegalStateException(
                        "no open " + stage.id + " stage for " + batchId + " — `batch open` it first"));

        BatchRecord record = new BatchRecord(batchId, "", stage, "", null, null);
        System.out.printf("%s %s as %s%n", action == ActorStatementV1.Action.APPROVE
                ? "Signing" : "Rejecting", before.proposalId(), actor.displayName());
        System.out.printf("  actor key   %s  (the node never sees the private half)%n",
                actor.publicKeyHex().substring(0, 24) + "…");
        System.out.printf("  relayed by  member %d  (irrelevant to the decision)%n", via);

        stages.decide(actor, record, action, via);

        ApprovalProposalV1 after = stages.proposal(before.proposalId()).orElseThrow();
        System.out.printf("%n  status      %s%n", after.status());
        reportProgress(after, stage);
    }

    /** Explain what a pending proposal is still waiting for. */
    private void reportProgress(ApprovalProposalV1 proposal, BatchRecord.Stage stage) {
        Map<String, Long> perClause = new java.util.HashMap<>();
        Set<String> orgsSeen = new HashSet<>();
        for (ApprovalProposalV1.AcceptedDecisionV1 decision : proposal.decisions()) {
            perClause.merge(decision.clauseId(), 1L, Long::sum);
            orgsSeen.add(decision.organizationId());
        }
        System.out.printf("  accepted    %d decision(s)%n", proposal.decisions().size());
        for (ApprovalProposalV1.AcceptedDecisionV1 decision : proposal.decisions()) {
            System.out.printf("                %-16s %-18s %-18s clause=%s%n",
                    decision.actorId(), decision.organizationId(), decision.role(),
                    decision.clauseId());
        }
        if (proposal.status() == ApprovalProposalV1.ProposalStatus.PENDING) {
            System.out.printf("%n  Still pending. This stage needs: %s%n",
                    Policies.describe(stage.policyId));
            if (stage == BatchRecord.Stage.QP && orgsSeen.size() < 2
                    && perClause.getOrDefault(Policies.CLAUSE_INDEPENDENT, 0L) >= 1) {
                System.out.println("  Note: independent review counts DISTINCT ORGANIZATIONS. "
                        + "Two auditors\n        from the same firm satisfy it once.");
            }
            if (stage == BatchRecord.Stage.QC
                    && perClause.getOrDefault(Policies.CLAUSE_QC, 0L) == 1L) {
                System.out.println("  Note: a second, different QC analyst is required.");
            }
        }
    }

    private void show(String batchId, Options options) {
        String only = options.orDefault("stage", null);
        System.out.printf("Batch %s%n%n", batchId);
        for (BatchRecord.Stage stage : BatchRecord.Stage.values()) {
            if (only != null && BatchRecord.Stage.of(only) != stage) {
                continue;
            }
            String proposalId = BatchRecord.proposalId(batchId, stage);
            var found = stages.proposal(proposalId);
            System.out.printf("  %d. %-12s %s%n", stage.ordinal() + 1, stage.id, stage.description);
            if (found.isEmpty()) {
                System.out.println("     not opened\n");
                continue;
            }
            ApprovalProposalV1 proposal = found.orElseThrow();
            System.out.printf("     status   %s%n", proposal.status());
            System.out.printf("     payload  %s%n", Hex.encode(proposal.payloadHash()));
            System.out.printf("     opened   height %d by %s%n",
                    proposal.createdHeight(), proposal.proposerActorId());
            for (ApprovalProposalV1.AcceptedDecisionV1 decision : proposal.decisions()) {
                System.out.printf("       %-8s %-16s %-18s rev=%d key=%s height=%d%n",
                        decision.action(), decision.actorId(), decision.organizationId(),
                        decision.actorRevision(), decision.keyId(), decision.acceptedHeight());
            }
            System.out.println();
        }
    }

    // --------------------------------------------------- people, over time

    /**
     * Hand a role from one person to another, on a running chain.
     *
     * <p>Two governed changes, applied together. The departing actor gets a new
     * revision marked REVOKED; the successor is registered fresh. Nothing that
     * was already approved is touched.
     */
    private void replace(Options options) {
        Cast.Actor leaving = Cast.actor(options.required("leaving"));
        Cast.Actor joining = Cast.actor(options.required("joining"));

        long leavingRevision = registry.actorRevision(leaving.id());
        if (leavingRevision < 1) {
            throw new IllegalStateException(leaving.displayName() + " is not registered");
        }
        System.out.printf("""
                Replacing %s with %s

                  Two governed registry changes, proposed and approved by the members:
                    1. %s -> revision %d, status REVOKED
                    2. %s -> revision 1, status ACTIVE, with proof-of-possession

                  Decisions %s already made stay valid. Revocation blocks future
                  signatures; it cannot rewrite a finalized authorization.
                %n""",
                leaving.displayName(), joining.displayName(),
                leaving.id(), leavingRevision + 1, joining.id(), leaving.displayName());

        registry.apply(List.of(
                        Registry.changeActorStatus(leaving, leavingRevision + 1, RecordStatus.REVOKED),
                        Registry.registerActor(joining)),
                step -> System.out.println("  " + step));

        System.out.println();
        printActorState(leaving);
        printActorState(joining);
    }

    private void onboard(Cast.Actor actor) {
        if (registry.actorRevision(actor.id()) >= 1) {
            throw new IllegalStateException(actor.displayName() + " is already registered");
        }
        System.out.printf("Onboarding %s (%s, %s)%n%n",
                actor.displayName(), actor.organizationId(), String.join(",", actor.roles()));
        registry.apply(List.of(Registry.registerActor(actor)),
                step -> System.out.println("  " + step));
        System.out.println();
        printActorState(actor);
    }

    private void offboard(Cast.Actor actor) {
        long revision = registry.actorRevision(actor.id());
        if (revision < 1) {
            throw new IllegalStateException(actor.displayName() + " is not registered");
        }
        System.out.printf("Revoking %s — revision %d%n%n", actor.displayName(), revision + 1);
        registry.apply(List.of(Registry.changeActorStatus(actor, revision + 1, RecordStatus.REVOKED)),
                step -> System.out.println("  " + step));
        System.out.println();
        printActorState(actor);
    }

    private void printActorState(Cast.Actor actor) {
        ActorRecordV1 record = registry.actor(actor.id());
        System.out.printf("  %-18s %s%n", actor.id(), record == null ? "not registered"
                : "revision " + record.revision() + ", " + record.status()
                  + ", roles " + record.roles());
    }

    // --------------------------------------------------------------- anchor

    private void anchor() {
        var status = chain.anchorStatus();
        System.out.println("Cardano L1 anchoring\n");
        if (status == null || status.isMissingNode() || !status.path("enabled").asBoolean(false)) {
            System.out.println("  Not enabled. Start with:");
            System.out.println("    ./cluster start 3 --anchor-mode metadata");
            return;
        }
        System.out.printf("  enabled           %s%n", status.path("enabled").asBoolean());
        System.out.printf("  anchor wallet     %s%n", status.path("address").asText());
        System.out.printf("  anchored count    %d%n", status.path("anchoredCount").asLong());
        System.out.printf("  last height       %d%n", status.path("lastAnchoredHeight").asLong());
        System.out.printf("  last L1 slot      %d%n", status.path("lastAnchorL1Slot").asLong());
        System.out.printf("  last anchor tx    %s%n", status.path("lastAnchorTx").asText());
        System.out.println("""

                  The state root covering every decision above is now committed in a
                  Cardano transaction. An auditor who trusts Cardano, and nothing else,
                  can bound when these certifications existed.""");

        Set<String> tips = new HashSet<>(chain.memberTips());
        System.out.printf("%n  members agree     %s%n",
                tips.size() == 1 ? "yes — " + tips.iterator().next() : "converging, run again");
    }

    // ----------------------------------------------------------------- CLI

    private static String require(String value, String message) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(message);
        }
        return value;
    }

    private static void usage() {
        System.out.println("""
                Pharmaceutical batch release — Yano X example 03

                  batch bootstrap                           register organizations, people, policies
                  batch cast                                who exists and what they may sign

                  batch open   <batch> --stage <stage> [--via N]
                  batch sign   <batch> --stage <stage> --actor <actor> [--via N]
                  batch reject <batch> --stage <stage> --actor <actor> [--via N]
                  batch show   <batch> [--stage <stage>]

                  batch replace  --leaving <actor> --joining <actor>
                  batch onboard  <actor>
                  batch offboard <actor>

                  batch anchor                              Cardano L1 anchor state

                stages: qc-results (Quality Control)
                        qa-review  (Quality Assurance)
                        qp-release (Qualified Person certification)

                --via picks the member node that relays the command. It never changes
                a decision — the actor signature does.

                The chain must be running: ./cluster start 3 --anchor-mode metadata
                """);
    }

    private record Options(Map<String, String> values) {
        static Options parse(Deque<String> args) {
            Map<String, String> values = new java.util.LinkedHashMap<>();
            while (!args.isEmpty()) {
                String flag = args.poll();
                if (!flag.startsWith("--")) {
                    throw new IllegalArgumentException("unexpected argument: " + flag);
                }
                String value = args.poll();
                if (value == null) {
                    throw new IllegalArgumentException("option " + flag + " needs a value");
                }
                values.put(flag.substring(2), value);
            }
            return new Options(values);
        }

        String required(String name) {
            String value = values.get(name);
            if (value == null) {
                throw new IllegalArgumentException("missing required option --" + name);
            }
            return value;
        }

        String orDefault(String name, String fallback) {
            return values.getOrDefault(name, fallback);
        }
    }
}
