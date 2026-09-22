package com.bloxbean.yano.examples.disbursement;

import org.yanoproject.x.client.Hex;
import org.yanoproject.x.roles.contracts.ActorRecordV1;
import org.yanoproject.x.roles.contracts.ActorStatementV1;
import org.yanoproject.x.roles.contracts.ApprovalProposalV1;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;

/**
 * Catalyst-style milestone disbursement — Yano X example 04.
 *
 * <pre>
 *   disburse bootstrap                     register reviewers and the payout policy
 *   disburse cast                          who reviews, and what a payout needs
 *   disburse treasury [--fund &lt;ada&gt;]       the fund's Cardano address and balance
 *
 *   disburse prepare &lt;milestone&gt; --to &lt;addr&gt; --ada &lt;n&gt;   build the payout transaction
 *   disburse propose &lt;milestone&gt;                        open it for review
 *   disburse review  &lt;milestone&gt; --actor &lt;a&gt; [--via N]   approve it
 *   disburse execute &lt;milestone&gt;                        verify, sign, submit to Cardano
 *   disburse show    &lt;milestone&gt;                        review status and the payout
 *   disburse tamper  &lt;milestone&gt; --ada &lt;n&gt;              alter the payout after approval
 * </pre>
 */
public final class DisbursementApp {

    private final Chain chain = new Chain(3);
    private final Registry registry = new Registry(chain);
    private final Milestones milestones = new Milestones(chain, registry);
    private final Treasury treasury = new Treasury(chain);

    public static void main(String[] args) {
        if (args.length == 0 || args[0].equals("help") || args[0].equals("--help")) {
            usage();
            System.exit(args.length == 0 ? 1 : 0);
        }
        try {
            new DisbursementApp().run(args[0],
                    new ArrayDeque<>(List.of(args).subList(1, args.length)));
        } catch (IllegalArgumentException | IllegalStateException failure) {
            System.err.println("\nerror: " + failure.getMessage());
            System.exit(2);
        }
    }

    private void run(String command, Deque<String> rest) {
        switch (command) {
            case "bootstrap" -> bootstrap();
            case "cast" -> cast();
            case "treasury" -> treasury(Options.parse(rest));
            case "prepare" -> prepare(require(rest.poll(), "prepare needs a milestone id"),
                    Options.parse(rest));
            case "propose" -> propose(require(rest.poll(), "propose needs a milestone id"),
                    Options.parse(rest));
            case "review" -> review(require(rest.poll(), "review needs a milestone id"),
                    Options.parse(rest), ActorStatementV1.Action.APPROVE);
            case "reject" -> review(require(rest.poll(), "reject needs a milestone id"),
                    Options.parse(rest), ActorStatementV1.Action.REJECT);
            case "execute" -> execute(require(rest.poll(), "execute needs a milestone id"));
            case "show" -> show(require(rest.poll(), "show needs a milestone id"));
            case "tamper" -> tamper(require(rest.poll(), "tamper needs a milestone id"),
                    Options.parse(rest));
            default -> {
                System.err.println("unknown command: " + command);
                usage();
                System.exit(1);
            }
        }
    }

    // ----------------------------------------------------------- registry

    private void bootstrap() {
        if (registry.isBootstrapped()) {
            System.out.println("Already bootstrapped. `disburse cast` shows the reviewers.");
            return;
        }
        System.out.println("""
                Registering the reviewers and the payout policy.

                The app-chain members govern this registry, so each change is proposed by
                one member, approved by another to reach the threshold, then activated.
                """);
        registry.apply(registry.genesisChanges(), step -> System.out.println("  " + step));

        long registered = Cast.genesisActors().stream()
                .filter(actor -> registry.actorRevision(actor.id()) >= 1).count();
        System.out.printf("%nRegistered %d of %d people.%n", registered, Cast.ACTORS.size());
        if (registered != Cast.ACTORS.size()) {
            throw new IllegalStateException("bootstrap did not complete — check ./cluster logs 0");
        }
    }

    private void cast() {
        System.out.println("Organizations\n");
        Cast.ORGANIZATIONS.forEach(org ->
                System.out.printf("  %-22s %-24s %s%n", org.id(), org.displayName(), org.about()));

        System.out.println("\nPeople — none of these are app-chain members\n");
        System.out.printf("  %-16s %-24s %-22s %-10s %s%n",
                "ACTOR", "NAME", "ORGANIZATION", "ROLE", "REGISTRY");
        for (Cast.Actor actor : Cast.ACTORS) {
            ActorRecordV1 record = registry.actorRevision(actor.id()) >= 1
                    ? registry.actor(actor.id()) : null;
            System.out.printf("  %-16s %-24s %-22s %-10s %s%n",
                    actor.id(), actor.displayName(), actor.organizationId(),
                    String.join(",", actor.roles()),
                    record == null ? "not registered"
                            : "revision " + record.revision() + ", " + record.status());
        }
        System.out.printf("%nA payout needs: %s%n",
                Policies.describe(Policies.MILESTONE_PAYOUT));
        System.out.println("Omar and Quinn are both Guild North, so they count as one.");
    }

    private void treasury(Options options) {
        String address = treasury.treasuryAddress();
        if (options.orDefault("fund", null) != null) {
            System.out.printf("Funding the treasury with %s ada from the devnet faucet%n%n",
                    options.orDefault("fund", "0"));
            System.out.println("  " + treasury.fundTreasury(Long.parseLong(options.orDefault("fund", "0"))));
            Chain.sleep(2000);
        }
        long balance = treasury.balanceLovelace(address);
        System.out.println("\nFund treasury (Cardano)\n");
        System.out.printf("  address   %s%n", address);
        System.out.printf("  balance   %s ada%n", balance < 0 ? "unknown"
                : java.math.BigDecimal.valueOf(balance, 6).toPlainString());
    }

    // ------------------------------------------------------------- payouts

    private void prepare(String milestoneId, Options options) {
        String payee = options.required("to");
        long lovelace = (long) (Double.parseDouble(options.required("ada")) * 1_000_000L);

        Treasury.Prepared payout = treasury.prepare(milestoneId, payee, lovelace);

        System.out.printf("Prepared the payout for %s%n%n", milestoneId);
        System.out.printf("  payee            %s%n", payout.payee());
        System.out.printf("  amount           %s ada%n", payout.amountAda());
        System.out.printf("  transaction id   %s%n", payout.transactionId());
        System.out.println("""

                  That id is the Blake2b-256 hash of the transaction body, and it is what
                  reviewers will authorize. The transaction is NOT signed yet — the
                  treasury key is applied only after approval.""");
    }

    private void propose(String milestoneId, Options options) {
        Treasury.Prepared payout = treasury.load(milestoneId);
        int via = Integer.parseInt(options.orDefault("via", "0"));

        System.out.printf("Opening %s for review%n%n", milestoneId);
        System.out.printf("  payout           %s ada to %s%n",
                payout.amountAda(), payout.payee().substring(0, 24) + "…");
        System.out.printf("  payload domain   %s%n", Milestones.PAYLOAD_DOMAIN);
        System.out.printf("  payload hash     %s%n", payout.transactionId());
        System.out.printf("  opened by        %s%n", Cast.actor("proposer-nia").displayName());

        milestones.propose(Cast.actor("proposer-nia"), payout, via);
        ApprovalProposalV1 proposal = milestones.proposal(milestoneId).orElseThrow(
                () -> new IllegalStateException("the review was not opened — "
                        + "check that the proposer holds a proposer role"));
        System.out.printf("%n  status           %s — needs %s%n",
                proposal.status(), Policies.describe(Policies.MILESTONE_PAYOUT));
    }

    private void review(String milestoneId, Options options, ActorStatementV1.Action action) {
        Cast.Actor actor = Cast.actor(options.required("actor"));
        int via = Integer.parseInt(options.orDefault("via", "0"));

        System.out.printf("%s %s as %s%n", action == ActorStatementV1.Action.APPROVE
                ? "Approving" : "Rejecting", milestoneId, actor.displayName());
        System.out.printf("  actor key    %s…  (the node never sees the private half)%n",
                actor.publicKeyHex().substring(0, 24));
        System.out.printf("  relayed by   member %d%n", via);

        milestones.review(actor, milestoneId, action, via);
        ApprovalProposalV1 after = milestones.proposal(milestoneId).orElseThrow();

        System.out.printf("%n  status       %s%n", after.status());
        System.out.printf("  accepted     %d decision(s)%n", after.decisions().size());
        for (ApprovalProposalV1.AcceptedDecisionV1 decision : after.decisions()) {
            System.out.printf("                 %-16s %-22s %s%n",
                    decision.actorId(), decision.organizationId(), decision.role());
        }
        if (after.status() == ApprovalProposalV1.ProposalStatus.PENDING) {
            long organizations = after.decisions().stream()
                    .map(ApprovalProposalV1.AcceptedDecisionV1::organizationId).distinct().count();
            System.out.printf("%n  Still pending — needs %s.%n",
                    Policies.describe(Policies.MILESTONE_PAYOUT));
            if (organizations == 1 && after.decisions().size() >= 1) {
                System.out.println("  So far only ONE organization has reviewed. A second reviewer");
                System.out.println("  from the SAME organization does not move this forward.");
            }
        }
    }

    /**
     * The whole point of the example: verify, then pay.
     */
    private void execute(String milestoneId) {
        Treasury.Prepared payout = treasury.load(milestoneId);

        System.out.printf("Executing the payout for %s%n%n", milestoneId);
        System.out.printf("  prepared transaction   %s%n", payout.transactionId());
        System.out.printf("  amount                 %s ada%n", payout.amountAda());
        System.out.println();

        // Refuses unless the chain holds a terminal APPROVED decision naming
        // exactly this transaction id.
        milestones.requireAuthorized(payout);
        System.out.println("  [ok  ] a terminal APPROVED review exists");
        System.out.println("  [ok  ] the approved hash is exactly this transaction id");

        String submitted = treasury.signAndSubmit(payout);
        System.out.println("  [ok  ] signing did not change the transaction id");
        System.out.printf("  [ok  ] Cardano accepted it%n%n");

        System.out.printf("  on-chain transaction   %s%n", submitted);
        System.out.printf("  approved hash          %s%n", payout.transactionId());
        System.out.printf("  IDENTICAL              %s%n%n",
                submitted.equals(payout.transactionId()) ? "yes" : "NO — investigate");
        System.out.println("""
                  Anyone can now look that id up on Cardano and check it against the
                  approval record on the app chain. Neither side has to be trusted:
                  a transaction id IS the hash of the transaction body.""");
    }

    private void show(String milestoneId) {
        System.out.printf("Milestone %s%n%n", milestoneId);
        try {
            Treasury.Prepared payout = treasury.load(milestoneId);
            System.out.printf("  prepared payout  %s ada -> %s…%n",
                    payout.amountAda(), payout.payee().substring(0, 24));
            System.out.printf("  transaction id   %s%n", payout.transactionId());
            System.out.printf("  on chain         %s%n",
                    treasury.isOnChain(payout.transactionId()) ? "yes" : "not yet");
        } catch (IllegalStateException notPrepared) {
            System.out.println("  no prepared payout");
        }

        var proposal = milestones.proposal(milestoneId);
        if (proposal.isEmpty()) {
            System.out.println("  review           not opened");
            return;
        }
        ApprovalProposalV1 found = proposal.orElseThrow();
        System.out.printf("%n  review status    %s%n", found.status());
        System.out.printf("  approved hash    %s%n", Hex.encode(found.payloadHash()));
        System.out.printf("  opened by        %s at height %d%n",
                found.proposerActorId(), found.createdHeight());
        for (ApprovalProposalV1.AcceptedDecisionV1 decision : found.decisions()) {
            System.out.printf("    %-8s %-16s %-22s rev=%d height=%d%n",
                    decision.action(), decision.actorId(), decision.organizationId(),
                    decision.actorRevision(), decision.acceptedHeight());
        }
    }

    /** Swap the prepared payout for a different one, after it was approved. */
    private void tamper(String milestoneId, Options options) {
        Treasury.Prepared before = treasury.load(milestoneId);
        long lovelace = (long) (Double.parseDouble(options.required("ada")) * 1_000_000L);

        Treasury.Prepared after = treasury.tamper(milestoneId, lovelace);
        System.out.printf("Replaced the prepared payout for %s%n%n", milestoneId);
        System.out.printf("  was   %s ada   transaction %s%n", before.amountAda(), before.transactionId());
        System.out.printf("  now   %s ada   transaction %s%n", after.amountAda(), after.transactionId());
        System.out.println("\n  The reviewers approved the first id. Try `disburse execute`.");
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
                Catalyst-style milestone disbursement — Yano X example 04

                  disburse bootstrap                        register reviewers and the policy
                  disburse cast                             who reviews, and what a payout needs
                  disburse treasury [--fund <ada>]          the fund's Cardano address and balance

                  disburse prepare <milestone> --to <addr> --ada <n>
                  disburse propose <milestone> [--via N]
                  disburse review  <milestone> --actor <actor> [--via N]
                  disburse reject  <milestone> --actor <actor>
                  disburse execute <milestone>
                  disburse show    <milestone>
                  disburse tamper  <milestone> --ada <n>    alter the payout after approval

                What reviewers sign is the payout transaction's id, which IS the hash of
                its body — so the approval names exactly one payment.

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
