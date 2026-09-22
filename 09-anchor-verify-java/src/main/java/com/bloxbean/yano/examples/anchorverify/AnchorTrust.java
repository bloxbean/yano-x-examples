package com.bloxbean.yano.examples.anchorverify;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * What the verifier pins, out of band.
 *
 * <p>Four public facts about a chain, established once when the consortium
 * announces it, and thereafter treated as given:
 *
 * <ul>
 *   <li>{@code chainId} and {@code applicationId} — which chain and machine</li>
 *   <li>{@code chainGenesisId} — which generation of it</li>
 *   <li>{@code scriptAddress} + {@code threadPolicyId} — where on Cardano its
 *       anchor lives, and which token marks the live one</li>
 * </ul>
 *
 * <p>None of these are secret, and none come from an evidence bundle. A bundle
 * that could name its own anchor location would be self-certifying, which is
 * the same as not being certified at all.
 *
 * <p>In this example {@code trust init} reads them from the running chain once,
 * which is convenient and honest about being the out-of-band step. A real
 * verifier gets them from the consortium's published chain identity — a
 * website, a registry entry, a signed announcement — not from a node it is
 * about to check.
 */
public record AnchorTrust(String chainId, String applicationId, String chainGenesisId,
                          String scriptAddress, String threadPolicyId, String cardanoApi) {

    private static final ObjectMapper JSON = new ObjectMapper();
    public static final Path DEFAULT_FILE = Path.of("anchor-trust.json");

    public String toJson() {
        ObjectNode node = JSON.createObjectNode();
        node.put("_comment", "Pinned out of band. The verifier trusts these and checks everything else.");
        node.put("chainId", chainId);
        node.put("applicationId", applicationId);
        node.put("chainGenesisId", chainGenesisId);
        node.put("scriptAddress", scriptAddress);
        node.put("threadPolicyId", threadPolicyId);
        node.put("cardanoApi", cardanoApi);
        try {
            return JSON.writerWithDefaultPrettyPrinter().writeValueAsString(node) + "\n";
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    public void write(Path file) {
        try {
            Files.writeString(file, toJson());
        } catch (Exception failure) {
            throw new IllegalStateException("cannot write " + file, failure);
        }
    }

    public static AnchorTrust read(Path file) {
        if (!Files.exists(file)) {
            throw new IllegalStateException("no " + file + " — run `anchor trust init` first.\n"
                    + "       That is the out-of-band step: it records which chain, which\n"
                    + "       genesis, and where on Cardano its anchor lives.");
        }
        try {
            var node = JSON.readTree(Files.readString(file));
            return new AnchorTrust(node.path("chainId").asText(),
                    node.path("applicationId").asText(), node.path("chainGenesisId").asText(),
                    node.path("scriptAddress").asText(), node.path("threadPolicyId").asText(),
                    node.path("cardanoApi").asText());
        } catch (Exception malformed) {
            throw new IllegalStateException("cannot read " + file + ": " + malformed.getMessage(),
                    malformed);
        }
    }
}
