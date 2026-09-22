package com.bloxbean.yano.examples.anchorverify;

import org.yanoproject.api.appchain.anchor.AnchorDatumV1;
import org.yanoproject.x.client.ProofVerifier;

import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

/**
 * Verification that trusts Cardano and nothing else.
 *
 * <p>There is no {@code AppChainClient} here, and that is deliberate: this
 * class cannot ask a Yano node anything, so nothing a Yano node might claim can
 * influence the outcome. Its only inputs are an evidence bundle, the facts
 * pinned in {@link AnchorTrust}, and whatever Cardano says.
 *
 * <p>The chain of reasoning it establishes:
 *
 * <pre>
 *   Cardano holds a UTxO with this chain's thread token
 *        └─ its inline datum says: at height H the state root was R,
 *           under members M with threshold T
 *   the bundle's proof reconciles the record against R
 *        └─ therefore this record was in the state a threshold of members
 *           committed, and Cardano carries the evidence of when
 * </pre>
 */
public final class Verifier {

    public record Check(String label, boolean ok, String detail) {}

    public record Result(List<Check> checks, AnchorDatumV1 anchor, L1Anchor.Found found) {
        public boolean passed() {
            return checks.stream().allMatch(Check::ok);
        }
    }

    private Verifier() {
    }

    public static Result verify(Bundle bundle, AnchorTrust trust) {
        List<Check> checks = new ArrayList<>();

        // 1. Read the anchor off Cardano. Nothing else is consulted.
        L1Anchor.Found found = new L1Anchor(trust.cardanoApi())
                .read(trust.scriptAddress(), trust.threadPolicyId());
        AnchorDatumV1 anchor = found.datum();
        checks.add(new Check("found this chain's anchor on Cardano", true,
                "tx " + found.transactionId().substring(0, 16) + "… output " + found.outputIndex()));

        // 2. The anchor must be the chain the verifier pinned, not some other
        //    chain that happens to have an anchor.
        boolean identity = trust.chainId().equals(anchor.chainId())
                && trust.applicationId().equals(anchor.applicationId())
                && trust.chainGenesisId().equals(HexFormat.of().formatHex(anchor.chainGenesisId()));
        checks.add(new Check("the anchor is the chain and generation you pinned", identity,
                anchor.chainId() + " / " + anchor.applicationId()
                        + " / genesis " + HexFormat.of().formatHex(anchor.chainGenesisId())
                        .substring(0, 16) + "…"));

        // 3. The bundle must be about that same chain.
        boolean sameChain = bundle.chainId().equals(anchor.chainId());
        checks.add(new Check("the bundle is about that chain", sameChain, bundle.chainId()));

        // 4. An anchor commits ONE height. A proof at a different height is not
        //    covered by it, and cannot be waved through.
        boolean sameHeight = bundle.height() == anchor.height();
        checks.add(new Check("the bundle's height is the height Cardano anchored", sameHeight,
                "bundle " + bundle.height() + ", anchor " + anchor.height()));

        // 5. The state root the bundle claims must be the anchored one.
        String anchoredRoot = HexFormat.of().formatHex(anchor.stateRoot());
        boolean sameRoot = anchoredRoot.equals(bundle.stateRootHex());
        checks.add(new Check("the bundle's state root is the anchored root", sameRoot,
                sameRoot ? anchoredRoot : "bundle " + bundle.stateRootHex()
                        + " vs anchored " + anchoredRoot));

        if (!identity || !sameChain || !sameHeight || !sameRoot) {
            return new Result(checks, anchor, found);   // no point checking the proof
        }

        // 6. The proof itself, against the root Cardano carries — not against
        //    any root a node nominated.
        boolean included = bundle.valueHex() != null && ProofVerifier.verifyInclusion(
                anchor.stateRoot(),
                HexFormat.of().parseHex(bundle.keyHex()),
                HexFormat.of().parseHex(bundle.valueHex()),
                HexFormat.of().parseHex(bundle.proofWireHex()));
        checks.add(new Check("the record is proved under the anchored root", included,
                included ? "MPF inclusion verified" : "the proof does not reconcile"));

        // 7. Report the trust inputs Cardano itself supplied. A verifier does
        //    not have to be told separately who was allowed to sign.
        checks.add(new Check("Cardano names the member set and threshold", true,
                anchor.threshold() + " of " + anchor.memberKeys().size() + " members"));

        return new Result(checks, anchor, found);
    }
}
