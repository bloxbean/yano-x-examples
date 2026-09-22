package com.bloxbean.yano.examples.anchorverify;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/**
 * What can be checked without a chain or a Cardano node: that a bundle round
 * trips, that it does not carry its own anchor location, and that the verifier
 * has no way to reach a Yano node.
 */
class BundleAndTrustTest {

    private static Bundle sample() {
        return new Bundle("evidence-chain", 7, "aa".repeat(32), "bb".repeat(40),
                "cc".repeat(60), "dd".repeat(32), "a note");
    }

    @Test
    @DisplayName("a bundle round trips through JSON unchanged")
    void bundleRoundTrips(@TempDir Path dir) {
        Path file = dir.resolve("bundle.json");
        sample().write(file);
        assertEquals(sample(), Bundle.read(file));
    }

    @Test
    @DisplayName("a bundle does NOT carry where its anchor lives")
    void bundleCannotNameItsOwnAnchor() {
        String json = sample().toJson();

        // If a bundle could point at an anchor, a forged bundle would point at
        // a forged anchor. These must only ever come from AnchorTrust.
        assertFalse(json.contains("scriptAddress"),
                "a bundle must not name the script address it should be checked against");
        assertFalse(json.contains("threadPolicyId"),
                "a bundle must not name the thread policy it should be checked against");
        assertFalse(json.contains("cardanoApi"),
                "a bundle must not choose which Cardano source verifies it");
    }

    @Test
    @DisplayName("the pinned trust file carries exactly the facts the verifier needs")
    void trustRoundTrips(@TempDir Path dir) {
        AnchorTrust trust = new AnchorTrust("evidence-chain", "ordered-log",
                "ee".repeat(32), "addr_test1w...", "ff".repeat(28), "http://localhost/api/v1/");
        Path file = dir.resolve("anchor-trust.json");
        trust.write(file);
        assertEquals(trust, AnchorTrust.read(file));
    }

    @Test
    @DisplayName("a missing trust file says what to do about it")
    void missingTrustIsExplained(@TempDir Path dir) {
        var failure = assertThrows(IllegalStateException.class,
                () -> AnchorTrust.read(dir.resolve("absent.json")));
        assertTrue(failure.getMessage().contains("trust init"), failure.getMessage());
    }

    @Test
    @DisplayName("an absent value is reported as an exclusion proof, not as empty bytes")
    void absentValueIsExplicit() {
        Bundle absent = new Bundle("c", 1, "aa".repeat(32), null, "bb", "cc".repeat(32), "");
        assertTrue(absent.valueText().contains("exclusion"), absent.valueText());
    }

    @Test
    @DisplayName("the verifier cannot reach a Yano node — it has no client")
    void verifierHasNoAppChainClient() throws Exception {
        // The guarantee this example makes is structural, so assert it
        // structurally: if someone adds an AppChainClient to the verification
        // path, this fails and the claim in the README has to be revisited.
        for (String source : new String[] {"Verifier.java", "L1Anchor.java"}) {
            Path file = Path.of("src/main/java/com/bloxbean/yano/examples/anchorverify", source);
            // Imports, not prose: these files discuss AppChainClient in their
            // Javadoc precisely because they must not use it.
            boolean importsClient = Files.readAllLines(file).stream()
                    .map(String::strip)
                    .filter(line -> line.startsWith("import "))
                    .anyMatch(line -> line.contains("AppChainClient")
                            || line.equals("import org.yanoproject.x.client.*;"));
            assertFalse(importsClient,
                    source + " must not talk to a Yano node — that is the whole point");
        }
    }
}
