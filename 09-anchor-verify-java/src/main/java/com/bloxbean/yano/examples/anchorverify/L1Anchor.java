package com.bloxbean.yano.examples.anchorverify;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.yanoproject.api.appchain.anchor.AnchorDatumV1;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HexFormat;

/**
 * Reading the anchor off Cardano.
 *
 * <p>This class is the whole point of the example: it talks to a Cardano API
 * and nothing else. No Yano node is consulted, so nothing a Yano node might
 * claim can influence the result.
 *
 * <h2>What is actually on chain</h2>
 * Script-mode anchoring parks one UTxO at a Plutus validator address. That
 * UTxO holds a thread NFT — minted once, unique to the chain — and an inline
 * datum carrying the app chain's committed state:
 *
 * <pre>
 *   chainId              which chain this is
 *   chainGenesisId       which generation of it
 *   applicationId        which state machine
 *   commitmentProfileId  how state is committed (mpf-blake2b256-v1)
 *   height               the app-chain height this root is for
 *   stateRoot            the committed root itself
 *   memberKeys           who the members were
 *   threshold            how many had to sign
 * </pre>
 *
 * The member set and threshold being <em>in the datum</em> is what makes this
 * self-contained: a verifier does not have to be told separately who was
 * allowed to sign. Cardano carries it.
 */
public final class L1Anchor {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final String cardanoApi;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10)).build();

    public L1Anchor(String cardanoApi) {
        this.cardanoApi = cardanoApi.endsWith("/") ? cardanoApi : cardanoApi + "/";
    }

    /** An anchor as found on chain, with where it was found. */
    public record Found(AnchorDatumV1 datum, String transactionId, int outputIndex,
                        String scriptAddress, String threadAsset) {}

    /**
     * Find the current anchor at a script address.
     *
     * <p>The UTxO is identified by the thread token, not by position: a
     * validator-enforced thread means exactly one live UTxO carries it, and
     * that one is the current state. Anything else sitting at the address is
     * not the anchor.
     */
    public Found read(String scriptAddress, String threadPolicyId) {
        JsonNode utxos = get("addresses/" + scriptAddress + "/utxos");
        if (utxos == null || !utxos.isArray() || utxos.isEmpty()) {
            throw new IllegalStateException("no UTxO at the anchor script address "
                    + scriptAddress + " — has the chain anchored yet?");
        }

        for (JsonNode utxo : utxos) {
            String threadAsset = threadAsset(utxo, threadPolicyId);
            if (threadAsset == null) {
                continue;                       // not the thread UTxO
            }
            String datumHex = utxo.path("inline_datum").asText(null);
            if (datumHex == null || datumHex.isBlank()) {
                throw new IllegalStateException("the thread UTxO carries no inline datum");
            }
            return new Found(AnchorDatumV1.decode(HexFormat.of().parseHex(datumHex)),
                    utxo.path("tx_hash").asText(), utxo.path("output_index").asInt(),
                    scriptAddress, threadAsset);
        }
        throw new IllegalStateException("no UTxO at " + scriptAddress
                + " carries a token of thread policy " + threadPolicyId);
    }

    /** The thread token is {policyId}{assetName}; the asset name is the chain id. */
    private static String threadAsset(JsonNode utxo, String threadPolicyId) {
        for (JsonNode amount : utxo.path("amount")) {
            String unit = amount.path("unit").asText("");
            if (!unit.equals("lovelace") && unit.startsWith(threadPolicyId)) {
                return unit;
            }
        }
        return null;
    }

    /** Whether a transaction exists on chain — used to show the anchor tx is real. */
    public boolean transactionExists(String transactionId) {
        return get("txs/" + transactionId) != null;
    }

    private JsonNode get(String path) {
        try {
            HttpResponse<String> response = http.send(
                    HttpRequest.newBuilder(URI.create(cardanoApi + path))
                            .header("Accept", "application/json").GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 404) {
                return null;
            }
            if (response.statusCode() != 200) {
                throw new IllegalStateException("Cardano API " + path + " -> "
                        + response.statusCode());
            }
            return JSON.readTree(response.body());
        } catch (IOException | InterruptedException failure) {
            if (failure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new IllegalStateException("cannot reach the Cardano API at " + cardanoApi
                    + " — " + failure.getMessage(), failure);
        }
    }
}
