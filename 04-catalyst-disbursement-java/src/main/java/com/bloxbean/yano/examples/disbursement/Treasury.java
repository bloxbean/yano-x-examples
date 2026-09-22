package com.bloxbean.yano.examples.disbursement;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.Result;
import com.bloxbean.cardano.client.backend.api.BackendService;
import com.bloxbean.cardano.client.backend.blockfrost.service.BFBackendService;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.transaction.spec.Transaction;
import com.bloxbean.cardano.client.transaction.util.TransactionUtil;

import java.io.IOException;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HexFormat;

/**
 * The Cardano side: building, signing and submitting the payout.
 *
 * <h2>Why the transaction id is the thing that gets approved</h2>
 * A Cardano transaction id <em>is</em> the Blake2b-256 hash of its transaction
 * body. So if reviewers authorize that hash, the approval record names a
 * specific transaction, and anyone can look that id up on chain and check it
 * against the approval. Nothing in between has to be trusted.
 *
 * <p>Signatures live in the witness set, which is <b>outside</b> the body — so
 * signing does not change the id. That is what lets the order be: build,
 * approve, and only then sign. The treasury key is applied to bytes that were
 * already authorized.
 *
 * <p>The node running the app chain is also a Cardano node, and its REST API is
 * Blockfrost-shaped, so an ordinary Cardano library talks to it directly.
 */
public final class Treasury {

    /** Where prepared payouts are kept between approval and execution. */
    private static final Path SPOOL = Path.of(".payouts");

    private final BackendService backend;
    private final String apiUrl;

    /**
     * The fund's treasury key.
     *
     * <p>Demo-only, derived from a fixed phrase so the address is stable across
     * runs. In a deployment this is the key the fund operator guards; it never
     * belongs in source, and signing would happen in a KMS or HSM.
     */
    private final Account treasury;

    public Treasury(Chain chain) {
        this.apiUrl = chain.cardanoApiUrl();
        this.backend = new BFBackendService(apiUrl, "not-used-by-a-local-node");
        this.treasury = new Account(Networks.testnet(), DEMO_TREASURY_MNEMONIC);
    }

    private static final String DEMO_TREASURY_MNEMONIC =
            "test walk nut penalty hip pave soap entry language right filter choice";

    public String treasuryAddress() {
        return treasury.baseAddress();
    }

    /** A payout that has been built but not yet authorized or signed. */
    public record Prepared(String milestoneId, String payee, long lovelace,
                           String transactionId, byte[] transactionBytes) {

        public byte[] payloadHash() {
            return HexFormat.of().parseHex(transactionId);
        }

        public String amountAda() {
            return java.math.BigDecimal.valueOf(lovelace, 6).toPlainString();
        }
    }

    // ------------------------------------------------------------- building

    /**
     * Build the payout transaction, unsigned.
     *
     * <p>The returned id is what reviewers will authorize. The bytes are spooled
     * to disk so the exact transaction — not a rebuilt one — is what gets
     * submitted later.
     */
    public Prepared prepare(String milestoneId, String payee, long lovelace) {
        Transaction unsigned = new QuickTxBuilder(backend)
                .compose(new Tx()
                        .payToAddress(payee, Amount.lovelace(BigInteger.valueOf(lovelace)))
                        .from(treasury.baseAddress()))
                .withSigner(SignerProviders.signerFrom(treasury))
                .build();   // builds only — the witness set is still empty

        try {
            byte[] bytes = unsigned.serialize();
            Prepared prepared = new Prepared(milestoneId, payee, lovelace,
                    TransactionUtil.getTxHash(unsigned), bytes);
            Files.createDirectories(SPOOL);
            Files.write(spoolFile(milestoneId), bytes);
            return prepared;
        } catch (Exception failure) {
            throw new IllegalStateException("could not build the payout: " + failure.getMessage(),
                    failure);
        }
    }

    /** Load a previously prepared payout, recomputing its id from the stored bytes. */
    public Prepared load(String milestoneId) {
        Path file = spoolFile(milestoneId);
        if (!Files.exists(file)) {
            throw new IllegalStateException("no prepared payout for " + milestoneId
                    + " — run `disburse prepare` first");
        }
        try {
            byte[] bytes = Files.readAllBytes(file);
            Transaction transaction = Transaction.deserialize(bytes);
            long lovelace = transaction.getBody().getOutputs().isEmpty() ? 0
                    : transaction.getBody().getOutputs().getFirst().getValue().getCoin().longValue();
            String payee = transaction.getBody().getOutputs().isEmpty() ? "?"
                    : transaction.getBody().getOutputs().getFirst().getAddress();
            return new Prepared(milestoneId, payee, lovelace,
                    TransactionUtil.getTxHash(transaction), bytes);
        } catch (Exception malformed) {
            throw new IllegalStateException("the spooled payout for " + milestoneId
                    + " is unreadable: " + malformed.getMessage(), malformed);
        }
    }

    /** Overwrite a spooled payout — used to demonstrate that tampering is caught. */
    public Prepared tamper(String milestoneId, long newLovelace) {
        Prepared original = load(milestoneId);
        Prepared altered = prepare(milestoneId + "-tampered", original.payee(), newLovelace);
        try {
            Files.write(spoolFile(milestoneId), altered.transactionBytes());
        } catch (IOException failure) {
            throw new IllegalStateException(failure);
        }
        return load(milestoneId);
    }

    // ------------------------------------------------------------ executing

    /**
     * Sign and submit a payout.
     *
     * <p>The caller must already have checked that the approval names this
     * transaction id. This method signs and submits, and returns the id the
     * network accepted so it can be compared once more.
     */
    public String signAndSubmit(Prepared prepared) {
        try {
            Transaction signed = treasury.sign(Transaction.deserialize(prepared.transactionBytes()));

            // Signing must not have altered the identity — the witness set is
            // outside the body. If this ever fails, the approval no longer
            // refers to what is about to be submitted.
            String afterSigning = TransactionUtil.getTxHash(signed);
            if (!afterSigning.equals(prepared.transactionId())) {
                throw new IllegalStateException("signing changed the transaction id: "
                        + prepared.transactionId() + " -> " + afterSigning);
            }

            Result<String> result = backend.getTransactionService()
                    .submitTransaction(signed.serialize());
            if (!result.isSuccessful()) {
                throw new IllegalStateException("Cardano rejected the payout: " + result.getResponse());
            }
            return result.getValue();
        } catch (IllegalStateException already) {
            throw already;
        } catch (Exception failure) {
            throw new IllegalStateException("could not submit the payout: " + failure.getMessage(),
                    failure);
        }
    }

    // --------------------------------------------------------------- L1 reads

    /** Top up the treasury from the devnet faucet. Devnet only, obviously. */
    public String fundTreasury(long ada) {
        try {
            HttpResponse<String> response = HttpClient.newHttpClient().send(
                    HttpRequest.newBuilder(URI.create(apiUrl + "devnet/fund"))
                            .header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString(
                                    "{\"address\":\"" + treasury.baseAddress() + "\",\"ada\":" + ada + "}"))
                            .build(),
                    HttpResponse.BodyHandlers.ofString());
            return response.body();
        } catch (IOException | InterruptedException failure) {
            if (failure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new IllegalStateException("faucet call failed: " + failure.getMessage(), failure);
        }
    }

    public long balanceLovelace(String address) {
        try {
            var utxos = backend.getUtxoService().getUtxos(address, 100, 1).getValue();
            return utxos == null ? 0 : utxos.stream()
                    .flatMap(utxo -> utxo.getAmount().stream())
                    .filter(amount -> "lovelace".equals(amount.getUnit()))
                    .mapToLong(amount -> amount.getQuantity().longValue())
                    .sum();
        } catch (Exception unavailable) {
            return -1;
        }
    }

    /** Whether a transaction id is on chain. This is the independent check. */
    public boolean isOnChain(String transactionId) {
        try {
            return backend.getTransactionService().getTransaction(transactionId).isSuccessful();
        } catch (Exception notFound) {
            return false;
        }
    }

    private static Path spoolFile(String milestoneId) {
        return SPOOL.resolve(milestoneId.toLowerCase(java.util.Locale.ROOT)
                .replaceAll("[^a-z0-9-]", "-") + ".tx");
    }
}
