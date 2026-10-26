package com.agy.roleplay;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.text.Normalizer;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Random;
import java.util.Set;

/**
 * Desktop JVM tests for {@link CloudCrypto}, run by android/build-apk.ps1 with
 * the JDK (no JUnit). The fixed vectors are shared with
 * mobile/tests/cloud-format.test.js, which computes them independently with
 * Node's crypto, so the Java and Node sides cannot drift apart.
 *
 *   java -cp <classes> com.agy.roleplay.CloudCryptoTest          run the tests
 *   java -cp <classes> com.agy.roleplay.CloudCryptoTest --emit   print the Java-made vector
 */
public final class CloudCryptoTest {
    // ---- shared vectors (see mobile/tests/cloud-format.test.js) -----------------
    static final String UID = "uid-test-0001";
    static final String SID = "0123456789abcdef0123456789abcdef";
    static final String ENC_KEY = "04bfc0d4b0c67a0ce0f6907209ae873fb131c574afd7ddfa979061156154d108";
    static final String ID_KEY = "98f024947690274391ff22284f9e4cadc6a68ed8e71849af0b9a1f4d9916e41b";
    static final String KID = "c49b1c12fbdcbc0c";
    static final String DOC_ID = "1dc645cc94c8526c3b1238e19f49d5de";
    static final String P1 = "{\"k\":\"message\",\"sid\":\"0123456789abcdef0123456789abcdef\",\"mt\":1761470000000,"
        + "\"content\":\"Привет, мир! *улыбается*\"}";
    static final String BLOB1 = "0100a0a1a2a3a4a5a6a7a8a9aaab7f241e46df4489c6b7b5205ac41e32adc025e0ecac1ef4389e92b011040802bd"
        + "519860efb94d00477b5e41fae979ad0239b06a21daab87d58c0ef7c9fd10219adde8ddda5e2224dca7f0a57c57d44ff67cc48e97ec2df44d"
        + "77289d9a034703be2e44b04f1029a439252a34aa242e63d6d455db9b8323ee9f13790b512012c218776964ea978666ce4b2cea539ddd4304878a";
    /** Built from P2 by Node (zlib deflateRaw). */
    static final String BLOB2 = "0101b0b1b2b3b4b5b6b7b8b9babb35f5ea4b78bc03a184667e977aa5f5b0767ca3a037954a6f0149f94fe7e1a129e4"
        + "cfd0e7350fdfef1e45fa10cfa075e4ffea3f296c9552c5ed3416b28a6850b8e18524bfefccf656cdb75aafded997d34d7aa5c4a0ba7c3b5ee"
        + "f4fa1c9d2da95ece1e22a94f6825515a972347577a80432edf484ae05519b1ca38a2c12e53f03bd";
    /** Built from P2 by this class (--emit), so Node opens a Java deflate stream too. */
    static final String BLOB3 = "0101e0e1e2e3e4e5e6e7e8e9eaeb8f6af39e4cdfe4e2a2316cd4bc312d35742b2cc58a40651eda4759bec4929e0"
        + "14f2c97b7364c74c9b345b3509be5205747be207d3b0588f50c2ceb05fdb4c760874d7cfa0b3aa5e5e44b089ea186d80b69d6f67f4c1f431"
        + "7617743d84603c621f07f70be062e79de80c9880544ad9f1b232e66f3faaf5d4b70ed7683";
    static final String PASSWORD = "Пароль для теста 2026";
    static final String KEK = "e0408ad3d4cf898a20faefd5f12f3f71f0688ac6348715b74974d12aee3dbe93";
    static final String PW_WRAPPED = "c0c1c2c3c4c5c6c7c8c9cacbef286a0aea9f2db15ec0fe8dbd040277ae4a352269617c347b514aaabe8851596d00"
        + "4b9e95ca66e3114ae4c0766f22df";
    static final String TAJNYJ = "Тайный ключ";
    static final String KEK_TAJNYJ = "200635afc24d7351ac71ec30da754412f92315ac32897885fd870f9f41067fec";
    static final String CODE = "000G-40R4-0M30-E209-185G-R38E-1W81-24GK";
    static final String RK = "42016050bfc0356055604e42ac95ac6e2d4b8c435080d9ebc19afce9534a637b";
    static final String RC_WRAPPED = "d0d1d2d3d4d5d6d7d8d9dadbb6cc36b04bc3bf16c793f5e678f59c58e21baaa6a68ac5d13237380e5ddcafcec8aa"
        + "2a67e3a0431ecccb1025e1c4af9d";

    static String p2() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 40; i++) sb.append("Длинная реплика. ");
        return "{\"k\":\"message\",\"sid\":\"" + SID + "\",\"mt\":1761470000001,\"content\":\"" + sb + "\"}";
    }

    static byte[] seq(int start, int n) {
        byte[] b = new byte[n];
        for (int i = 0; i < n; i++) b[i] = (byte) (start + i);
        return b;
    }

    static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    // ---- tiny runner ----------------------------------------------------------------
    interface Check {
        void run() throws Exception;
    }

    private static int passed = 0;
    private static int failed = 0;

    static void test(String name, Check check) {
        try {
            check.run();
            passed++;
            System.out.println("ok   " + name);
        } catch (Throwable t) {
            failed++;
            System.out.println("FAIL " + name + ": " + t);
        }
    }

    static void eq(Object expected, Object actual, String what) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(what + ": expected <" + expected + "> but was <" + actual + ">");
        }
    }

    static void eqBytes(byte[] expected, byte[] actual, String what) {
        if (!Arrays.equals(expected, actual)) {
            throw new AssertionError(what + ": expected " + CloudCrypto.hex(expected) + " but was "
                + (actual == null ? "null" : CloudCrypto.hex(actual)));
        }
    }

    static void yes(boolean condition, String what) {
        if (!condition) throw new AssertionError(what);
    }

    static void rejects(Check check, String what) {
        try {
            check.run();
        } catch (GeneralSecurityException expected) {
            return;
        } catch (Exception other) {
            throw new AssertionError(what + ": wrong exception " + other);
        }
        throw new AssertionError(what + ": accepted");
    }

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && "--emit".equals(args[0])) {
            byte[] blob = CloudCrypto.seal(CloudCrypto.unhex(ENC_KEY), utf8(p2()), UID, DOC_ID, seq(0xe0, 12), true);
            System.out.println(CloudCrypto.hex(blob));
            return;
        }
        final byte[] dek = seq(0, 32);
        final byte[] encKey = CloudCrypto.unhex(ENC_KEY);

        test("PBKDF2-HMAC-SHA256 matches RFC 7914 vectors", () -> {
            eq("55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783",
                CloudCrypto.hex(CloudCrypto.pbkdf2Sha256(utf8("passwd"), utf8("salt"), 1, 64)), "c=1");
            eq("4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d",
                CloudCrypto.hex(CloudCrypto.pbkdf2Sha256(utf8("Password"), utf8("NaCl"), 80000, 64)), "c=80000");
        });

        test("subkeys, vault id and document id match the shared vectors", () -> {
            eq(ENC_KEY, CloudCrypto.hex(CloudCrypto.encKey(dek)), "encKey");
            eq(ID_KEY, CloudCrypto.hex(CloudCrypto.idKey(dek)), "idKey");
            eq(KID, CloudCrypto.keyId(dek), "kid");
            eq(DOC_ID, CloudCrypto.docId(CloudCrypto.idKey(dek), "message", SID), "docId");
            yes(!DOC_ID.equals(CloudCrypto.docId(CloudCrypto.idKey(dek), "chat", SID)), "kind changes the document id");
        });

        test("an uncompressed record is byte-for-byte the shared vector", () -> {
            byte[] blob = CloudCrypto.seal(encKey, utf8(P1), UID, DOC_ID, seq(0xa0, 12), false);
            eq(BLOB1, CloudCrypto.hex(blob), "blob1");
            eq(P1, new String(CloudCrypto.open(encKey, blob, UID, DOC_ID), StandardCharsets.UTF_8), "open blob1");
        });

        test("records deflated by Node and by Java both open", () -> {
            eq(p2(), new String(CloudCrypto.open(encKey, CloudCrypto.unhex(BLOB2), UID, DOC_ID), StandardCharsets.UTF_8), "blob2");
            eq(p2(), new String(CloudCrypto.open(encKey, CloudCrypto.unhex(BLOB3), UID, DOC_ID), StandardCharsets.UTF_8), "blob3");
            byte[] own = CloudCrypto.seal(encKey, utf8(p2()), UID, DOC_ID);
            eq(CloudCrypto.FLAG_DEFLATE, (int) own[1], "repetitive text is deflated");
            yes(own.length < utf8(p2()).length, "deflated record is smaller");
        });

        test("round trip of empty, small, text and random payloads", () -> {
            Random rnd = new Random(7);
            byte[] noise = new byte[100_000];
            rnd.nextBytes(noise);
            StringBuilder text = new StringBuilder();
            for (int i = 0; i < 3000; i++) text.append("*Кира кивает.* «Да.» ");
            byte[][] payloads = {new byte[0], utf8("x"), utf8(text.toString()), noise};
            for (byte[] p : payloads) {
                byte[] blob = CloudCrypto.seal(encKey, p, UID, DOC_ID);
                eqBytes(p, CloudCrypto.open(encKey, blob, UID, DOC_ID), "payload of " + p.length + " bytes");
            }
            eq(0, (int) CloudCrypto.seal(encKey, noise, UID, DOC_ID)[1], "random bytes are stored uncompressed");
            byte[] a = CloudCrypto.seal(encKey, utf8(P1), UID, DOC_ID);
            byte[] b = CloudCrypto.seal(encKey, utf8(P1), UID, DOC_ID);
            yes(!Arrays.equals(a, b), "every seal uses a fresh IV");
        });

        test("any changed byte, account, document or key is rejected", () -> {
            final byte[] blob = CloudCrypto.unhex(BLOB1);
            for (int i = 0; i < blob.length; i++) {
                final byte[] bad = blob.clone();
                bad[i] ^= 0x01;
                rejects(() -> CloudCrypto.open(encKey, bad, UID, DOC_ID), "flipped byte " + i);
            }
            rejects(() -> CloudCrypto.open(encKey, blob, "uid-other", DOC_ID), "other account");
            rejects(() -> CloudCrypto.open(encKey, blob, UID, "1dc645cc94c8526c3b1238e19f49d5df"), "other document");
            rejects(() -> CloudCrypto.open(CloudCrypto.idKey(dek), blob, UID, DOC_ID), "other key");
            rejects(() -> CloudCrypto.open(encKey, Arrays.copyOf(blob, 29), UID, DOC_ID), "truncated");
            rejects(() -> CloudCrypto.open(encKey, null, UID, DOC_ID), "null");
            final byte[] v2 = blob.clone();
            v2[0] = 2;
            rejects(() -> CloudCrypto.open(encKey, v2, UID, DOC_ID), "unknown version");
            final byte[] flags = blob.clone();
            flags[1] = 4;
            rejects(() -> CloudCrypto.open(encKey, flags, UID, DOC_ID), "unknown flags");
        });

        test("a record that inflates past the limit is refused", () -> {
            final byte[] bomb = CloudCrypto.seal(encKey, new byte[CloudCrypto.MAX_PLAINTEXT_BYTES + 1024], UID, DOC_ID);
            yes(bomb.length < 200_000, "zeros compress well");
            rejects(() -> CloudCrypto.open(encKey, bomb, UID, DOC_ID), "decompression bomb");
            rejects(() -> CloudCrypto.inflate(new byte[]{1, 2, 3, 4, 5}, 1000), "garbage stream");
        });

        test("the password key matches Node and ignores Unicode normalization", () -> {
            eq(KEK, CloudCrypto.hex(CloudCrypto.passwordKey(PASSWORD, seq(0x10, 16), 1000)), "kek");
            String nfd = Normalizer.normalize(TAJNYJ, Normalizer.Form.NFD);
            yes(!nfd.equals(TAJNYJ), "the NFD form differs");
            eq(KEK_TAJNYJ, CloudCrypto.hex(CloudCrypto.passwordKey(nfd, seq(0x10, 16), 1000)), "NFD password");
            eq(KEK_TAJNYJ, CloudCrypto.hex(CloudCrypto.passwordKey(TAJNYJ, seq(0x10, 16), 1000)), "NFC password");
            yes(!KEK.equals(CloudCrypto.hex(CloudCrypto.passwordKey(PASSWORD + " ", seq(0x10, 16), 1000))), "spaces count");
        });

        test("the data key wraps and unwraps only with the right key, account and slot", () -> {
            final byte[] kek = CloudCrypto.unhex(KEK);
            final byte[] wrapped = CloudCrypto.wrapKey(kek, dek, UID, "pw", seq(0xc0, 12));
            eq(PW_WRAPPED, CloudCrypto.hex(wrapped), "wrapped");
            eqBytes(dek, CloudCrypto.unwrapKey(kek, wrapped, UID, "pw"), "unwrapped");
            final byte[] wrongKek = CloudCrypto.passwordKey("Пароль для теста 2025", seq(0x10, 16), 1000);
            rejects(() -> CloudCrypto.unwrapKey(wrongKek, wrapped, UID, "pw"), "wrong password");
            rejects(() -> CloudCrypto.unwrapKey(kek, wrapped, UID, "rc"), "other slot");
            rejects(() -> CloudCrypto.unwrapKey(kek, wrapped, "uid-other", "pw"), "other account");
            rejects(() -> CloudCrypto.unwrapKey(kek, Arrays.copyOf(wrapped, 40), UID, "pw"), "short");
            byte[] fresh = CloudCrypto.wrapKey(kek, dek, UID, "pw");
            yes(!Arrays.equals(fresh, wrapped), "random IV by default");
            eqBytes(dek, CloudCrypto.unwrapKey(kek, fresh, UID, "pw"), "fresh wrap");
        });

        test("recovery codes format, parse leniently and derive the shared key", () -> {
            byte[] raw = seq(0, 20);
            eq(CODE, CloudCrypto.formatRecoveryCode(raw), "code");
            eqBytes(raw, CloudCrypto.parseRecoveryCode(CODE), "parse");
            eqBytes(raw, CloudCrypto.parseRecoveryCode("ooog 4or4 om3o e2o9 l85g r38e iw8l 24gk"), "lenient parse");
            eq(null, CloudCrypto.parseRecoveryCode("000G-40R4-0M30-E209-185G-R38E-1W81-24GU"), "U is not a digit");
            eq(null, CloudCrypto.parseRecoveryCode("000G-40R4-0M30"), "too short");
            eq(null, CloudCrypto.parseRecoveryCode(CODE + "0"), "too long");
            eq(null, CloudCrypto.parseRecoveryCode(null), "null");
            byte[] rk = CloudCrypto.recoveryKey(raw);
            eq(RK, CloudCrypto.hex(rk), "recovery key");
            eq(RC_WRAPPED, CloudCrypto.hex(CloudCrypto.wrapKey(rk, dek, UID, "rc", seq(0xd0, 12))), "rc wrap");
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < 50; i++) {
                String code = CloudCrypto.newRecoveryCode();
                yes(code.matches("[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}"), "format of " + code);
                yes(CloudCrypto.parseRecoveryCode(code) != null, "parses back");
                yes(seen.add(code), "unique");
            }
        });

        test("sync ids and hex helpers", () -> {
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < 200; i++) {
                String id = CloudCrypto.newSyncId();
                yes(id.matches("[0-9a-f]{32}"), "sync id " + id);
                yes(seen.add(id), "unique sync id");
            }
            eqBytes(seq(0, 32), CloudCrypto.unhex(CloudCrypto.hex(seq(0, 32))), "hex round trip");
        });

        test("600 000 PBKDF2 iterations stay usable", () -> {
            long t0 = System.nanoTime();
            CloudCrypto.passwordKey(PASSWORD, seq(0x10, 16), CloudCrypto.PBKDF2_ITERATIONS);
            long ms = (System.nanoTime() - t0) / 1_000_000L;
            System.out.println("     (PBKDF2 x" + CloudCrypto.PBKDF2_ITERATIONS + " on this JVM: " + ms + " ms)");
            yes(ms < 20_000, "took " + ms + " ms");
        });

        System.out.println(passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }
}
