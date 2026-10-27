package org.yanox.examples.duels;

import org.junit.jupiter.api.Test;
import org.yanoproject.api.appchain.AppQueryContext;
import org.yanoproject.api.appchain.AppQueryException;
import org.yanoproject.api.appchain.AppStateMachine;

import java.nio.charset.StandardCharsets;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ProviderQueryTest {

    /** An empty committed state at height 0. */
    private static final AppQueryContext EMPTY = new AppQueryContext() {
        @Override
        public long committedHeight() {
            return 0;
        }

        @Override
        public Optional<byte[]> get(byte[] key) {
            return Optional.empty();
        }

        @Override
        public byte[] stateRoot() {
            return new byte[32];
        }
    };

    private static String query(AppStateMachine machine, String path, String params) {
        return new String(machine.query(path, params.getBytes(StandardCharsets.UTF_8), EMPTY), StandardCharsets.UTF_8);
    }

    @Test
    void admitQueryReturnsTheMembersVerdict() {
        AppStateMachine machine = new SealedDuelsStateMachineProvider().create();
        assertEquals("{\"accepted\":false,\"code\":\"WRONG_TOPIC\",\"reason\":\"not a Sealed Duels topic\"}",
                query(machine, "admit", "orders.command.v1\n{}"));
        assertEquals("{\"accepted\":false,\"code\":\"MALFORMED\",\"reason\":\"not a JSON object\"}",
                query(machine, "admit", "anchor-duels.v1.lobby.h1\nnot json"));
        assertEquals("{\"accepted\":false,\"code\":\"NO_SUCH_DUEL\",\"reason\":\"no accepted duel on this topic\"}",
                query(machine, "admit", "anchor-duels.v1.d0123456789abcdef\n{\"t\":\"seal\"}"));
        assertThrows(AppQueryException.class, () -> query(machine, "admit", "no separator"));
    }

    @Test
    void duelQueryReturnsNullForAnUnknownDuel() {
        AppStateMachine machine = new SealedDuelsStateMachineProvider().create();
        assertEquals("null", query(machine, "duel", "00".repeat(32)));
        assertThrows(AppQueryException.class, () -> query(machine, "duel", "not-an-id"));
    }
}
