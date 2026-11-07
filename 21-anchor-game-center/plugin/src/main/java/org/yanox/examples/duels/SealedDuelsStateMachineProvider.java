package org.yanox.examples.duels;

import com.bloxbean.cardano.yaci.core.protocol.appmsg.model.AppMessage;
import org.yanoproject.api.appchain.AppBlockExecutionContext;
import org.yanoproject.api.appchain.AppChainInfo;
import org.yanoproject.api.appchain.AppQueryContext;
import org.yanoproject.api.appchain.AppQueryException;
import org.yanoproject.api.appchain.AppStateMachine;
import org.yanoproject.api.appchain.AppStateMachineProvider;
import org.yanoproject.api.appchain.AppStateReader;
import org.yanoproject.api.appchain.AppStateWriter;
import org.yanoproject.api.appchain.effects.AppEffectEmitter;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.regex.Pattern;

/**
 * The Sealed Duels state machine: {@link Duels} wired into the host.
 *
 * <ul>
 *   <li>{@code validateForBlock}: refuses broken moves against committed state
 *       before they are pooled (HTTP 400 with a public code).</li>
 *   <li>{@code apply}: runs the rules on every finalized message, in order, and
 *       commits {@code duel/<id>}, {@code topic/<prefix>} and {@code nonce/<id>}.</li>
 *   <li>{@code query("duel", <id>)}: the committed duel record as JSON.</li>
 *   <li>{@code query("admit", <topic> LF <body>)}: the members' verdict on a move
 *       before it is sent, as {@code {"accepted":false,"code":...,"reason":...}}.
 *       Hosts from Yano 0.1.0-pre17 also refuse at submit with HTTP 400; older
 *       hosts drop a refused move when the block is built, without a reply.</li>
 * </ul>
 */
public final class SealedDuelsStateMachineProvider implements AppStateMachineProvider {
    public static final String ID = "sealed-duels";

    @Override
    public String id() {
        return ID;
    }

    @Override
    public AppStateMachine create() {
        return new Machine();
    }

    private static final class Machine implements AppStateMachine {
        private static final Pattern DUEL_ID = Pattern.compile("[0-9a-f]{64}");
        private volatile Duels rules = new Duels("duels-chain");

        @Override
        public String id() {
            return ID;
        }

        @Override
        public void init(AppStateReader state, AppChainInfo info) {
            // Moves sign the chain id, so a move cannot be replayed on another chain.
            rules = new Duels(info.chainId());
        }

        @Override
        public AdmissionResult validate(AppMessage message) {
            return Duels.isGameTopic(message.getTopic()) ? AdmissionResult.accept() : AdmissionResult.reject("WRONG_TOPIC");
        }

        @Override
        public AdmissionResult validateForBlock(AppMessage message, long candidateHeight, AppStateReader committedState) {
            Duels.Outcome outcome = rules.admit(store(committedState, null), message.getTopic(), message.getBody());
            return outcome.accepted() ? AdmissionResult.accept() : AdmissionResult.reject(outcome.code());
        }

        @Override
        public void apply(AppBlockExecutionContext context, AppStateWriter writer, AppEffectEmitter effects) {
            // Writes become readable only after the block commits, so the block's
            // own writes are kept here for the later messages of the same block.
            Map<String, String> staged = new TreeMap<>(); // sorted: the same write order on every member
            Duels.Store store = store(writer, staged);
            long height = context.block().height();
            long timestamp = context.block().timestamp();
            int visible = 0;
            for (AppMessage message : context.messages()) {
                int index = context.originalMessageIndex(visible++);
                rules.apply(store, message.getTopic(), message.getBody(), timestamp, height, index, message.getMessageIdHex());
            }
            for (Map.Entry<String, String> e : staged.entrySet()) {
                writer.put(e.getKey().getBytes(StandardCharsets.UTF_8), e.getValue().getBytes(StandardCharsets.UTF_8));
            }
        }

        @Override
        public byte[] query(String path, byte[] params, AppQueryContext state) {
            if ("admit".equals(path)) {
                return admit(params == null ? new byte[0] : params, state);
            }
            if (!"duel".equals(path)) {
                throw new AppQueryException(AppQueryException.Code.UNSUPPORTED, "unknown query " + path);
            }
            String id = params == null ? "" : new String(params, StandardCharsets.UTF_8);
            if (!DUEL_ID.matcher(id).matches()) {
                throw new AppQueryException(AppQueryException.Code.INVALID_REQUEST, "params must be a 64-hex duel id");
            }
            return state.get(("duel/" + id).getBytes(StandardCharsets.UTF_8))
                    .orElse("null".getBytes(StandardCharsets.UTF_8));
        }

        private byte[] admit(byte[] params, AppQueryContext state) {
            int split = 0;
            while (split < params.length && params[split] != '\n') {
                split++;
            }
            if (split == params.length) {
                throw new AppQueryException(AppQueryException.Code.INVALID_REQUEST, "params must be <topic> LF <body>");
            }
            String topic = new String(params, 0, split, StandardCharsets.UTF_8);
            byte[] body = Arrays.copyOfRange(params, split + 1, params.length);
            Duels.Outcome outcome = Duels.isGameTopic(topic)
                    ? rules.admit(store(state, null), topic, body)
                    : new Duels.Outcome("WRONG_TOPIC", "not a Sealed Duels topic");
            Map<String, Object> verdict = new LinkedHashMap<>();
            verdict.put("accepted", outcome.accepted());
            if (!outcome.accepted()) {
                verdict.put("code", outcome.code());
                verdict.put("reason", outcome.reason());
            }
            return Json.write(verdict).getBytes(StandardCharsets.UTF_8);
        }

        private static Duels.Store store(AppStateReader reader, Map<String, String> staged) {
            return new Duels.Store() {
                @Override
                public Optional<String> get(String key) {
                    if (staged != null && staged.containsKey(key)) {
                        return Optional.of(staged.get(key));
                    }
                    return reader.get(key.getBytes(StandardCharsets.UTF_8)).map(v -> new String(v, StandardCharsets.UTF_8));
                }

                @Override
                public void put(String key, String value) {
                    if (staged == null) {
                        throw new IllegalStateException("admission never writes");
                    }
                    staged.put(key, value);
                }
            };
        }
    }
}
