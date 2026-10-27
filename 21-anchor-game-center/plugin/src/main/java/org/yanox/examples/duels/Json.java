package org.yanox.examples.duels;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A strict, bounded JSON reader and a canonical writer — just what the duel
 * messages and the committed duel records need. Objects keep their insertion
 * order, so a record always serializes to the same bytes on every member.
 * Numbers are integers only; anything else is malformed.
 */
final class Json {
    private static final int MAX_DEPTH = 16;

    private final String text;
    private int at;

    private Json(String text) {
        this.text = text;
    }

    /** Parse, or throw IllegalArgumentException for anything malformed. */
    static Object parse(String text) {
        Json json = new Json(text);
        Object value = json.value(0);
        json.space();
        if (json.at != text.length()) {
            throw new IllegalArgumentException("trailing characters");
        }
        return value;
    }

    private Object value(int depth) {
        if (depth > MAX_DEPTH) {
            throw new IllegalArgumentException("too deep");
        }
        space();
        if (at >= text.length()) {
            throw new IllegalArgumentException("unexpected end");
        }
        char c = text.charAt(at);
        return switch (c) {
            case '{' -> object(depth);
            case '[' -> array(depth);
            case '"' -> string();
            case 't' -> literal("true", Boolean.TRUE);
            case 'f' -> literal("false", Boolean.FALSE);
            case 'n' -> literal("null", null);
            default -> number();
        };
    }

    private Map<String, Object> object(int depth) {
        Map<String, Object> map = new LinkedHashMap<>();
        at++;
        space();
        if (peek('}')) {
            at++;
            return map;
        }
        while (true) {
            space();
            String key = string();
            space();
            expect(':');
            if (map.put(key, value(depth + 1)) != null) {
                throw new IllegalArgumentException("duplicate key");
            }
            space();
            if (peek(',')) {
                at++;
                continue;
            }
            expect('}');
            return map;
        }
    }

    private List<Object> array(int depth) {
        List<Object> list = new ArrayList<>();
        at++;
        space();
        if (peek(']')) {
            at++;
            return list;
        }
        while (true) {
            list.add(value(depth + 1));
            space();
            if (peek(',')) {
                at++;
                continue;
            }
            expect(']');
            return list;
        }
    }

    private String string() {
        expect('"');
        StringBuilder out = new StringBuilder();
        while (true) {
            if (at >= text.length()) {
                throw new IllegalArgumentException("unterminated string");
            }
            char c = text.charAt(at++);
            if (c == '"') {
                return out.toString();
            }
            if (c < 0x20) {
                throw new IllegalArgumentException("control character in string");
            }
            if (c != '\\') {
                out.append(c);
                continue;
            }
            char e = text.charAt(at++);
            switch (e) {
                case '"', '\\', '/' -> out.append(e);
                case 'b' -> out.append('\b');
                case 'f' -> out.append('\f');
                case 'n' -> out.append('\n');
                case 'r' -> out.append('\r');
                case 't' -> out.append('\t');
                case 'u' -> {
                    out.append((char) Integer.parseInt(text.substring(at, at + 4), 16));
                    at += 4;
                }
                default -> throw new IllegalArgumentException("bad escape");
            }
        }
    }

    private Long number() {
        int start = at;
        if (peek('-')) {
            at++;
        }
        while (at < text.length() && Character.isDigit(text.charAt(at))) {
            at++;
        }
        if (at == start || (at < text.length() && ".eE".indexOf(text.charAt(at)) >= 0)) {
            throw new IllegalArgumentException("only integers are accepted");
        }
        return Long.parseLong(text.substring(start, at));
    }

    private Object literal(String word, Object value) {
        if (!text.startsWith(word, at)) {
            throw new IllegalArgumentException("bad literal");
        }
        at += word.length();
        return value;
    }

    private void space() {
        while (at < text.length() && " \t\r\n".indexOf(text.charAt(at)) >= 0) {
            at++;
        }
    }

    private boolean peek(char c) {
        return at < text.length() && text.charAt(at) == c;
    }

    private void expect(char c) {
        if (!peek(c)) {
            throw new IllegalArgumentException("expected " + c);
        }
        at++;
    }

    /** Canonical text: no whitespace, insertion order, integers only. */
    static String write(Object value) {
        StringBuilder out = new StringBuilder();
        write(value, out);
        return out.toString();
    }

    private static void write(Object value, StringBuilder out) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof String s) {
            out.append('"');
            for (char c : s.toCharArray()) {
                switch (c) {
                    case '"' -> out.append("\\\"");
                    case '\\' -> out.append("\\\\");
                    default -> {
                        if (c < 0x20) {
                            out.append(String.format("\\u%04x", (int) c));
                        } else {
                            out.append(c);
                        }
                    }
                }
            }
            out.append('"');
        } else if (value instanceof Boolean || value instanceof Long || value instanceof Integer) {
            out.append(value);
        } else if (value instanceof Map<?, ?> map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : map.entrySet()) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                write(String.valueOf(e.getKey()), out);
                out.append(':');
                write(e.getValue(), out);
            }
            out.append('}');
        } else if (value instanceof List<?> list) {
            out.append('[');
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) {
                    out.append(',');
                }
                write(list.get(i), out);
            }
            out.append(']');
        } else {
            throw new IllegalArgumentException("cannot write " + value.getClass());
        }
    }
}
