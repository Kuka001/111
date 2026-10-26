package com.agy.roleplay;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.text.SimpleDateFormat;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * The cloud copy of the user's data: end-to-end encrypted, bound to their
 * Google account, kept in their own Firebase project on the free Spark plan.
 *
 * Local-first: SQLite and the workspace stay the working copy, so the app is
 * as fast as before and works offline. Changes are queued by triggers (see
 * "CLOUD SYNC: LOCAL RECORDS" in LocalBackendServer); a sync run first pulls
 * what other devices changed, then pushes the queue. Every record is sealed by
 * CloudCrypto before it leaves the phone; the keys never do.
 *
 * Firestore (rules: firebase/firestore.rules):
 *   users/{uid}/meta/vault           the data key, wrapped by the password and by the recovery code
 *   users/{uid}/records/{docId}      c = sealed record, u = server time, n = parts when split
 *   users/{uid}/parts/{docId}-{i}    the rest of a record over 900 KB
 *
 * The newest change wins: a record's mt is the time of its last local change.
 * Deletions travel as encrypted tombstones; the messages and memory of a
 * deleted chat are removed outright (other devices delete them with the chat).
 */
final class CloudSync implements CloudStore.SignInListener, CloudStore.UsageMeter {
    private static final String TAG = "CloudSync";
    static final int MIN_PASSWORD_CHARS = 10;
    private static final int PAGE = 100;
    private static final int PUSH_BATCH = 200;
    private static final int PART_BYTES = 900_000;
    private static final int MAX_PARTS = 6;
    private static final long BATCH_JSON_BYTES = 6L * 1024 * 1024;
    private static final long DEBOUNCE_MS = 3000L;
    private static final long RESUME_INTERVAL_MS = 60_000L;
    private static final long VAULT_CHECK_MS = 30 * 60_000L;
    private static final long PARKED_TTL_MS = 30L * 24 * 3600_000L;
    private static final Pattern DOC_ID = Pattern.compile("^[0-9a-f]{32}$");
    private static final TimeZone PACIFIC = TimeZone.getTimeZone("America/Los_Angeles");

    private final LocalBackendServer local;
    private final SQLiteDatabase db;
    private final CloudStore store;
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    /** Vault, link and sync operations never overlap. */
    private final Object lock = new Object();

    // The data key and its subkeys while unlocked (null otherwise). Used under lock.
    private volatile byte[] dek;
    private volatile byte[] encKey;
    private volatile byte[] idKey;

    /** unknown | none (no vault in the cloud) | locked (vault, no key here) | ready */
    private volatile String vaultState = "unknown";
    /** idle | sync | upload | download | wipe */
    private volatile String phase = "idle";
    private volatile int progressDone;
    private volatile int progressTotal;
    private volatile long lastSyncAt;
    private volatile String lastError = "";
    private volatile String lastErrorKind = "";
    private volatile String signInError = "";
    private volatile long quotaUntil;
    private volatile long lastVaultCheck;
    private volatile long lastResumeSync;
    private volatile int skipped;
    private volatile boolean stopRequested;
    private volatile boolean running;
    private int networkFailures;
    private int failedUnlocks;
    private long unlockBlockedUntil;
    private ScheduledFuture<?> scheduled;
    private long scheduledAt;
    /** Queued records that cannot go up this session (too large, or unreadable here): they stay queued. */
    private final Set<String> stuck = Collections.synchronizedSet(new HashSet<String>());

    private String usageDay = "";
    private int usageReads;
    private int usageWrites;
    private int usageDeletes;

    CloudSync(final LocalBackendServer local, Context context, SQLiteDatabase db) {
        this.local = local;
        this.db = db;
        this.store = new CloudStore(context, new CloudStore.Prefs() {
            @Override
            public String get(String key) {
                return local.cloudGetSetting(key);
            }

            @Override
            public void set(String key, String value) {
                local.cloudSetSetting(key, value);
            }
        }, this);
    }

    private String setting(String key) {
        return local.cloudGetSetting(key);
    }

    private void setSetting(String key, String value) {
        local.cloudSetSetting(key, value);
    }

    /** At start-up (off the main thread): unlock with the Keystore-kept key and sync, when this phone is linked. */
    void start() {
        worker.execute(new Runnable() {
            @Override
            public void run() {
                loadUsage();
                quotaUntil = parseLong(setting("cloud_quota_until"));
                boolean ready;
                synchronized (lock) {
                    String saved = setting("cloud_dek");
                    if (!saved.isEmpty()) {
                        try {
                            useKey(CloudCrypto.unhex(saved));
                        } catch (Exception e) {
                            dropKey();
                        }
                    }
                    ready = dek != null && store.signedIn() && local.cloudIsTracking();
                    if (ready) vaultState = "ready";
                }
                if (ready) {
                    schedule(2000L, false);
                } else if (store.signedIn()) {
                    queueVaultCheck();
                }
            }
        });
    }

    private volatile boolean vaultCheckQueued;

    private void queueVaultCheck() {
        if (vaultCheckQueued) return;
        vaultCheckQueued = true;
        worker.execute(vaultCheckTask);
    }

    private boolean active() {
        return dek != null && "ready".equals(vaultState) && store.signedIn() && local.cloudIsTracking();
    }

    // ---- status -------------------------------------------------------------------

    JSONObject status() throws Exception {
        if (store.signedIn() && "unknown".equals(vaultState) && !running) queueVaultCheck();
        CloudStore.Config cfg = store.config();
        JSONObject usage;
        synchronized (this) {
            rollUsageDay();
            usage = new JSONObject().put("day", usageDay).put("reads", usageReads).put("writes", usageWrites)
                .put("deletes", usageDeletes)
                .put("limits", new JSONObject().put("reads", 50_000).put("writes", 20_000).put("deletes", 20_000));
        }
        long[] cloud = cloudTotals();
        return new JSONObject()
            .put("configured", cfg != null)
            .put("projectId", cfg != null ? cfg.projectId : "")
            .put("signedIn", store.signedIn())
            .put("email", store.email())
            .put("loginPending", store.signInPending())
            .put("loginCaptured", finishingSignIn || store.hasCapturedSignIn())
            .put("loginError", signInError)
            .put("vault", vaultState)
            .put("linked", local.cloudIsTracking())
            .put("busy", !"idle".equals(phase))
            .put("phase", phase)
            .put("done", progressDone)
            .put("total", progressTotal)
            .put("pending", countRows("SELECT COUNT(*) FROM cloud_outbox"))
            .put("parked", countRows("SELECT COUNT(*) FROM cloud_parked"))
            .put("skipped", skipped)
            .put("lastSyncAt", lastSyncAt > 0 ? lastSyncAt : parseLong(setting("cloud_last_sync")))
            .put("lastError", lastError)
            .put("errorKind", lastErrorKind)
            .put("quotaUntil", quotaUntil > System.currentTimeMillis() ? quotaUntil : 0L)
            .put("usage", usage)
            .put("cloudRecords", cloud[0])
            .put("cloudBytes", cloud[1])
            .put("minPasswordChars", MIN_PASSWORD_CHARS)
            .put("hasLocalData", local.cloudHasLocalData())
            .put("certSha1", store.signingCertSha1())
            .put("keystoreUnavailable", local.cloudKeystoreUnavailable());
    }

    private long countRows(String sql) {
        Cursor c = db.rawQuery(sql, null);
        try {
            return c.moveToFirst() ? c.getLong(0) : 0L;
        } finally {
            c.close();
        }
    }

    private long[] cloudTotals() {
        Cursor c = db.rawQuery("SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM cloud_records WHERE deleted = 0", null);
        try {
            return c.moveToFirst() ? new long[]{c.getLong(0), c.getLong(1)} : new long[]{0L, 0L};
        } finally {
            c.close();
        }
    }

    private void setError(String kind, String message) {
        lastErrorKind = kind;
        lastError = message != null ? message : "";
    }

    private void clearError() {
        lastErrorKind = "";
        lastError = "";
    }

    // ---- configuration and sign-in ----------------------------------------------------

    void configure(String text) throws Exception {
        synchronized (lock) {
            if (store.signedIn() || local.cloudIsTracking()) {
                throw new CloudStore.CloudException(CloudStore.ERR_CONFLICT, 409, "Сначала выйдите из облака, потом меняйте проект.");
            }
            store.saveConfig(CloudStore.Config.parse(text != null ? text : ""));
            clearError();
        }
    }

    void clearConfig() throws Exception {
        synchronized (lock) {
            if (store.signedIn() || local.cloudIsTracking()) {
                throw new CloudStore.CloudException(CloudStore.ERR_CONFLICT, 409, "Сначала выйдите из облака.");
            }
            store.clearConfig();
        }
    }

    /** The Google address to open in the browser. */
    String beginSignIn() throws Exception {
        signInError = "";
        return store.beginSignIn(this);
    }

    @Override
    public void onBrowserReturned(CloudStore.CloudException error) {
        if (error != null) {
            signInError = error.getMessage();
            local.cloudNotifyAuth(false);
            return;
        }
        signInError = "";
        // In the background there is no network (Android 15+): setForeground(true) finishes it then.
        if (foreground) worker.execute(finishSignInTask);
    }

    /** MainActivity is in the foreground (resumed) or not. */
    private volatile boolean foreground = true;
    /** A sync wanted to run while the app was in the background. */
    private volatile boolean syncMissed;
    private volatile boolean finishingSignIn;

    void setForeground(boolean inFront) {
        foreground = inFront;
        if (!inFront) return;
        if (store.hasCapturedSignIn()) worker.execute(finishSignInTask);
        if (syncMissed) {
            syncMissed = false;
            schedule(0L, false);
        } else {
            onResume();
        }
    }

    /** Finishes a sign-in the browser brought back, retrying while the network comes back to the app. */
    private final Runnable finishSignInTask = new Runnable() {
        @Override
        public void run() {
            if (!store.hasCapturedSignIn()) return;
            finishingSignIn = true;
            try {
                CloudStore.CloudException last = null;
                for (int attempt = 1; attempt <= 4; attempt++) {
                    try {
                        acceptSession(store.finishCapturedSignIn());
                        local.cloudNotifyAuth(true);
                        return;
                    } catch (CloudStore.CloudException e) {
                        last = e;
                        if (e.kind != CloudStore.ERR_NETWORK || !foreground) break;
                        // Android lifts the background block a moment after the app is in front.
                        Thread.sleep(700L * attempt);
                    }
                }
                signInError = last.kind == CloudStore.ERR_NETWORK
                    ? "Нет связи с Google, вход завершится, когда появится интернет. (" + last.getMessage() + ")"
                    : last.getMessage();
                local.cloudNotifyAuth(false);
            } catch (Exception e) {
                signInError = e.getMessage() != null ? e.getMessage() : "Вход не выполнен";
                local.cloudNotifyAuth(false);
            } finally {
                finishingSignIn = false;
            }
        }
    };

    /** The browser's address pasted by hand. */
    void exchangeManually(String codeOrUrl) throws Exception {
        signInError = "";
        acceptSession(store.exchangeManually(codeOrUrl));
    }

    private void acceptSession(CloudStore.Session s) throws Exception {
        synchronized (lock) {
            String bound = setting("cloud_uid");
            if (local.cloudIsTracking() && !bound.isEmpty() && !bound.equals(s.uid)) {
                throw new CloudStore.CloudException(CloudStore.ERR_CONFLICT, 409, "Этот телефон связан с другим аккаунтом ("
                    + setting("cloud_email") + "). Чтобы войти как " + s.email + ", сначала выйдите из облака.");
            }
            store.adoptSession(s);
            clearError();
            try {
                checkVault();
            } catch (CloudStore.CloudException e) {
                onCloudError(e, false);
            }
            if (active()) schedule(0L, false);
        }
    }

    private final Runnable vaultCheckTask = new Runnable() {
        @Override
        public void run() {
            vaultCheckQueued = false;
            synchronized (lock) {
                if (!store.signedIn()) return;
                try {
                    checkVault();
                } catch (CloudStore.CloudException e) {
                    onCloudError(e, false);
                } catch (Exception e) {
                    setError("other", "Не удалось проверить хранилище в облаке.");
                }
            }
            if (active()) schedule(0L, false);
        }
    };

    /** Whether the cloud has a vault and whether it is the one this phone's key belongs to. */
    private void checkVault() throws Exception {
        JSONObject vault = store.getDocument(vaultPath());
        lastVaultCheck = System.currentTimeMillis();
        if (vault == null) {
            if (dek != null || local.cloudIsTracking()) {
                dropKey();
                setError("vault", "Хранилища в облаке больше нет (его удалили, возможно с другого устройства). "
                    + "Создайте его заново — данные с телефона загрузятся снова.");
            }
            vaultState = "none";
            return;
        }
        String remoteKid = CloudStore.stringField(vault, "kid");
        if (dek != null && remoteKid.equals(setting("cloud_kid"))) {
            vaultState = "ready";
            return;
        }
        if (dek != null) {
            dropKey();
            setError("vault", "Хранилище в облаке создано заново с другого устройства. Введите его пароль.");
        }
        vaultState = "locked";
    }

    // ---- the vault: create, unlock, password, recovery code -----------------------------

    static void checkNewPassword(String password) throws CloudStore.CloudException {
        int chars = password != null ? password.codePointCount(0, password.length()) : 0;
        if (chars < MIN_PASSWORD_CHARS) {
            throw new CloudStore.CloudException(CloudStore.ERR_OTHER, 400,
                "Пароль шифрования — не короче " + MIN_PASSWORD_CHARS + " символов. Лучше фраза из нескольких слов.");
        }
        if (chars > 1024) throw new CloudStore.CloudException(CloudStore.ERR_OTHER, 400, "Слишком длинный пароль.");
    }

    /** Creates the vault with a new data key and uploads everything. Returns the recovery code (shown once). */
    String createVault(String password) throws Exception {
        checkNewPassword(password);
        synchronized (lock) {
            requireSignedIn();
            if (store.getDocument(vaultPath()) != null) {
                vaultState = "locked";
                throw new CloudStore.CloudException(CloudStore.ERR_CONFLICT, 409, "В облаке уже есть хранилище — введите его пароль.");
            }
            phase = "wipe";
            try {
                // Records of a deleted vault can no longer be read by anyone.
                deleteAll("records");
                deleteAll("parts");
            } finally {
                phase = "idle";
            }
            byte[] newDek = CloudCrypto.newDataKey();
            String code = CloudCrypto.newRecoveryCode();
            byte[] salt = CloudCrypto.randomBytes(CloudCrypto.SALT_BYTES);
            byte[] kek = CloudCrypto.passwordKey(password, salt, CloudCrypto.PBKDF2_ITERATIONS);
            byte[] rk = CloudCrypto.recoveryKey(CloudCrypto.parseRecoveryCode(code));
            String uid = store.uid();
            JSONObject fields;
            try {
                fields = vaultFields(newDek, salt, CloudCrypto.PBKDF2_ITERATIONS,
                    CloudCrypto.wrapKey(kek, newDek, uid, "pw"), CloudCrypto.wrapKey(rk, newDek, uid, "rc"));
            } finally {
                CloudCrypto.wipe(kek);
                CloudCrypto.wipe(rk);
            }
            try {
                store.commit(new JSONArray().put(CloudStore.putWrite(store.docName(vaultPath()), fields, Boolean.FALSE)));
            } catch (CloudStore.CloudException e) {
                if (e.kind != CloudStore.ERR_CONFLICT) throw e;
                vaultState = "locked";
                throw new CloudStore.CloudException(CloudStore.ERR_CONFLICT, 409,
                    "Хранилище только что создано с другого устройства — введите его пароль.");
            }
            useKey(newDek);
            storeKey();
            local.cloudSetTracking(false);
            resetBookkeeping();
            local.cloudSetTracking(true);
            local.cloudQueueAll();
            vaultState = "ready";
            lastVaultCheck = System.currentTimeMillis();
            clearError();
            schedule(0L, false);
            return code;
        }
    }

    /**
     * Unlocks the vault with the password or the recovery code. On a phone that
     * already has data and was not linked to this vault, mode says what to do
     * with it: "merge" (upload it too) or "replace" (erase it, download the cloud's).
     */
    void unlock(String password, String recoveryCode, String mode) throws Exception {
        synchronized (lock) {
            requireSignedIn();
            JSONObject vault = store.getDocument(vaultPath());
            if (vault == null) {
                vaultState = "none";
                throw new CloudStore.CloudException(CloudStore.ERR_NOT_FOUND, 404, "Хранилища в облаке нет — создайте его.");
            }
            byte[] newDek = openVault(vault, password, recoveryCode);
            String remoteKid = CloudStore.stringField(vault, "kid");
            if (!CloudCrypto.keyId(newDek).equals(remoteKid)) {
                throw new CloudStore.CloudException(CloudStore.ERR_OTHER, 500, "Хранилище в облаке повреждено: ключ не совпадает.");
            }
            boolean linked = local.cloudIsTracking();
            boolean sameVault = linked && remoteKid.equals(setting("cloud_kid"));
            boolean hasLocal = local.cloudHasLocalData();
            boolean replace = "replace".equals(mode);
            // A phone never linked must choose; one linked to an older vault (re-created
            // elsewhere) keeps its data and uploads it, which loses nothing.
            if (!sameVault && hasLocal && !replace && !"merge".equals(mode) && !linked) {
                throw new CloudStore.CloudException(CloudStore.ERR_CONFLICT, 409,
                    "На телефоне уже есть данные: выберите «Объединить» или «Заменить данными из облака».");
            }
            if (!sameVault && replace) {
                if (local.cloudGenerationRunning()) {
                    throw new CloudStore.CloudException(CloudStore.ERR_CONFLICT, 409, "Дождитесь окончания генерации или остановите её.");
                }
                // Make sure the cloud can be read before anything here is erased.
                store.runQuery(userPath(), recordsQuery("", "", "", 1));
            }
            useKey(newDek);
            storeKey();
            vaultState = "ready";
            lastVaultCheck = System.currentTimeMillis();
            clearError();
            if (!sameVault) {
                local.cloudSetTracking(false);
                resetBookkeeping();
                if (replace) local.cloudWipeLocalData();
                local.cloudSetTracking(true);
                if (hasLocal && !replace) local.cloudQueueAll();
            }
            schedule(0L, false);
        }
    }

    void changePassword(String current, String recoveryCode, String newPassword) throws Exception {
        checkNewPassword(newPassword);
        synchronized (lock) {
            requireReady();
            JSONObject vault = store.getDocument(vaultPath());
            if (vault == null) throw new CloudStore.CloudException(CloudStore.ERR_NOT_FOUND, 404, "Хранилища в облаке нет.");
            byte[] check = openVault(vault, current, recoveryCode);
            if (!Arrays.equals(check, dek)) {
                throw new CloudStore.CloudException(CloudStore.ERR_CONFLICT, 409, "Хранилище в облаке изменилось — обновите страницу.");
            }
            byte[] salt = CloudCrypto.randomBytes(CloudCrypto.SALT_BYTES);
            byte[] kek = CloudCrypto.passwordKey(newPassword, salt, CloudCrypto.PBKDF2_ITERATIONS);
            JSONObject fields;
            try {
                fields = vaultFields(dek, salt, CloudCrypto.PBKDF2_ITERATIONS,
                    CloudCrypto.wrapKey(kek, dek, store.uid(), "pw"), CloudStore.bytesField(vault, "rc"));
            } finally {
                CloudCrypto.wipe(kek);
            }
            store.commit(new JSONArray().put(CloudStore.putWrite(store.docName(vaultPath()), fields, Boolean.TRUE)));
        }
    }

    /** A new recovery code (the old one stops working). Shown once. */
    String newRecoveryCode(String password) throws Exception {
        synchronized (lock) {
            requireReady();
            JSONObject vault = store.getDocument(vaultPath());
            if (vault == null) throw new CloudStore.CloudException(CloudStore.ERR_NOT_FOUND, 404, "Хранилища в облаке нет.");
            byte[] check = openVault(vault, password, null);
            if (!Arrays.equals(check, dek)) {
                throw new CloudStore.CloudException(CloudStore.ERR_CONFLICT, 409, "Хранилище в облаке изменилось — обновите страницу.");
            }
            String code = CloudCrypto.newRecoveryCode();
            byte[] rk = CloudCrypto.recoveryKey(CloudCrypto.parseRecoveryCode(code));
            JSONObject fields;
            try {
                fields = vaultFields(dek, CloudStore.bytesField(vault, "salt"), (int) CloudStore.intField(vault, "iter", 0),
                    CloudStore.bytesField(vault, "pw"), CloudCrypto.wrapKey(rk, dek, store.uid(), "rc"));
            } finally {
                CloudCrypto.wipe(rk);
            }
            store.commit(new JSONArray().put(CloudStore.putWrite(store.docName(vaultPath()), fields, Boolean.TRUE)));
            return code;
        }
    }

    private static JSONObject vaultFields(byte[] dek, byte[] salt, int iterations, byte[] pw, byte[] rc) throws Exception {
        return new JSONObject()
            .put("v", CloudStore.intValue(1))
            .put("kdf", CloudStore.stringValue("pbkdf2-sha256"))
            .put("iter", CloudStore.intValue(iterations))
            .put("salt", CloudStore.bytesValue(salt))
            .put("pw", CloudStore.bytesValue(pw))
            .put("rc", CloudStore.bytesValue(rc))
            .put("kid", CloudStore.stringValue(CloudCrypto.keyId(dek)));
    }

    /** The data key from the vault; wrong passwords are counted and slowed down. */
    private byte[] openVault(JSONObject vault, String password, String recoveryCode) throws Exception {
        long now = System.currentTimeMillis();
        if (now < unlockBlockedUntil) {
            throw new CloudStore.CloudException(CloudStore.ERR_OTHER, 429,
                "Слишком много неверных попыток. Подождите " + ((unlockBlockedUntil - now) / 1000 + 1) + " с.");
        }
        String uid = store.uid();
        boolean byCode = recoveryCode != null && !recoveryCode.trim().isEmpty();
        try {
            if (byCode) {
                byte[] raw = CloudCrypto.parseRecoveryCode(recoveryCode);
                if (raw == null) {
                    throw new CloudStore.CloudException(CloudStore.ERR_OTHER, 400,
                        "Код восстановления введён неверно: 32 буквы и цифры (дефисы и пробелы не важны).");
                }
                byte[] rk = CloudCrypto.recoveryKey(raw);
                try {
                    return CloudCrypto.unwrapKey(rk, CloudStore.bytesField(vault, "rc"), uid, "rc");
                } finally {
                    CloudCrypto.wipe(rk);
                    CloudCrypto.wipe(raw);
                }
            }
            if (password == null || password.isEmpty()) {
                throw new CloudStore.CloudException(CloudStore.ERR_OTHER, 400, "Введите пароль шифрования.");
            }
            long iter = CloudStore.intField(vault, "iter", 0L);
            byte[] salt = CloudStore.bytesField(vault, "salt");
            if (!"pbkdf2-sha256".equals(CloudStore.stringField(vault, "kdf")) || iter < 100_000L || iter > 10_000_000L
                || salt == null || salt.length < CloudCrypto.SALT_BYTES) {
                throw new CloudStore.CloudException(CloudStore.ERR_OTHER, 500,
                    "Хранилище в облаке повреждено или создано более новой версией приложения.");
            }
            byte[] kek = CloudCrypto.passwordKey(password, salt, (int) iter);
            try {
                byte[] key = CloudCrypto.unwrapKey(kek, CloudStore.bytesField(vault, "pw"), uid, "pw");
                failedUnlocks = 0;
                return key;
            } finally {
                CloudCrypto.wipe(kek);
            }
        } catch (GeneralSecurityException e) {
            failedUnlocks++;
            if (failedUnlocks >= 5) unlockBlockedUntil = now + 30_000L * (failedUnlocks - 4);
            throw new CloudStore.CloudException(CloudStore.ERR_OTHER, 403,
                byCode ? "Неверный код восстановления." : "Неверный пароль шифрования.");
        }
    }

    private void useKey(byte[] key) throws GeneralSecurityException {
        byte[] e = CloudCrypto.encKey(key);
        byte[] i = CloudCrypto.idKey(key);
        dek = key;
        encKey = e;
        idKey = i;
    }

    /** Keystore-encrypted; without the Keystore the key stays in memory only (strict secret). */
    private void storeKey() throws GeneralSecurityException {
        setSetting("cloud_dek", CloudCrypto.hex(dek));
        setSetting("cloud_kid", CloudCrypto.keyId(dek));
    }

    private void dropKey() {
        CloudCrypto.wipe(dek);
        CloudCrypto.wipe(encKey);
        CloudCrypto.wipe(idKey);
        dek = null;
        encKey = null;
        idKey = null;
        setSetting("cloud_dek", "");
    }

    private void requireSignedIn() throws CloudStore.CloudException {
        if (!store.signedIn()) throw new CloudStore.CloudException(CloudStore.ERR_AUTH, 401, "Сначала войдите через Google.");
    }

    private void requireReady() throws CloudStore.CloudException {
        requireSignedIn();
        if (dek == null || !"ready".equals(vaultState)) {
            throw new CloudStore.CloudException(CloudStore.ERR_OTHER, 409, "Сначала разблокируйте хранилище паролем.");
        }
    }

    // ---- signing out and erasing ---------------------------------------------------------

    /** Unlinks this phone: the cloud keeps its copy; wipeLocal also erases the data here. */
    void signOut(boolean wipeLocal) throws Exception {
        stopRequested = true;
        try {
            synchronized (lock) {
                if (wipeLocal && local.cloudGenerationRunning()) {
                    throw new CloudStore.CloudException(CloudStore.ERR_CONFLICT, 409, "Дождитесь окончания генерации или остановите её.");
                }
                cancelScheduled();
                local.cloudSetTracking(false);
                resetBookkeeping();
                dropKey();
                store.stopCallbackServer();
                store.dropSession();
                for (String key : new String[]{"cloud_kid", "cloud_uid", "cloud_email", "cloud_pending_persona",
                    "cloud_quota_until", "cloud_last_sync", "cloud_oauth_pending"}) {
                    setSetting(key, "");
                }
                vaultState = "unknown";
                quotaUntil = 0L;
                lastSyncAt = 0L;
                signInError = "";
                clearError();
                stuck.clear();
                if (wipeLocal) local.cloudWipeLocalData();
            }
        } finally {
            stopRequested = false;
        }
    }

    /** Deletes everything this account has in the cloud (optionally the Firebase account too), then signs out. */
    void wipeCloud(boolean deleteAccount) throws Exception {
        stopRequested = true;
        try {
            synchronized (lock) {
                stopRequested = false;
                requireSignedIn();
                phase = "wipe";
                progressDone = 0;
                progressTotal = 0;
                try {
                    deleteAll("records");
                    deleteAll("parts");
                    store.commit(new JSONArray().put(CloudStore.deleteWrite(store.docName(vaultPath()))));
                    if (deleteAccount) store.deleteAccount();
                } finally {
                    phase = "idle";
                }
                signOut(false);
            }
        } finally {
            stopRequested = false;
        }
    }

    private void deleteAll(String collection) throws Exception {
        while (true) {
            JSONObject q = new JSONObject()
                .put("from", new JSONArray().put(new JSONObject().put("collectionId", collection)))
                .put("select", new JSONObject().put("fields", new JSONArray().put(new JSONObject().put("fieldPath", "__name__"))))
                .put("orderBy", new JSONArray().put(order("__name__")))
                .put("limit", 300);
            JSONArray docs = store.runQuery(userPath(), q);
            if (docs.length() == 0) return;
            JSONArray writes = new JSONArray();
            for (int i = 0; i < docs.length(); i++) writes.put(CloudStore.deleteWrite(docs.getJSONObject(i).optString("name")));
            store.commit(writes);
            progressDone += docs.length();
            if (docs.length() < 300) return;
        }
    }

    private void resetBookkeeping() {
        db.beginTransaction();
        try {
            db.execSQL("DELETE FROM cloud_outbox");
            db.execSQL("DELETE FROM cloud_records");
            db.execSQL("DELETE FROM cloud_parked");
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        setSetting("cloud_watermark", "");
        setSetting("cloud_read_time", "");
        setSetting("cloud_pending_persona", "");
    }

    // ---- scheduling ----------------------------------------------------------------------

    private final Runnable syncTask = new Runnable() {
        @Override
        public void run() {
            // From here on a new request schedules a follow-up run instead of reusing this one.
            synchronized (CloudSync.this) {
                scheduled = null;
            }
            runSync();
        }
    };

    /** After a local change: one sync shortly after the last of a burst, when anything is queued. */
    void onLocalChange() {
        if (active() && countRows("SELECT EXISTS (SELECT 1 FROM cloud_outbox)") > 0) schedule(DEBOUNCE_MS, true);
    }

    /** The app came to the foreground: look for other devices' changes (not more than once a minute). */
    void onResume() {
        long now = System.currentTimeMillis();
        if (now - lastResumeSync < RESUME_INTERVAL_MS) return;
        lastResumeSync = now;
        schedule(0L, false);
    }

    void syncNow() throws CloudStore.CloudException {
        requireReady();
        schedule(0L, false);
    }

    /** Before a backup restore replaces everything here: take in the cloud's latest (best effort, offline is fine). */
    void pullBeforeRestore() {
        synchronized (lock) {
            if (!active()) return;
            phase = "sync";
            try {
                pull();
            } catch (Exception e) {
                Log.w(TAG, "pull before restore failed: " + e.getClass().getName());
            } finally {
                phase = "idle";
                progressDone = 0;
            }
        }
    }

    /**
     * At most one run waits at a time (besides the one in progress): an earlier
     * one covers a later request; a debounce (local change) moves it later.
     */
    private synchronized void schedule(long delayMs, boolean debounce) {
        if (!active()) return;
        long now = System.currentTimeMillis();
        long at = Math.max(now + delayMs, quotaUntil);
        if (scheduled != null && !scheduled.isDone()) {
            if (!debounce && scheduledAt <= at) return;
            scheduled.cancel(false);
        }
        scheduledAt = at;
        scheduled = worker.schedule(syncTask, at - now, TimeUnit.MILLISECONDS);
    }

    private synchronized void cancelScheduled() {
        if (scheduled != null) scheduled.cancel(false);
        scheduled = null;
    }

    private void retryLater() {
        networkFailures = Math.min(networkFailures + 1, 6);
        schedule(Math.min(30_000L << (networkFailures - 1), 10 * 60_000L), false);
    }

    private void runSync() {
        if (!foreground) {
            // No network for a background app (Android 15+): run when it is in front again.
            syncMissed = true;
            return;
        }
        running = true;
        try {
            synchronized (lock) {
                if (!active() || stopRequested || System.currentTimeMillis() < quotaUntil) return;
                phase = "sync";
                skipped = 0;
                try {
                    if (System.currentTimeMillis() - lastVaultCheck > VAULT_CHECK_MS) {
                        checkVault();
                        if (!active()) return;
                    }
                    pull();
                    push();
                    lastSyncAt = System.currentTimeMillis();
                    setSetting("cloud_last_sync", String.valueOf(lastSyncAt));
                    networkFailures = 0;
                    if (skipped > 0) {
                        setError("skipped", skipped + " зап. из облака не удалось прочитать (повреждены или от более новой версии).");
                    } else {
                        clearError();
                    }
                } catch (CloudStore.CloudException e) {
                    if (e.kind == CloudStore.ERR_NETWORK && !foreground) {
                        // The app went to the background mid-sync: not an error, it goes on in front.
                        syncMissed = true;
                    } else {
                        onCloudError(e, true);
                    }
                } catch (Exception e) {
                    // Only the exception's class: its message may quote user data.
                    Log.w(TAG, "sync failed: " + e.getClass().getName());
                    setError("other", "Ошибка синхронизации (" + e.getClass().getSimpleName() + "). Повтор позже.");
                    retryLater();
                } finally {
                    phase = "idle";
                    progressDone = 0;
                    progressTotal = 0;
                    saveUsage();
                }
            }
        } finally {
            running = false;
        }
    }

    private void onCloudError(CloudStore.CloudException e, boolean retry) {
        switch (e.kind) {
            case CloudStore.ERR_QUOTA:
                quotaUntil = nextPacificMidnight() + 60_000L;
                setSetting("cloud_quota_until", String.valueOf(quotaUntil));
                setError("quota", e.getMessage() + " Синхронизация продолжится после "
                    + new SimpleDateFormat("HH:mm", Locale.US).format(new Date(quotaUntil)) + "; данные на телефоне в порядке.");
                if (retry) schedule(0L, false);
                break;
            case CloudStore.ERR_NETWORK:
            case CloudStore.ERR_CONFLICT:
            case CloudStore.ERR_OTHER:
                setError("network", e.getMessage());
                if (retry) retryLater();
                break;
            case CloudStore.ERR_AUTH:
                setError("auth", e.getMessage());
                break;
            case CloudStore.ERR_PERMISSION:
                setError("permission", e.getMessage());
                break;
            default:
                setError("config", e.getMessage());
                break;
        }
    }

    // ---- pull ----------------------------------------------------------------------------

    private static final class Incoming {
        final String docId;
        final String kind;
        final String sid;
        final long mt;
        final boolean deleted;
        final int parts;
        final int bytes;
        final JSONObject payload;

        Incoming(String docId, String kind, String sid, long mt, boolean deleted, int parts, int bytes, JSONObject payload) {
            this.docId = docId;
            this.kind = kind;
            this.sid = sid;
            this.mt = mt;
            this.deleted = deleted;
            this.parts = parts;
            this.bytes = bytes;
            this.payload = payload;
        }
    }

    /** Cards before the chats that use them, chats before their memory and messages; deletions last. */
    private static int applyOrder(Incoming in) {
        int rank;
        switch (in.kind) {
            case "character":
            case "persona":
                rank = 0;
                break;
            case "settings":
            case "prompt":
            case "chat":
                rank = 1;
                break;
            case "memory":
                rank = 2;
                break;
            default:
                rank = 3;
                break;
        }
        return in.deleted ? 10 - rank : rank;
    }

    private void pull() throws Exception {
        String watermark = setting("cloud_watermark");
        if (watermark.isEmpty()) phase = "download";
        String after = "";
        if (!watermark.isEmpty()) {
            // Read again what a write still in flight could have hidden: anything
            // up to 5 s older than the newest record seen, and anything committed
            // up to 10 s before the previous complete read. Copies already applied
            // are recognised by their version; the window stays small even right
            // after a large upload.
            Instant from = Instant.parse(watermark).minusSeconds(5);
            String readMark = setting("cloud_read_time");
            if (!readMark.isEmpty()) {
                Instant byRead = Instant.parse(readMark).minusSeconds(10);
                if (byRead.isAfter(from)) from = byRead;
            }
            after = from.toString();
        }
        boolean complete = false;
        String cursorU = "";
        String cursorName = "";
        LocalBackendServer.CloudApplied changed = new LocalBackendServer.CloudApplied();
        int fetched = 0;
        while (!stopRequested) {
            JSONArray docs = store.runQuery(userPath(), recordsQuery(after, cursorU, cursorName, PAGE));
            if (docs.length() == 0) {
                complete = true;
                break;
            }
            List<Incoming> batch = openAll(docs);
            JSONObject last = docs.getJSONObject(docs.length() - 1);
            cursorU = CloudStore.timestampField(last, "u");
            cursorName = last.optString("name");
            applyBatch(batch, cursorU, changed);
            fetched += docs.length();
            if ("download".equals(phase)) progressDone = fetched;
            // The rules give every record a server time; without one the cursor could not move on.
            if (cursorU.isEmpty()) break;
            if (docs.length() < PAGE) {
                complete = true;
                break;
            }
        }
        if (complete && !stopRequested && !store.lastReadTime().isEmpty()) setSetting("cloud_read_time", store.lastReadTime());
        applyParked(changed);
        if (changed.any()) local.cloudNotifyChanged(changed.toJson());
    }

    private JSONObject recordsQuery(String after, String cursorU, String cursorName, int limit) throws Exception {
        JSONObject q = new JSONObject()
            .put("from", new JSONArray().put(new JSONObject().put("collectionId", "records")))
            .put("orderBy", new JSONArray().put(order("u")).put(order("__name__")))
            .put("limit", limit);
        if (!after.isEmpty()) {
            q.put("where", new JSONObject().put("fieldFilter", new JSONObject()
                .put("field", new JSONObject().put("fieldPath", "u"))
                .put("op", "GREATER_THAN")
                .put("value", new JSONObject().put("timestampValue", after))));
        }
        if (!cursorU.isEmpty()) {
            q.put("startAt", new JSONObject().put("before", false).put("values", new JSONArray()
                .put(new JSONObject().put("timestampValue", cursorU))
                .put(new JSONObject().put("referenceValue", cursorName))));
        }
        return q;
    }

    private static JSONObject order(String field) throws Exception {
        return new JSONObject().put("field", new JSONObject().put("fieldPath", field)).put("direction", "ASCENDING");
    }

    /** Decrypts a page of documents (fetching the parts of split ones); unreadable ones are counted and skipped. */
    private List<Incoming> openAll(JSONArray docs) throws Exception {
        String uid = store.uid();
        List<String> partNames = new ArrayList<>();
        for (int i = 0; i < docs.length(); i++) {
            JSONObject doc = docs.getJSONObject(i);
            String docId = lastSegment(doc.optString("name"));
            long n = CloudStore.intField(doc, "n", 1L);
            if (DOC_ID.matcher(docId).matches() && n > 1 && n <= MAX_PARTS) {
                for (int p = 1; p < n; p++) partNames.add(partName(docId, p));
            }
        }
        Map<String, JSONObject> parts = new java.util.HashMap<>();
        for (int i = 0; i < partNames.size(); i += 100) {
            parts.putAll(store.batchGet(partNames.subList(i, Math.min(partNames.size(), i + 100))));
        }
        List<Incoming> out = new ArrayList<>();
        for (int i = 0; i < docs.length(); i++) {
            JSONObject doc = docs.getJSONObject(i);
            String docId = lastSegment(doc.optString("name"));
            byte[] blob = CloudStore.bytesField(doc, "c");
            long n = CloudStore.intField(doc, "n", 1L);
            if (!DOC_ID.matcher(docId).matches() || blob == null || n < 1 || n > MAX_PARTS) {
                skipped++;
                continue;
            }
            if (n > 1) {
                java.io.ByteArrayOutputStream joined = new java.io.ByteArrayOutputStream();
                joined.write(blob, 0, blob.length);
                boolean complete = true;
                for (int p = 1; p < n && complete; p++) {
                    JSONObject part = parts.get(partName(docId, p));
                    byte[] chunk = part != null ? CloudStore.bytesField(part, "c") : null;
                    if (chunk == null) complete = false;
                    else joined.write(chunk, 0, chunk.length);
                }
                if (!complete) {
                    skipped++;
                    continue;
                }
                blob = joined.toByteArray();
            }
            try {
                JSONObject p = new JSONObject(new String(CloudCrypto.open(encKey, blob, uid, docId), StandardCharsets.UTF_8));
                String kind = p.optString("k", "");
                String sid = p.optString("sid", "");
                // The document's name must be the one its own content gives: nothing was moved around.
                if (p.optInt("v", 0) != 1 || !docId.equals(CloudCrypto.docId(idKey, kind, sid))) {
                    skipped++;
                    continue;
                }
                out.add(new Incoming(docId, kind, sid, p.optLong("mt", 0L), p.optBoolean("deleted", false), (int) n,
                    blob.length, p));
            } catch (GeneralSecurityException | org.json.JSONException e) {
                skipped++;
            }
        }
        return out;
    }

    private void applyBatch(final List<Incoming> batch, final String watermark, final LocalBackendServer.CloudApplied changed)
        throws Exception {
        Collections.sort(batch, new Comparator<Incoming>() {
            @Override
            public int compare(Incoming a, Incoming b) {
                return Integer.compare(applyOrder(a), applyOrder(b));
            }
        });
        local.cloudApplying(new LocalBackendServer.CloudWork() {
            @Override
            public void run() throws Exception {
                for (Incoming in : batch) applyIncoming(in, changed);
                String current = setting("cloud_watermark");
                if (!watermark.isEmpty() && (current.isEmpty() || Instant.parse(watermark).isAfter(Instant.parse(current)))) {
                    setSetting("cloud_watermark", watermark);
                }
            }
        });
    }

    private void applyIncoming(Incoming in, LocalBackendServer.CloudApplied changed) {
        long knownMt = knownMt(in.docId);
        if (knownMt >= in.mt) {
            // Our own upload coming back, or an older copy replaced ours: then ours goes up again
            // (newest wins), and the cloud is remembered as holding the older copy meanwhile.
            if (knownMt > in.mt) {
                remember(in);
                db.execSQL("INSERT OR IGNORE INTO cloud_outbox (kind, sid, parent, queued_at) VALUES (?, ?, '', ?)",
                    new Object[]{in.kind, in.sid, knownMt});
            }
            return;
        }
        long queued = queuedAt(in.kind, in.sid);
        if (queued > in.mt) {
            // The change waiting here is newer and will overwrite this copy.
            remember(in);
            return;
        }
        boolean applied;
        try {
            applied = local.cloudApplyRecord(in.payload, changed);
        } catch (Exception e) {
            Log.w(TAG, "apply " + in.kind + " failed: " + e.getClass().getName());
            skipped++;
            return;
        }
        if (applied) {
            db.delete("cloud_parked", "doc_id = ?", new String[]{in.docId});
        } else {
            String parent = "message".equals(in.kind) ? in.payload.optString("chatSid", "") : in.sid;
            ContentValues cv = new ContentValues();
            cv.put("doc_id", in.docId);
            cv.put("parent", parent);
            cv.put("mt", in.mt);
            cv.put("payload", in.payload.toString());
            cv.put("parked_at", System.currentTimeMillis());
            db.insertWithOnConflict("cloud_parked", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
        }
        if (queued > 0) db.delete("cloud_outbox", "kind = ? AND sid = ?", new String[]{in.kind, in.sid});
        if ("chat".equals(in.kind) && in.deleted) db.delete("cloud_parked", "parent = ?", new String[]{in.sid});
        remember(in);
    }

    private void remember(Incoming in) {
        ContentValues cv = new ContentValues();
        cv.put("doc_id", in.docId);
        cv.put("kind", in.kind);
        cv.put("sid", in.sid);
        cv.put("mt", in.mt);
        cv.put("deleted", in.deleted ? 1 : 0);
        cv.put("parts", in.parts);
        cv.put("bytes", in.bytes);
        db.insertWithOnConflict("cloud_records", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    /** Messages and memories that waited for their chat, the default persona that waited for its card. */
    private void applyParked(final LocalBackendServer.CloudApplied changed) throws Exception {
        db.delete("cloud_parked", "parked_at < ?", new String[]{String.valueOf(System.currentTimeMillis() - PARKED_TTL_MS)});
        final List<String[]> ready = new ArrayList<>();
        Cursor c = db.rawQuery("SELECT p.doc_id, p.payload FROM cloud_parked p "
            + "WHERE EXISTS (SELECT 1 FROM chats ch WHERE ch.sync_id = p.parent)", null);
        try {
            while (c.moveToNext()) ready.add(new String[]{c.getString(0), c.getString(1)});
        } finally {
            c.close();
        }
        final String pending = !changed.pendingPersonaSid.isEmpty() ? changed.pendingPersonaSid : setting("cloud_pending_persona");
        if (ready.isEmpty() && pending.isEmpty()) return;
        final boolean[] personaSet = {pending.isEmpty()};
        local.cloudApplying(new LocalBackendServer.CloudWork() {
            @Override
            public void run() throws Exception {
                for (String[] r : ready) {
                    try {
                        if (local.cloudApplyRecord(new JSONObject(r[1]), changed)) {
                            db.delete("cloud_parked", "doc_id = ?", new String[]{r[0]});
                        }
                    } catch (Exception e) {
                        skipped++;
                    }
                }
                if (!pending.isEmpty() && local.cloudResolvePersona(pending)) {
                    personaSet[0] = true;
                    changed.settings = true;
                }
            }
        });
        setSetting("cloud_pending_persona", personaSet[0] ? "" : pending);
    }

    // ---- push ----------------------------------------------------------------------------

    private static final class Queued {
        final String kind;
        final String sid;
        final String parent;
        final long queuedAt;

        Queued(String kind, String sid, String parent, long queuedAt) {
            this.kind = kind;
            this.sid = sid;
            this.parent = parent;
            this.queuedAt = queuedAt;
        }

        String key() {
            return kind + "\n" + sid;
        }
    }

    /** What a pushed item leaves behind: a record in the cloud (PUT), none (PURGED) or nothing to do (DROP). */
    private static final class Done {
        static final int PUT = 0;
        static final int PURGED = 1;
        static final int DROP = 2;
        final int type;
        final Queued item;
        final String docId;
        final boolean deleted;
        final int parts;
        final int bytes;

        Done(int type, Queued item, String docId, boolean deleted, int parts, int bytes) {
            this.type = type;
            this.item = item;
            this.docId = docId;
            this.deleted = deleted;
            this.parts = parts;
            this.bytes = bytes;
        }
    }

    private void push() throws Exception {
        long queued = countRows("SELECT COUNT(*) FROM cloud_outbox");
        if (queued == 0) return;
        if (queued > 50) phase = "upload";
        progressTotal = (int) queued;
        progressDone = 0;
        while (!stopRequested) {
            List<Queued> items = readOutbox();
            if (items.isEmpty()) return;
            JSONArray writes = new JSONArray();
            List<Done> done = new ArrayList<>();
            long jsonBytes = 0;
            for (Queued it : items) {
                int before = writes.length();
                Done d;
                try {
                    d = prepare(it, writes);
                } catch (Exception e) {
                    // One unreadable record must not hold up the rest of the queue.
                    Log.w(TAG, "export " + it.kind + " failed: " + e.getClass().getName());
                    while (writes.length() > before) writes.remove(writes.length() - 1);
                    stuck.add(it.key());
                    continue;
                }
                if (d != null) done.add(d);
                for (int w = before; w < writes.length(); w++) jsonBytes += writes.getJSONObject(w).toString().length();
                if (jsonBytes > BATCH_JSON_BYTES || writes.length() >= 400) break;
            }
            if (writes.length() > 0) store.commit(writes);
            finish(done);
            progressDone += done.size();
            if (done.isEmpty()) return;
        }
    }

    private List<Queued> readOutbox() {
        List<Queued> out = new ArrayList<>();
        Cursor c = db.rawQuery("SELECT kind, sid, parent, queued_at FROM cloud_outbox ORDER BY queued_at ASC LIMIT ?",
            new String[]{String.valueOf(PUSH_BATCH + stuck.size())});
        try {
            while (c.moveToNext() && out.size() < PUSH_BATCH) {
                Queued q = new Queued(c.getString(0), c.getString(1), c.getString(2), c.getLong(3));
                if (!stuck.contains(q.key())) out.add(q);
            }
        } finally {
            c.close();
        }
        return out;
    }

    /** Adds the writes for one queued record; null when it stays queued (too large). */
    private Done prepare(Queued it, JSONArray writes) throws Exception {
        String docId = CloudCrypto.docId(idKey, it.kind, it.sid);
        long knownMt = knownMt(docId);
        int knownParts = knownParts(docId);
        boolean knownDeleted = knownDeleted(docId);
        JSONObject payload = local.cloudExportRecord(it.kind, it.sid);
        if (payload == null) {
            // Never uploaded, or already deleted there: nothing to tell the cloud.
            if (knownMt < 0 || knownDeleted) return new Done(Done.DROP, it, docId, true, 0, 0);
            boolean chatGone = ("message".equals(it.kind) || "memory".equals(it.kind))
                && !it.parent.isEmpty() && !local.cloudRowExists("chats", it.parent);
            if (chatGone) {
                writes.put(CloudStore.deleteWrite(recordName(docId)));
                for (int p = 1; p < knownParts; p++) writes.put(CloudStore.deleteWrite(partName(docId, p)));
                return new Done(Done.PURGED, it, docId, true, 0, 0);
            }
            payload = new JSONObject().put("deleted", true);
        }
        payload.put("v", 1).put("k", it.kind).put("sid", it.sid).put("mt", it.queuedAt);
        byte[] sealed = CloudCrypto.seal(encKey, payload.toString().getBytes(StandardCharsets.UTF_8), store.uid(), docId);
        int parts = (sealed.length + PART_BYTES - 1) / PART_BYTES;
        if (parts > MAX_PARTS) {
            stuck.add(it.key());
            setError("oversized", "Запись больше " + (MAX_PARTS * PART_BYTES / 1_000_000) + " МБ не помещается в облако и осталась только на телефоне.");
            return null;
        }
        JSONObject fields = new JSONObject().put("c", CloudStore.bytesValue(Arrays.copyOfRange(sealed, 0, Math.min(PART_BYTES, sealed.length))));
        if (parts > 1) fields.put("n", CloudStore.intValue(parts));
        writes.put(CloudStore.putWrite(recordName(docId), fields, null));
        for (int p = 1; p < parts; p++) {
            byte[] chunk = Arrays.copyOfRange(sealed, p * PART_BYTES, Math.min(sealed.length, (p + 1) * PART_BYTES));
            writes.put(CloudStore.putWrite(partName(docId, p), new JSONObject().put("c", CloudStore.bytesValue(chunk)), null));
        }
        for (int p = parts; p < knownParts; p++) writes.put(CloudStore.deleteWrite(partName(docId, p)));
        return new Done(Done.PUT, it, docId, payload.optBoolean("deleted", false), parts, sealed.length);
    }

    /** After a commit: remember what the cloud now has; unqueue what did not change meanwhile. */
    private void finish(List<Done> done) {
        db.beginTransaction();
        try {
            for (Done d : done) {
                if (d.type == Done.PUT) {
                    ContentValues cv = new ContentValues();
                    cv.put("doc_id", d.docId);
                    cv.put("kind", d.item.kind);
                    cv.put("sid", d.item.sid);
                    cv.put("mt", d.item.queuedAt);
                    cv.put("deleted", d.deleted ? 1 : 0);
                    cv.put("parts", d.parts);
                    cv.put("bytes", d.bytes);
                    db.insertWithOnConflict("cloud_records", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
                } else if (d.type == Done.PURGED) {
                    db.delete("cloud_records", "doc_id = ?", new String[]{d.docId});
                }
                db.delete("cloud_outbox", "kind = ? AND sid = ? AND queued_at = ?",
                    new String[]{d.item.kind, d.item.sid, String.valueOf(d.item.queuedAt)});
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    // ---- bookkeeping lookups -------------------------------------------------------------

    /** The version the cloud has of a document, or -1 when this phone knows of none. */
    private long knownMt(String docId) {
        Cursor c = db.rawQuery("SELECT mt FROM cloud_records WHERE doc_id = ?", new String[]{docId});
        try {
            return c.moveToFirst() ? c.getLong(0) : -1L;
        } finally {
            c.close();
        }
    }

    private int knownParts(String docId) {
        Cursor c = db.rawQuery("SELECT parts FROM cloud_records WHERE doc_id = ?", new String[]{docId});
        try {
            return c.moveToFirst() ? c.getInt(0) : 1;
        } finally {
            c.close();
        }
    }

    private boolean knownDeleted(String docId) {
        Cursor c = db.rawQuery("SELECT deleted FROM cloud_records WHERE doc_id = ?", new String[]{docId});
        try {
            return c.moveToFirst() && c.getInt(0) == 1;
        } finally {
            c.close();
        }
    }

    /** When the record was last changed here and not yet uploaded, or 0. */
    private long queuedAt(String kind, String sid) {
        Cursor c = db.rawQuery("SELECT queued_at FROM cloud_outbox WHERE kind = ? AND sid = ?", new String[]{kind, sid});
        try {
            return c.moveToFirst() ? c.getLong(0) : 0L;
        } finally {
            c.close();
        }
    }

    private String userPath() {
        return "users/" + store.uid();
    }

    private String vaultPath() {
        return userPath() + "/meta/vault";
    }

    private String recordName(String docId) throws CloudStore.CloudException {
        return store.docName(userPath() + "/records/" + docId);
    }

    private String partName(String docId, int part) throws CloudStore.CloudException {
        return store.docName(userPath() + "/parts/" + docId + "-" + part);
    }

    private static String lastSegment(String name) {
        return name.substring(name.lastIndexOf('/') + 1);
    }

    // ---- quota ---------------------------------------------------------------------------

    /** The free quota is counted per day in Pacific time. */
    private static String pacificDay() {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        f.setTimeZone(PACIFIC);
        return f.format(new Date());
    }

    private static long nextPacificMidnight() {
        Calendar cal = Calendar.getInstance(PACIFIC);
        cal.add(Calendar.DAY_OF_MONTH, 1);
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        return cal.getTimeInMillis();
    }

    private void rollUsageDay() {
        String day = pacificDay();
        if (!day.equals(usageDay)) {
            usageDay = day;
            usageReads = 0;
            usageWrites = 0;
            usageDeletes = 0;
        }
    }

    @Override
    public synchronized void count(int reads, int writes, int deletes) {
        rollUsageDay();
        usageReads += reads;
        usageWrites += writes;
        usageDeletes += deletes;
    }

    private synchronized void loadUsage() {
        try {
            JSONObject u = new JSONObject(setting("cloud_usage"));
            usageDay = u.optString("day", "");
            usageReads = u.optInt("reads", 0);
            usageWrites = u.optInt("writes", 0);
            usageDeletes = u.optInt("deletes", 0);
        } catch (Exception ignored) {
        }
        rollUsageDay();
    }

    private synchronized void saveUsage() {
        try {
            setSetting("cloud_usage", new JSONObject().put("day", usageDay).put("reads", usageReads)
                .put("writes", usageWrites).put("deletes", usageDeletes).toString());
        } catch (Exception ignored) {
        }
    }

    private static long parseLong(String s) {
        try {
            return Long.parseLong(s.trim());
        } catch (Exception e) {
            return 0L;
        }
    }
}
