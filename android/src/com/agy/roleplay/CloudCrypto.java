package com.agy.roleplay;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.util.Arrays;
import java.util.zip.DataFormatException;
import java.util.zip.Deflater;
import java.util.zip.Inflater;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * End-to-end encryption of the cloud copy (see {@link CloudSync}). Only the
 * phone ever holds the keys: Firebase stores ciphertext and a server timestamp.
 *
 * Pure JDK, no android.* classes, so android/tests/CloudCryptoTest.java runs it
 * on the PC. mobile/tests/cloud-format.test.js mirrors these formats with
 * Node's crypto: change one, change both.
 *
 * Keys
 *   DEK  random 256-bit data key, one per account (the "vault")
 *   KEK  PBKDF2-HMAC-SHA256(NFC UTF-8 password, 16-byte salt, iterations)
 *   RK   HMAC-SHA256(recovery code bytes, "agy/recovery/v1")
 *   KEK and RK each wrap the DEK with AES-256-GCM. The DEK is never used
 *   directly: its subkeys are HMAC-SHA256(DEK, label) with "agy/enc/v1"
 *   (records), "agy/id/v1" (document names) and "agy/kid/v1" (vault id).
 *
 * Record blob
 *   [0x01 version][flags, 0x01 = raw deflate][IV 12][ciphertext + 16-byte tag]
 *   AES-256-GCM, AAD = the two header bytes + "agy/rec/v1|" + uid + "|" + docId,
 *   so a blob only opens for the account and the document it was written for.
 *
 * Wrapped key
 *   [IV 12][ciphertext + tag], AAD = "agy/vault/v1|" + uid + "|" + slot ("pw" or "rc").
 */
final class CloudCrypto {
    static final int FORMAT_VERSION = 1;
    static final int FLAG_DEFLATE = 1;
    static final int KEY_BYTES = 32;
    static final int SALT_BYTES = 16;
    static final int IV_BYTES = 12;
    static final int TAG_BYTES = 16;
    /** OWASP (2023) minimum for PBKDF2-HMAC-SHA256; the vault stores its own count, so it can be raised. */
    static final int PBKDF2_ITERATIONS = 600_000;
    /** Cloud data is not trusted to be small: a record never inflates beyond this. */
    static final int MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
    static final int RECOVERY_BYTES = 20;

    private static final String CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    private static final SecureRandom RANDOM = new SecureRandom();

    private CloudCrypto() {
    }

    static byte[] randomBytes(int n) {
        byte[] b = new byte[n];
        RANDOM.nextBytes(b);
        return b;
    }

    static byte[] newDataKey() {
        return randomBytes(KEY_BYTES);
    }

    /** A random 128-bit id for a synced row (sync_id). */
    static String newSyncId() {
        return hex(randomBytes(16));
    }

    // ---- subkeys and document names ------------------------------------------

    static byte[] hmac(byte[] key, byte[] data) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    private static byte[] subkey(byte[] dek, String label) throws GeneralSecurityException {
        return hmac(dek, label.getBytes(StandardCharsets.UTF_8));
    }

    static byte[] encKey(byte[] dek) throws GeneralSecurityException {
        return subkey(dek, "agy/enc/v1");
    }

    static byte[] idKey(byte[] dek) throws GeneralSecurityException {
        return subkey(dek, "agy/id/v1");
    }

    /** Identifies a vault without revealing its key: another device notices a re-created vault. */
    static String keyId(byte[] dek) throws GeneralSecurityException {
        return hex(subkey(dek, "agy/kid/v1")).substring(0, 16);
    }

    /**
     * The Firestore document name of a record. Keyed, so the cloud cannot tell
     * kinds apart or link a chat to its messages.
     */
    static String docId(byte[] idKey, String kind, String sid) throws GeneralSecurityException {
        return hex(hmac(idKey, (kind + "\n" + sid).getBytes(StandardCharsets.UTF_8))).substring(0, 32);
    }

    // ---- records ---------------------------------------------------------------

    static byte[] seal(byte[] encKey, byte[] plain, String uid, String docId) throws GeneralSecurityException {
        return seal(encKey, plain, uid, docId, randomBytes(IV_BYTES), true);
    }

    /** With a caller's IV: only the tests use it, to pin the format. */
    static byte[] seal(byte[] encKey, byte[] plain, String uid, String docId, byte[] iv, boolean allowDeflate)
        throws GeneralSecurityException {
        byte[] body = plain;
        int flags = 0;
        if (allowDeflate) {
            byte[] packed = deflate(plain);
            if (packed.length < plain.length) {
                body = packed;
                flags = FLAG_DEFLATE;
            }
        }
        byte[] header = new byte[]{(byte) FORMAT_VERSION, (byte) flags};
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(encKey, "AES"), new GCMParameterSpec(TAG_BYTES * 8, iv));
        cipher.updateAAD(recordAad(header, uid, docId));
        byte[] ct = cipher.doFinal(body);
        byte[] out = new byte[header.length + iv.length + ct.length];
        System.arraycopy(header, 0, out, 0, header.length);
        System.arraycopy(iv, 0, out, header.length, iv.length);
        System.arraycopy(ct, 0, out, header.length + iv.length, ct.length);
        return out;
    }

    /** Decrypts a record; throws on a wrong key, another account or document, or any changed byte. */
    static byte[] open(byte[] encKey, byte[] blob, String uid, String docId) throws GeneralSecurityException {
        if (blob == null || blob.length < 2 + IV_BYTES + TAG_BYTES) throw new GeneralSecurityException("record too short");
        int version = blob[0] & 0xff;
        int flags = blob[1] & 0xff;
        if (version != FORMAT_VERSION) throw new GeneralSecurityException("unsupported record version " + version);
        if ((flags & ~FLAG_DEFLATE) != 0) throw new GeneralSecurityException("unknown record flags " + flags);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(encKey, "AES"),
            new GCMParameterSpec(TAG_BYTES * 8, blob, 2, IV_BYTES));
        cipher.updateAAD(recordAad(new byte[]{blob[0], blob[1]}, uid, docId));
        byte[] body = cipher.doFinal(blob, 2 + IV_BYTES, blob.length - 2 - IV_BYTES);
        return (flags & FLAG_DEFLATE) != 0 ? inflate(body, MAX_PLAINTEXT_BYTES) : body;
    }

    private static byte[] recordAad(byte[] header, String uid, String docId) {
        byte[] tail = ("agy/rec/v1|" + uid + "|" + docId).getBytes(StandardCharsets.UTF_8);
        byte[] aad = new byte[header.length + tail.length];
        System.arraycopy(header, 0, aad, 0, header.length);
        System.arraycopy(tail, 0, aad, header.length, tail.length);
        return aad;
    }

    static byte[] deflate(byte[] data) {
        Deflater deflater = new Deflater(Deflater.DEFAULT_COMPRESSION, true);
        try {
            deflater.setInput(data);
            deflater.finish();
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(64, data.length / 2));
            byte[] buf = new byte[8192];
            while (!deflater.finished()) {
                int n = deflater.deflate(buf);
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } finally {
            deflater.end();
        }
    }

    static byte[] inflate(byte[] data, int limit) throws GeneralSecurityException {
        Inflater inflater = new Inflater(true);
        try {
            // A raw ("nowrap") stream needs one extra dummy input byte (Inflater docs).
            inflater.setInput(Arrays.copyOf(data, data.length + 1));
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(64, data.length * 3));
            byte[] buf = new byte[8192];
            while (!inflater.finished()) {
                int n = inflater.inflate(buf);
                if (n == 0 && (inflater.needsInput() || inflater.needsDictionary())) {
                    throw new GeneralSecurityException("truncated record");
                }
                if (out.size() + n > limit) throw new GeneralSecurityException("record too large");
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } catch (DataFormatException e) {
            throw new GeneralSecurityException("corrupt record");
        } finally {
            inflater.end();
        }
    }

    // ---- the vault: password and recovery code ---------------------------------

    /**
     * The key a password wraps the DEK with. The password is NFC-normalized and
     * UTF-8 encoded here, so a Cyrillic password gives the same key whatever
     * keyboard typed it and on whatever platform.
     */
    static byte[] passwordKey(String password, byte[] salt, int iterations) throws GeneralSecurityException {
        byte[] pw = Normalizer.normalize(password, Normalizer.Form.NFC).getBytes(StandardCharsets.UTF_8);
        try {
            return pbkdf2Sha256(pw, salt, iterations, KEY_BYTES);
        } finally {
            Arrays.fill(pw, (byte) 0);
        }
    }

    /**
     * PBKDF2-HMAC-SHA256 (RFC 8018) over raw bytes. Implemented on top of Mac
     * rather than SecretKeyFactory: providers disagree on how a char[] password
     * becomes bytes, and the result must match on Android, the PC and Node.
     */
    static byte[] pbkdf2Sha256(byte[] password, byte[] salt, int iterations, int length) throws GeneralSecurityException {
        if (iterations < 1 || length < 1) throw new GeneralSecurityException("bad PBKDF2 parameters");
        Mac mac = Mac.getInstance("HmacSHA256");
        // HMAC pads keys with zeros, so an empty key equals one zero byte (SecretKeySpec rejects empty).
        mac.init(new SecretKeySpec(password.length > 0 ? password : new byte[1], "HmacSHA256"));
        int hLen = mac.getMacLength();
        byte[] out = new byte[length];
        byte[] u = new byte[hLen];
        byte[] t = new byte[hLen];
        int blocks = (length + hLen - 1) / hLen;
        for (int i = 1; i <= blocks; i++) {
            mac.update(salt);
            mac.update(new byte[]{(byte) (i >>> 24), (byte) (i >>> 16), (byte) (i >>> 8), (byte) i});
            mac.doFinal(u, 0);
            System.arraycopy(u, 0, t, 0, hLen);
            for (int j = 1; j < iterations; j++) {
                mac.update(u);
                mac.doFinal(u, 0);
                for (int k = 0; k < hLen; k++) t[k] ^= u[k];
            }
            int off = (i - 1) * hLen;
            System.arraycopy(t, 0, out, off, Math.min(hLen, length - off));
        }
        Arrays.fill(u, (byte) 0);
        Arrays.fill(t, (byte) 0);
        return out;
    }

    static byte[] wrapKey(byte[] wrappingKey, byte[] dek, String uid, String slot) throws GeneralSecurityException {
        return wrapKey(wrappingKey, dek, uid, slot, randomBytes(IV_BYTES));
    }

    static byte[] wrapKey(byte[] wrappingKey, byte[] dek, String uid, String slot, byte[] iv) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(wrappingKey, "AES"), new GCMParameterSpec(TAG_BYTES * 8, iv));
        cipher.updateAAD(vaultAad(uid, slot));
        byte[] ct = cipher.doFinal(dek);
        byte[] out = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(ct, 0, out, iv.length, ct.length);
        return out;
    }

    /** Throws (AEADBadTagException) when the password or recovery code is wrong. */
    static byte[] unwrapKey(byte[] wrappingKey, byte[] wrapped, String uid, String slot) throws GeneralSecurityException {
        if (wrapped == null || wrapped.length != IV_BYTES + KEY_BYTES + TAG_BYTES) {
            throw new GeneralSecurityException("bad wrapped key");
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(wrappingKey, "AES"),
            new GCMParameterSpec(TAG_BYTES * 8, wrapped, 0, IV_BYTES));
        cipher.updateAAD(vaultAad(uid, slot));
        return cipher.doFinal(wrapped, IV_BYTES, wrapped.length - IV_BYTES);
    }

    private static byte[] vaultAad(String uid, String slot) {
        return ("agy/vault/v1|" + uid + "|" + slot).getBytes(StandardCharsets.UTF_8);
    }

    /** 160 random bits as 32 Crockford base32 characters in groups of four. */
    static String newRecoveryCode() {
        byte[] raw = randomBytes(RECOVERY_BYTES);
        try {
            return formatRecoveryCode(raw);
        } finally {
            Arrays.fill(raw, (byte) 0);
        }
    }

    static String formatRecoveryCode(byte[] raw) {
        StringBuilder sb = new StringBuilder();
        int buffer = 0;
        int bits = 0;
        int chars = 0;
        for (byte b : raw) {
            buffer = (buffer << 8) | (b & 0xff);
            bits += 8;
            while (bits >= 5) {
                if (chars > 0 && chars % 4 == 0) sb.append('-');
                sb.append(CROCKFORD.charAt((buffer >>> (bits - 5)) & 31));
                bits -= 5;
                chars++;
            }
        }
        if (bits > 0) {
            if (chars > 0 && chars % 4 == 0) sb.append('-');
            sb.append(CROCKFORD.charAt((buffer << (5 - bits)) & 31));
        }
        return sb.toString();
    }

    /**
     * The code's bytes, or null when it is not a valid code. Case, spaces and
     * dashes do not matter; O reads as 0 and I or L as 1.
     */
    static byte[] parseRecoveryCode(String code) {
        if (code == null) return null;
        StringBuilder clean = new StringBuilder();
        for (int i = 0; i < code.length(); i++) {
            char c = Character.toUpperCase(code.charAt(i));
            if (c == '-' || Character.isWhitespace(c)) continue;
            if (c == 'O') c = '0';
            if (c == 'I' || c == 'L') c = '1';
            if (CROCKFORD.indexOf(c) < 0) return null;
            clean.append(c);
        }
        if (clean.length() != RECOVERY_BYTES * 8 / 5) return null;
        byte[] out = new byte[RECOVERY_BYTES];
        int buffer = 0;
        int bits = 0;
        int pos = 0;
        for (int i = 0; i < clean.length(); i++) {
            buffer = (buffer << 5) | CROCKFORD.indexOf(clean.charAt(i));
            bits += 5;
            if (bits >= 8) {
                out[pos++] = (byte) (buffer >>> (bits - 8));
                bits -= 8;
            }
        }
        return out;
    }

    static byte[] recoveryKey(byte[] codeBytes) throws GeneralSecurityException {
        return hmac(codeBytes, "agy/recovery/v1".getBytes(StandardCharsets.UTF_8));
    }

    // ---- helpers ---------------------------------------------------------------

    static String hex(byte[] b) {
        char[] digits = "0123456789abcdef".toCharArray();
        char[] out = new char[b.length * 2];
        for (int i = 0; i < b.length; i++) {
            out[i * 2] = digits[(b[i] >>> 4) & 15];
            out[i * 2 + 1] = digits[b[i] & 15];
        }
        return new String(out);
    }

    static byte[] unhex(String s) {
        if (s == null || s.length() % 2 != 0) throw new IllegalArgumentException("bad hex");
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int hi = Character.digit(s.charAt(i * 2), 16);
            int lo = Character.digit(s.charAt(i * 2 + 1), 16);
            if (hi < 0 || lo < 0) throw new IllegalArgumentException("bad hex");
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    static void wipe(byte[] b) {
        if (b != null) Arrays.fill(b, (byte) 0);
    }
}
