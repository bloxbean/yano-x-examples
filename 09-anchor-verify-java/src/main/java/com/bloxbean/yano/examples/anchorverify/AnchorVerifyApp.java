package com.bloxbean.yano.examples.anchorverify;

import com.fasterxml.jackson.databind.JsonNode;
import org.yanoproject.api.appchain.anchor.AnchorDatumV1;
import org.yanoproject.x.client.AppChainClient;
import org.yanoproject.x.client.Hex;
import org.yanoproject.x.client.ProofSubjects;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/**
 * Anchor and verify — Yano X example 09.
 *
 * <pre>
 *   anchor record &lt;text&gt;          write a record to the chain
 *   anchor status                 chain tip and anchor state
 *   anchor trust init             pin the chain identity, once, out of band
 *   anchor inspect                what Cardano's anchor datum says
 *   anchor export &lt;messageId&gt;     an evidence bundle at the anchored height
 *   anchor verify &lt;bundle.json&gt;   verify using ONLY Cardano and the bundle
 *   anchor tamper &lt;bundle.json&gt;   flip a byte, so you can watch it fail
 * </pre>
 *
 * <p>The split matters: {@code record}, {@code export} and {@code status} talk
 * to the app chain. {@code verify} does not — it reads Cardano and the bundle
 * file, and nothing else.
 */
public final class AnchorVerifyApp {

    private static final String CHAIN_ID = "evidence-chain";
    private static final String TOPIC = "evidence.record.v1";
    private static final int BASE_PORT = Integer.parseInt(
            System.getenv().getOrDefault("YANO_HTTP_BASE", "7150"));

    public static void main(String[] args) {
        if (args.length == 0 || args[0].equals("help") || args[0].equals("--help")) {
            usage();
            System.exit(args.length == 0 ? 1 : 0);
        }
        try {
            new AnchorVerifyApp().run(args[0],
                    new ArrayDeque<>(List.of(args).subList(1, args.length)));
        } catch (IllegalArgumentException | IllegalStateException failure) {
            System.err.println("\nerror: " + failure.getMessage());
            System.exit(2);
        }
    }

    private void run(String command, Deque<String> rest) {
        switch (command) {
            case "record" -> record(String.join(" ", rest));
            case "status" -> status();
            case "trust" -> {
                String sub = rest.poll();
                if (!"init".equals(sub)) {
                    throw new IllegalArgumentException("usage: anchor trust init");
                }
                trustInit();
            }
            case "inspect" -> inspect();
            case "export" -> export(require(rest.poll(), "export needs a message id"),
                    Options.parse(rest));
            case "verify" -> verify(Path.of(require(rest.poll(), "verify needs a bundle file")));
            case "tamper" -> tamper(Path.of(require(rest.poll(), "tamper needs a bundle file")));
            default -> {
                System.err.println("unknown command: " + command);
                usage();
                System.exit(1);
            }
        }
    }

    // ------------------------------------------------ talking to the chain

    private AppChainClient client() {
        return AppChainClient.builder("http://127.0.0.1:" + BASE_PORT + "/api/v1")
                .chainId(CHAIN_ID)
                .apiKey(System.getenv().getOrDefault("YANO_CLUSTER_API_KEY",
                        "yano-local-cluster-full-key"))
                .build();
    }

    private void record(String text) {
        if (text.isBlank()) {
            throw new IllegalArgumentException("record needs some text");
        }
        AppChainClient client = client();
        var submitted = client.submitText(TOPIC, text);
        System.out.printf("Recorded \"%s\"%n%n", text);
        System.out.printf("  messageId  %s%n", submitted.messageId());

        // Wait for it to be finalized, then say where it landed.
        byte[] id = Hex.decode(submitted.messageId());
        long deadline = System.nanoTime() + Duration.ofSeconds(30).toNanos();
        while (System.nanoTime() < deadline) {
            var proof = client.proof(ProofSubjects.finalizedMessage(id));
            if (proof.isPresent() && proof.orElseThrow().decodedValue() != null) {
                System.out.printf("  finalized  height %d%n",
                        proof.orElseThrow().decodedValue().height());
                System.out.println("\n  Wait for the next anchor, then `anchor export "
                        + submitted.messageId().substring(0, 16) + "…`");
                return;
            }
            sleep(200);
        }
        throw new IllegalStateException("accepted but not finalized within 30s");
    }

    private JsonNode anchorStatus() {
        return client().status().path("anchor");
    }

    private void status() {
        var tip = client().tip();
        JsonNode anchor = anchorStatus();
        System.out.println("Chain\n");
        System.out.printf("  chain        %s%n", tip.chainId());
        System.out.printf("  tip height   %d%n", tip.height());
        System.out.printf("  state root   %s%n%n", tip.stateRootHex());

        System.out.println("Cardano anchor\n");
        if (!anchor.path("enabled").asBoolean(false)) {
            System.out.println("  not enabled — start with ./cluster start 3");
            return;
        }
        System.out.printf("  mode             %s%n", anchor.path("mode").asText());
        System.out.printf("  bootstrapped     %s%n", anchor.path("bootstrapped").asBoolean());
        System.out.printf("  anchored         %d time(s)%n", anchor.path("anchoredCount").asLong());
        System.out.printf("  last height      %d%n", anchor.path("lastAnchoredHeight").asLong());
        System.out.printf("  script address   %s%n", anchor.path("scriptAddress").asText(""));
        if (anchor.path("anchoredCount").asLong() == 0) {
            System.out.println("\n  Nothing anchored yet. Record something and wait a few seconds.");
        }
    }

    /**
     * The out-of-band step, done once.
     *
     * <p>It reads the chain's identity from the node — which is exactly what a
     * real verifier must NOT do. Here it stands in for the consortium
     * publishing its chain identity: a website, a registry entry, a signed
     * announcement. Everything after this point is checked against Cardano.
     */
    private void trustInit() {
        JsonNode anchor = anchorStatus();
        String scriptAddress = anchor.path("scriptAddress").asText("");
        if (scriptAddress.isEmpty() || !anchor.path("bootstrapped").asBoolean(false)) {
            throw new IllegalStateException("the chain has not bootstrapped its script anchor yet");
        }
        JsonNode identity = client().stateIdentity();

        AnchorTrust trust = new AnchorTrust(CHAIN_ID, "ordered-log",
                identity.path("genesisId").asText(), scriptAddress,
                anchor.path("threadPolicyId").asText(""),
                "http://127.0.0.1:" + BASE_PORT + "/api/v1/");
        trust.write(AnchorTrust.DEFAULT_FILE);

        System.out.printf("Pinned the chain identity in %s%n%n", AnchorTrust.DEFAULT_FILE);
        System.out.println(trust.toJson());
        System.out.println("""
                  This is the ONLY step that asks the node anything about identity. It
                  stands in for the consortium publishing its chain identity out of band.

                  From here on the verifier uses this file and Cardano. If a node lied
                  about any of it, it lied once, publicly, and permanently — rather than
                  per answer.""");
    }

    private void export(String messageIdPrefix, Options options) {
        AppChainClient client = client();
        JsonNode anchor = anchorStatus();
        long anchoredHeight = anchor.path("lastAnchoredHeight").asLong();
        if (anchoredHeight <= 0) {
            throw new IllegalStateException("nothing has been anchored yet — "
                    + "record something and wait a few seconds");
        }

        byte[] messageId = Hex.decode(messageIdPrefix);
        byte[] key = ProofSubjects.finalizedMessage(messageId).canonicalKey();

        // The proof must be taken AT the anchored height. A proof at the tip
        // commits to a root Cardano has not seen yet, and would be rejected.
        AppChainClient.Proof proof = client.proof(key, anchoredHeight).orElseThrow(
                () -> new IllegalStateException("no proof for that record at height "
                        + anchoredHeight + " — was it recorded before the last anchor?"));

        Bundle bundle = Bundle.from(proof, options.orDefault("note", "evidence record"));
        Path out = Path.of(options.orDefault("out", "bundle.json"));
        bundle.write(out);

        System.out.printf("Exported an evidence bundle to %s%n%n", out);
        System.out.printf("  chain        %s%n", bundle.chainId());
        System.out.printf("  height       %d   (the anchored height, not the tip)%n", bundle.height());
        System.out.printf("  record       \"%s\"%n", bundle.valueText());
        System.out.printf("  state root   %s%n", bundle.stateRootHex());
        System.out.println("""

                  The bundle is a claim, not a proof of itself. It does not say where its
                  anchor lives — if it did, a forged bundle would simply name a forged
                  anchor. `anchor verify` checks it against Cardano.""");
    }

    // ------------------------------------- Cardano only, from here down

    private void inspect() {
        AnchorTrust trust = AnchorTrust.read(AnchorTrust.DEFAULT_FILE);
        L1Anchor.Found found = new L1Anchor(trust.cardanoApi())
                .read(trust.scriptAddress(), trust.threadPolicyId());
        AnchorDatumV1 anchor = found.datum();

        System.out.println("What Cardano says about this chain\n");
        System.out.printf("  found at         tx %s output %d%n",
                found.transactionId(), found.outputIndex());
        System.out.printf("  thread token     %s%n%n", found.threadAsset());
        System.out.printf("  chain            %s%n", anchor.chainId());
        System.out.printf("  application      %s%n", anchor.applicationId());
        System.out.printf("  genesis          %s%n", HexFormat.of().formatHex(anchor.chainGenesisId()));
        System.out.printf("  profile          %s%n", anchor.commitmentProfileId());
        System.out.printf("  height           %d%n", anchor.height());
        System.out.printf("  state root       %s%n", HexFormat.of().formatHex(anchor.stateRoot()));
        System.out.printf("  threshold        %d of %d%n", anchor.threshold(), anchor.memberKeys().size());
        anchor.memberKeysHex().forEach(key -> System.out.printf("    member         %s%n", key));
        System.out.println("""

                  Every one of those came out of a Cardano UTxO. Note especially the
                  member set and threshold: a verifier does not have to be told
                  separately who was allowed to sign — the anchor carries it.""");
    }

    private void verify(Path bundleFile) {
        AnchorTrust trust = AnchorTrust.read(AnchorTrust.DEFAULT_FILE);
        Bundle bundle = Bundle.read(bundleFile);

        System.out.printf("Verifying %s%n%n", bundleFile);
        System.out.printf("  record       \"%s\"%n", bundle.valueText());
        System.out.printf("  claims       height %d on %s%n%n", bundle.height(), bundle.chainId());
        System.out.println("  Consulting Cardano only — no Yano node is asked anything.\n");

        Verifier.Result result = Verifier.verify(bundle, trust);
        for (Verifier.Check check : result.checks()) {
            System.out.printf("  [%s] %s%n", check.ok() ? "ok  " : "FAIL", check.label());
            if (check.detail() != null && !check.detail().isBlank()) {
                System.out.printf("         %s%n", check.detail());
            }
        }

        System.out.println();
        if (result.passed()) {
            System.out.println("VERIFIED — this record was in the state a threshold of members");
            System.out.printf("           committed at height %d, and Cardano carries it.%n",
                    result.anchor().height());
        } else {
            System.out.println("REJECTED — do not rely on this bundle.");
            System.exit(3);
        }
    }

    /** Flip a byte of the recorded value so the failure can be watched. */
    private void tamper(Path bundleFile) {
        Bundle bundle = Bundle.read(bundleFile);
        byte[] value = HexFormat.of().parseHex(bundle.valueHex());
        value[value.length - 1] ^= 0x01;

        Bundle altered = new Bundle(bundle.chainId(), bundle.height(), bundle.keyHex(),
                HexFormat.of().formatHex(value), bundle.proofWireHex(), bundle.stateRootHex(),
                bundle.note());
        altered.write(bundleFile);

        System.out.printf("Flipped one bit of the recorded value in %s%n%n", bundleFile);
        System.out.printf("  was   \"%s\"%n", bundle.valueText());
        System.out.printf("  now   \"%s\"%n", altered.valueText());
        System.out.println("\n  Everything else is untouched — same height, same root, same");
        System.out.println("  proof. Run `anchor verify` again.");
    }

    // ----------------------------------------------------------------- CLI

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted");
        }
    }

    private static String require(String value, String message) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(message);
        }
        return value;
    }

    private static void usage() {
        System.out.println("""
                Anchor and verify — Yano X example 09

                  anchor record <text>            write a record to the chain
                  anchor status                   chain tip and anchor state
                  anchor trust init               pin the chain identity, once, out of band
                  anchor inspect                  what Cardano's anchor datum says
                  anchor export <messageId> [--out <file>] [--note <text>]
                  anchor verify <bundle.json>     verify using ONLY Cardano and the bundle
                  anchor tamper <bundle.json>     flip a byte, then verify again

                record / export / status talk to the app chain.
                inspect / verify do not — they read Cardano and the bundle file.

                The chain must be running: ./cluster start 3
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

        String orDefault(String name, String fallback) {
            return values.getOrDefault(name, fallback);
        }
    }
}
