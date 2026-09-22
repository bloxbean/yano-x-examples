package com.bloxbean.yano.examples.auditlog;

import org.yanoproject.x.client.AppChainClient;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Command-line front end for the shared access-change audit log.
 *
 * <pre>
 *   audit-log record grant  --subject bob --resource prod-db --by alice
 *   audit-log record revoke --subject bob --resource prod-db --by alice --node 1
 *   audit-log list   [--limit 20] [--node 0]
 *   audit-log prove  &lt;messageId&gt; [--from 0] [--against 2]
 *   audit-log tips
 * </pre>
 */
public final class AuditLogApp {

    private static final int NODES = 3;
    private static final Duration FINALITY_TIMEOUT = Duration.ofSeconds(30);

    public static void main(String[] args) {
        if (args.length == 0 || "help".equals(args[0]) || "--help".equals(args[0])) {
            usage();
            System.exit(args.length == 0 ? 1 : 0);
        }

        AuditLog log = new AuditLog(NODES);
        Deque<String> rest = new ArrayDeque<>(List.of(args).subList(1, args.length));

        try {
            switch (args[0]) {
                case "record" -> record(log, rest);
                case "list"   -> list(log, rest);
                case "prove"  -> prove(log, rest);
                case "tips"   -> tips(log);
                default -> {
                    System.err.println("unknown command: " + args[0]);
                    usage();
                    System.exit(1);
                }
            }
        } catch (AppChainClient.AppChainClientException unreachable) {
            System.err.println("error: cannot reach the chain — is it running? (./cluster start 3)");
            System.err.println("       " + unreachable.getMessage());
            System.exit(2);
        } catch (RuntimeException failure) {
            System.err.println("error: " + failure.getMessage());
            System.exit(2);
        }
    }

    // --------------------------------------------------------------- record

    private static void record(AuditLog log, Deque<String> args) {
        String action = require(args.poll(), "record needs an action: grant or revoke");
        if (!action.equals("grant") && !action.equals("revoke")) {
            throw new IllegalArgumentException("action must be grant or revoke, not " + action);
        }

        Options options = Options.parse(args);
        String subject = options.required("subject");
        String resource = options.required("resource");
        String actor = options.orDefault("by", "unknown");
        String reason = options.orDefault("reason", "");
        int viaNode = Integer.parseInt(options.orDefault("node", "0"));

        AccessEvent event = AccessEvent.of(action, actor, subject, resource, reason);

        System.out.printf("Submitting via node %d ... ", viaNode);
        System.out.flush();
        AuditLog.Recorded recorded = log.record(event, viaNode, FINALITY_TIMEOUT);

        System.out.println("finalized");
        System.out.printf("  event      %s %s -> %s (%s)%n", action, actor, subject, resource);
        System.out.printf("  messageId  %s%n", recorded.messageId());
        System.out.printf("  position   height %d, index %d%n",
                recorded.record().height(), recorded.record().originalMessageIndex());
        System.out.printf("  submitted  node %d%n", recorded.viaNode());
        System.out.println();
        System.out.println("  Every member now holds this exact record. Prove it:");
        System.out.printf("    audit-log prove %s%n", recorded.messageId());
    }

    // ----------------------------------------------------------------- list

    private static void list(AuditLog log, Deque<String> args) {
        Options options = Options.parse(args);
        int limit = Integer.parseInt(options.orDefault("limit", "20"));
        int node = Integer.parseInt(options.orDefault("node", "0"));

        List<AuditLog.Entry> entries = log.history(node, limit);
        if (entries.isEmpty()) {
            System.out.println("No access events finalized yet. Record one first.");
            return;
        }

        System.out.printf("Finalized access log, newest first (read from node %d)%n%n", node);
        System.out.printf("%-8s %-8s %-30s %-14s %s%n",
                "HEIGHT", "ACTION", "CHANGE", "SUBMITTED BY", "MESSAGE ID");
        for (AuditLog.Entry entry : entries) {
            AccessEvent event = entry.event();
            String action = event == null ? "?" : event.action();
            String change = event == null ? "(unreadable body)"
                    : event.actor() + " -> " + event.subject() + " @ " + event.resource();
            System.out.printf("%-8d %-8s %-30s %-14s %s%n",
                    entry.height(), action, truncate(change, 30),
                    shortHex(entry.senderHex()), entry.messageId());
        }

        // Different members relay different entries, and the envelope records
        // which member did. That is what makes "you never sent it" answerable.
        Set<String> senders = new HashSet<>();
        entries.forEach(entry -> senders.add(entry.senderHex()));
        System.out.printf("%n%d entries from %d distinct member key(s).%n", entries.size(), senders.size());
    }

    // ---------------------------------------------------------------- prove

    private static void prove(AuditLog log, Deque<String> args) {
        String messageId = require(args.poll(), "prove needs a message id");
        Options options = Options.parse(args);
        int from = Integer.parseInt(options.orDefault("from", "0"));
        int against = Integer.parseInt(options.orDefault("against", String.valueOf(log.nodeCount() - 1)));

        AuditLog.Verification result = log.prove(messageId, from, against);
        AppChainClient.Proof proof = result.proof();

        System.out.printf("Proving message %s%n%n", messageId);
        System.out.printf("  recorded at     height %d, index %d, topic %s%n",
                result.record().height(), result.record().originalMessageIndex(),
                result.record().topic());
        System.out.printf("  proof served by node %d%n", result.servingNode());
        System.out.printf("  profile         %s%n", proof.profile());
        System.out.printf("  committed at    height %d%n", proof.committedHeight());
        System.out.printf("  root (node %d)   %s%n", result.servingNode(), proof.stateRootHex());
        System.out.printf("  root (node %d)   %s%n", result.trustingNode(), result.trustedRootHex());
        System.out.println();

        check("proof is internally consistent", result.selfConsistent(),
                "self-consistency only — a dishonest node could fake this on its own root");
        check("verified against node " + result.trustingNode() + "'s independently finalized root",
                result.verifiedAgainstPeer(),
                "the serving node cannot forge a record that reconciles with a peer's root");
        check("honest record accepted by raw MPF inclusion check",
                result.honestValueAccepted(), null);
        check("tampered record REJECTED (one bit flipped)",
                !result.tamperedValueAccepted(),
                "changing the logged event invalidates the proof");

        System.out.println();
        if (result.passed()) {
            System.out.println("PASS — this entry is provable without trusting any single member.");
        } else {
            System.out.println("FAIL — verification did not behave as expected.");
            System.exit(3);
        }
    }

    // ----------------------------------------------------------------- tips

    private static void tips(AuditLog log) {
        List<AuditLog.Tip> tips = log.tips();
        System.out.println("Per-member view of the chain\n");
        System.out.printf("%-8s %-10s %s%n", "NODE", "HEIGHT", "STATE ROOT");

        Set<String> roots = new HashSet<>();
        boolean reachable = true;
        for (AuditLog.Tip tip : tips) {
            if (tip.error() != null) {
                System.out.printf("%-8d %-10s %s%n", tip.node(), "-", "unreachable: " + tip.error());
                reachable = false;
                continue;
            }
            System.out.printf("%-8d %-10d %s%n", tip.node(), tip.height(), tip.stateRootHex());
            roots.add(tip.height() + ":" + tip.stateRootHex());
        }

        System.out.println();
        if (!reachable) {
            System.out.println("Some members are unreachable.");
        } else if (roots.size() == 1) {
            System.out.println("AGREED — every member finalized the same history.");
        } else {
            System.out.println("Roots differ. Members at different heights converge within a "
                    + "block or two; run this again.");
        }
    }

    // ---------------------------------------------------------------- output

    private static void check(String label, boolean ok, String note) {
        System.out.printf("  [%s] %s%n", ok ? "ok  " : "FAIL", label);
        if (note != null) {
            System.out.printf("         %s%n", note);
        }
    }

    private static String shortHex(String hex) {
        return hex == null || hex.length() <= 12 ? String.valueOf(hex) : hex.substring(0, 12);
    }

    private static String truncate(String value, int width) {
        return value.length() <= width ? value : value.substring(0, width - 1) + "…";
    }

    private static String require(String value, String message) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(message);
        }
        return value;
    }

    private static void usage() {
        System.out.println("""
                Shared access-change audit log — Yano X example 01

                  record grant|revoke --subject <who> --resource <what>
                                      [--by <actor>] [--reason <text>] [--node <i>]
                  list                [--limit <n>] [--node <i>]
                  prove <messageId>   [--from <i>] [--against <i>]
                  tips

                The chain must be running: ./cluster start 3
                """);
    }

    /** Minimal --name value parser; every option in this CLI takes a value. */
    private record Options(java.util.Map<String, String> values) {

        static Options parse(Deque<String> args) {
            java.util.Map<String, String> values = new java.util.LinkedHashMap<>();
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
