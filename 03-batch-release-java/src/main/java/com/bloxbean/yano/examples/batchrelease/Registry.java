package com.bloxbean.yano.examples.batchrelease;

import com.fasterxml.jackson.databind.JsonNode;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.yanoproject.x.roles.contracts.*;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * The governed registry: who exists, what roles they hold, and which policies
 * apply.
 *
 * <h2>Who authorizes a registry change</h2>
 * Not the actors. The {@code role-approvals} profile derives its administrators
 * from the <em>genesis membership epoch</em> of the app chain, so the member
 * nodes govern the registry at the genesis threshold. That is why every
 * mutation here is a three-step dance:
 *
 * <pre>
 *   PROPOSE   member 0 submits the mutation      → record PENDING, approvals=[member0]
 *   APPROVE   member 1 submits its approval      → approvals=[member0, member1]
 *   ACTIVATE  any member                          → applied once approvals ≥ threshold
 * </pre>
 *
 * The proposer is counted as the first approval, so a 2-of-3 threshold needs
 * exactly one additional approval.
 */
public final class Registry {

    /**
     * A mutation that has been prepared but not yet submitted.
     *
     * <p>The mutation id is derived from the mutation bytes. That makes
     * re-running a change idempotent — proposing identical content reuses the
     * same id, and the registry skips it — while a <em>corrected</em> mutation
     * gets a fresh id. Without that, a mutation that failed activation would
     * permanently occupy its id: {@code propose} is a no-op when a record for
     * the id already exists, so retrying under the same name silently does
     * nothing.
     */
    public record Change(String name, String topic, byte[] mutation, String describe) {

        /**
         * The digest the members approve.
         *
         * <p>It must come from {@code GovernedMutationCommandV1}, whose domain
         * separator differs from the otherwise similar-looking
         * {@code ActorGovernanceCommandV1.mutationHash}. Using the wrong one
         * produces approvals that silently never match the proposal — the
         * processor compares hashes and returns without recording anything.
         * Neither the id nor the expiry affects this value.
         */
        byte[] hash() {
            return new GovernedMutationCommandV1.Propose(name, mutation, 2).mutationHash();
        }

        /** {@code <name>-<first 8 hex of the mutation hash>} */
        public String mutationId() {
            return name + "-" + org.yanoproject.x.client.Hex.encode(hash()).substring(0, 8);
        }
    }

    private final Chain chain;

    public Registry(Chain chain) {
        this.chain = chain;
    }

    // ------------------------------------------------------ building changes

    public static Change putOrganization(Cast.Organization organization, long revision) {
        OrganizationRecordV1 record = new OrganizationRecordV1(
                organization.id(), revision, RecordStatus.ACTIVE, new byte[0]);
        return new Change("org-" + organization.id() + "-r" + revision, Chain.ACTORS_TOPIC,
                new RegistryMutationV1.PutOrganization(record).encode(),
                "organization " + organization.displayName());
    }

    /**
     * Register a person for the first time, with proof-of-possession.
     *
     * <p>The proof is a signature by the actor's own private key over the
     * (chain, actor, revision, key) tuple. It stops an administrator from
     * registering a key the actor does not control — the registry will not
     * accept a key nobody can prove they hold.
     */
    public static Change registerActor(Cast.Actor actor) {
        ActorKeyEpochV1 key = keyEpoch(actor);
        ActorRecordV1 record = new ActorRecordV1(actor.id(), actor.organizationId(), 1,
                RecordStatus.ACTIVE, actor.roles(), List.of(key), new byte[0]);

        return new Change("actor-" + actor.id() + "-r1", Chain.ACTORS_TOPIC,
                new RegistryMutationV1.PutActor(record,
                        List.of(ActorKeyProofV1.sign(Chain.CHAIN_ID, actor.id(), 1, key,
                                actor.demoSeed()))).encode(),
                "actor " + actor.displayName() + " revision 1 (ACTIVE)");
    }

    /**
     * Change a registered person's status — suspend or revoke them.
     *
     * <p>Two rules worth knowing, both enforced by the registry:
     *
     * <ul>
     *   <li>The new revision must be exactly {@code current + 1}, and it may not
     *       drop a key epoch the previous revision held. A revoked actor keeps
     *       its keys on record; the <em>status</em> is what stops future
     *       decisions, so history stays intact and verifiable.</li>
     *   <li>Proof-of-possession is required only for keys being introduced.
     *       This revision reuses the existing key, so it carries <b>no</b>
     *       proofs — the registry checks {@code keyProofs().size() == newKeys}
     *       and rejects the mutation as a silent no-op if that does not hold.</li>
     * </ul>
     */
    public static Change changeActorStatus(Cast.Actor actor, long revision, RecordStatus status) {
        ActorRecordV1 record = new ActorRecordV1(actor.id(), actor.organizationId(), revision,
                status, actor.roles(), List.of(keyEpoch(actor)), new byte[0]);

        return new Change("actor-" + actor.id() + "-r" + revision, Chain.ACTORS_TOPIC,
                new RegistryMutationV1.PutActor(record, List.of()).encode(),
                "actor " + actor.displayName() + " revision " + revision + " (" + status + ")");
    }

    private static ActorKeyEpochV1 keyEpoch(Cast.Actor actor) {
        return new ActorKeyEpochV1(actor.keyId(), publicKey(actor.demoSeed()), 1, 0,
                RecordStatus.ACTIVE);
    }

    public static Change putPolicy(ApprovalPolicyV1 policy) {
        return new Change("policy-" + policy.policyId() + "-r" + policy.revision(),
                Chain.ROLE_TOPIC, new PolicyMutationV1.PutPolicy(policy).encode(),
                "policy " + policy.policyId() + " revision " + policy.revision());
    }

    /** Ed25519 public key for a raw 32-byte seed — what an actor's own tooling would publish. */
    public static byte[] publicKey(byte[] seed) {
        return new Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().getEncoded();
    }

    // ---------------------------------------------------------- applying them

    /**
     * Run a batch of changes through propose → approve → activate.
     *
     * <p>They are pipelined by phase rather than one at a time: all proposals,
     * then all approvals, then all activations. Ordering only matters within a
     * single mutation, and this turns a long ceremony into three rounds.
     */
    public void apply(List<Change> changes, Consumer<String> progress) {
        if (changes.isEmpty()) {
            return;
        }
        long expiry = chain.tipHeight() + 9_000;   // ~30 min at 200ms blocks

        progress.accept("propose   " + changes.size() + " change(s) via member 0");
        chain.awaitAllFinalized(changes.stream()
                .map(change -> chain.submit(0, change.topic(),
                        new GovernedMutationCommandV1.Propose(
                                change.mutationId(), change.mutation(), expiry).encode()))
                .toList());

        progress.accept("approve   via member 1 — reaches the 2-of-3 threshold");
        chain.awaitAllFinalized(changes.stream()
                .map(change -> chain.submit(1, change.topic(),
                        new GovernedMutationCommandV1.Approve(
                                change.mutationId(), change.hash()).encode()))
                .toList());

        progress.accept("activate  applying the approved changes");
        chain.awaitAllFinalized(changes.stream()
                .map(change -> chain.submit(0, change.topic(),
                        new GovernedMutationCommandV1.Activate(
                                change.mutationId(), change.hash()).encode()))
                .toList());
    }

    // ------------------------------------------------------------- the cast

    /** Every organization, actor and policy this scenario starts with. */
    public List<Change> genesisChanges() {
        List<Change> changes = new ArrayList<>();
        Cast.ORGANIZATIONS.forEach(org -> changes.add(putOrganization(org, 1)));
        Cast.genesisActors().forEach(actor -> changes.add(registerActor(actor)));
        changes.addAll(Policies.all().stream().map(Registry::putPolicy).toList());
        return changes;
    }

    // ------------------------------------------------------------- reading

    public boolean isBootstrapped() {
        JsonNode policy = chain.policyRecord(Policies.QP_RELEASE);
        return policy != null && !policy.path("recordValue").isMissingNode();
    }

    /** Current revision of an actor, or -1 when it is not registered. */
    public long actorRevision(String actorId) {
        JsonNode record = chain.actorRecord(actorId);
        if (record == null || record.path("recordValue").isMissingNode()) {
            return -1;
        }
        return decodeActor(record).revision();
    }

    public ActorRecordV1 decodeActor(JsonNode record) {
        String hex = record.path("recordValue").asText(null);
        if (hex == null) {
            return null;
        }
        return ActorRecordV1.decode(org.yanoproject.x.client.Hex.decode(hex));
    }

    public ActorRecordV1 actor(String actorId) {
        JsonNode record = chain.actorRecord(actorId);
        return record == null ? null : decodeActor(record);
    }
}
