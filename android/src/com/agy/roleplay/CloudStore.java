package com.agy.roleplay;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The network side of the cloud copy: Google sign-in, Firebase Authentication
 * and the Cloud Firestore REST API, over HttpURLConnection (no SDK). It only
 * ever handles sealed records: plaintext stays in CloudSync.
 *
 * Google sign-in is OAuth 2.0 for installed apps with the user's own "Desktop
 * app" client: the system browser, a one-shot listener on 127.0.0.1 at a random
 * port, PKCE (S256) and a random state. Google's ID token is exchanged for a
 * Firebase session (accounts:signInWithIdp); its ID token (1 h) lives in memory,
 * the refresh token in the Keystore-encrypted settings.
 */
final class CloudStore {
    // ---- errors ------------------------------------------------------------------
    static final int ERR_CONFIG = 1;
    /** The session is gone: sign in again. */
    static final int ERR_AUTH = 2;
    /** Firestore rules refused the request (owner email, rules not published). */
    static final int ERR_PERMISSION = 3;
    /** The free daily quota is used up. */
    static final int ERR_QUOTA = 4;
    /** No connection or a temporary server error: retry later. */
    static final int ERR_NETWORK = 5;
    /** A precondition failed (the document already exists, or does not). */
    static final int ERR_CONFLICT = 6;
    static final int ERR_NOT_FOUND = 7;
    static final int ERR_OTHER = 8;

    static final class CloudException extends Exception {
        final int kind;
        final int httpStatus;

        CloudException(int kind, int httpStatus, String message) {
            super(message);
            this.kind = kind;
            this.httpStatus = httpStatus;
        }
    }

    // ---- configuration ---------------------------------------------------------------
    private static final Pattern PROJECT_ID = Pattern.compile("^[a-z][a-z0-9-]{4,28}[a-z0-9]$");
    private static final Pattern API_KEY = Pattern.compile("^AIza[0-9A-Za-z_-]{35}$");
    private static final Pattern CLIENT_ID = Pattern.compile("^[0-9]{5,}-[0-9a-z]{10,}\\.apps\\.googleusercontent\\.com$");
    private static final Pattern CLIENT_SECRET = Pattern.compile("^[0-9A-Za-z_-]{16,80}$");

    /** The user's own Firebase project. Not compiled in: the repository and the APK are public. */
    static final class Config {
        final String projectId;
        final String apiKey;
        final String clientId;
        final String clientSecret;

        Config(String projectId, String apiKey, String clientId, String clientSecret) {
            this.projectId = projectId;
            this.apiKey = apiKey;
            this.clientId = clientId;
            this.clientSecret = clientSecret;
        }

        /**
         * Reads the four values from whatever the user pasted: JSON with these
         * keys, Firebase's "const firebaseConfig = {...}" snippet and/or the
         * downloaded OAuth client JSON ({"installed": {...}}), in any mix.
         */
        static Config parse(String text) throws CloudException {
            String projectId = find(text, "projectId", "project_id");
            String apiKey = find(text, "apiKey", "api_key");
            String clientId = find(text, "clientId", "client_id");
            String clientSecret = find(text, "clientSecret", "client_secret");
            if (!PROJECT_ID.matcher(projectId).matches()) throw configError("projectId");
            if (!API_KEY.matcher(apiKey).matches()) throw configError("apiKey");
            if (!CLIENT_ID.matcher(clientId).matches()) throw configError("clientId (OAuth-клиент «Desktop app»)");
            if (!CLIENT_SECRET.matcher(clientSecret).matches()) throw configError("clientSecret");
            return new Config(projectId, apiKey, clientId, clientSecret);
        }

        private static String find(String text, String... keys) {
            for (String key : keys) {
                Matcher m = Pattern.compile("[\"']?" + key + "[\"']?\\s*[:=]\\s*[\"']([^\"']*)[\"']").matcher(text);
                if (m.find()) return m.group(1).trim();
            }
            return "";
        }

        private static CloudException configError(String field) {
            return new CloudException(ERR_CONFIG, 0, "В конфигурации нет правильного значения " + field
                + ". Скопируйте его из консоли Firebase / Google Cloud — см. firebase/README.md.");
        }

        /** The non-secret part, as stored in settings (the secret is stored apart, encrypted). */
        JSONObject publicJson() throws Exception {
            return new JSONObject().put("projectId", projectId).put("apiKey", apiKey).put("clientId", clientId);
        }
    }

    /** A Firebase session right after sign-in, before CloudSync accepts it. */
    static final class Session {
        final String uid;
        final String email;
        final String idToken;
        final String refreshToken;
        final long expiresAtMs;

        Session(String uid, String email, String idToken, String refreshToken, long expiresAtMs) {
            this.uid = uid;
            this.email = email;
            this.idToken = idToken;
            this.refreshToken = refreshToken;
            this.expiresAtMs = expiresAtMs;
        }
    }

    /** Settings storage (LocalBackendServer); secrets there are Keystore-encrypted. */
    interface Prefs {
        String get(String key);

        void set(String key, String value);
    }

    interface SignInListener {
        /**
         * The browser came back (on the listener thread): with a code, now kept
         * for finishCapturedSignIn(), or with an error.
         */
        void onBrowserReturned(CloudException error);
    }

    /** The "back to the app" button on the browser page (MainActivity's agyroleplay://cloud-signin filter). */
    private static final String RETURN_LINK = "intent://cloud-signin#Intent;scheme=agyroleplay;package=com.agy.roleplay;end";

    /** Documents read, written and deleted, against the free daily quota. */
    interface UsageMeter {
        void count(int reads, int writes, int deletes);
    }

    private static final long ID_TOKEN_MARGIN_MS = 5 * 60_000L;
    private static final long SIGN_IN_TTL_MS = 10 * 60_000L;
    private static final int MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

    private final Context context;
    private final Prefs prefs;
    private final UsageMeter usage;
    private volatile String certSha1;

    private volatile String idToken = "";
    private volatile long idTokenExpiry = 0L;
    private volatile ServerSocket callbackServer;
    /** Server time of the last query: everything committed before it was visible to it. */
    private volatile String lastReadTime = "";

    CloudStore(Context context, Prefs prefs, UsageMeter usage) {
        this.context = context;
        this.prefs = prefs;
        this.usage = usage;
    }

    // ---- configuration and session state ----------------------------------------------

    Config config() {
        try {
            JSONObject o = new JSONObject(prefs.get("cloud_config"));
            String secret = prefs.get("cloud_client_secret");
            if (secret.isEmpty()) return null;
            return new Config(o.optString("projectId"), o.optString("apiKey"), o.optString("clientId"), secret);
        } catch (Exception e) {
            return null;
        }
    }

    void saveConfig(Config cfg) throws Exception {
        prefs.set("cloud_config", cfg.publicJson().toString());
        prefs.set("cloud_client_secret", cfg.clientSecret);
    }

    void clearConfig() {
        prefs.set("cloud_config", "");
        prefs.set("cloud_client_secret", "");
    }

    private Config requireConfig() throws CloudException {
        Config cfg = config();
        if (cfg == null) throw new CloudException(ERR_CONFIG, 0, "Облако не настроено: вставьте конфигурацию Firebase.");
        return cfg;
    }

    String uid() {
        return prefs.get("cloud_uid");
    }

    String email() {
        return prefs.get("cloud_email");
    }

    boolean signedIn() {
        return !uid().isEmpty() && !prefs.get("cloud_refresh_token").isEmpty();
    }

    /** Keeps a session CloudSync accepted. */
    synchronized void adoptSession(Session s) {
        prefs.set("cloud_uid", s.uid);
        prefs.set("cloud_email", s.email);
        prefs.set("cloud_refresh_token", s.refreshToken);
        idToken = s.idToken;
        idTokenExpiry = s.expiresAtMs;
    }

    /** Forgets the session (the account binding is CloudSync's to clear). */
    synchronized void dropSession() {
        prefs.set("cloud_refresh_token", "");
        idToken = "";
        idTokenExpiry = 0L;
    }

    /**
     * SHA-1 of this APK's signing certificate, "AB:CD:..." for the user (to
     * restrict the API key to this app) and sent without colons in X-Android-Cert.
     */
    String signingCertSha1() {
        String cached = certSha1;
        if (cached != null) return cached;
        String result = "";
        try {
            PackageManager pm = context.getPackageManager();
            android.content.pm.Signature[] sigs;
            if (Build.VERSION.SDK_INT >= 28) {
                PackageInfo info = pm.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
                sigs = info.signingInfo.getApkContentsSigners();
            } else {
                PackageInfo info = pm.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNATURES);
                sigs = info.signatures;
            }
            byte[] digest = MessageDigest.getInstance("SHA-1").digest(sigs[0].toByteArray());
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) {
                if (sb.length() > 0) sb.append(':');
                sb.append(String.format(Locale.US, "%02X", b & 0xff));
            }
            result = sb.toString();
        } catch (Exception ignored) {
        }
        certSha1 = result;
        return result;
    }

    // ---- Google sign-in ------------------------------------------------------------------

    /**
     * Starts a sign-in and returns the Google URL for the browser. The browser
     * comes back to a one-shot listener on 127.0.0.1 at a random port; the
     * state and PKCE verifier are kept encrypted for ten minutes, so the address
     * can also be pasted by hand (exchangeManually) after a restart.
     */
    synchronized String beginSignIn(final SignInListener listener) throws CloudException {
        Config cfg = requireConfig();
        stopCallbackServer();
        final ServerSocket server;
        try {
            server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
        } catch (IOException e) {
            throw new CloudException(ERR_OTHER, 0, "Не удалось открыть порт для входа: " + e.getMessage());
        }
        callbackServer = server;
        String redirect = "http://127.0.0.1:" + server.getLocalPort() + "/cloud-callback";
        String verifier = b64url(CloudCrypto.randomBytes(32));
        String state = b64url(CloudCrypto.randomBytes(16));
        final long expires = System.currentTimeMillis() + SIGN_IN_TTL_MS;
        try {
            prefs.set("cloud_oauth_pending", new JSONObject().put("state", state).put("verifier", verifier)
                .put("redirect", redirect).put("expires", expires).toString());
        } catch (Exception e) {
            throw new CloudException(ERR_OTHER, 0, "Не удалось начать вход");
        }
        String challenge;
        try {
            challenge = b64url(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        } catch (Exception e) {
            throw new CloudException(ERR_OTHER, 0, "SHA-256 недоступен");
        }
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                serveCallback(server, expires, listener);
            }
        }, "cloud-oauth");
        t.setDaemon(true);
        t.start();
        return "https://accounts.google.com/o/oauth2/v2/auth"
            + "?client_id=" + enc(cfg.clientId)
            + "&redirect_uri=" + enc(redirect)
            + "&response_type=code"
            + "&scope=" + enc("openid email profile")
            + "&code_challenge=" + enc(challenge)
            + "&code_challenge_method=S256"
            + "&state=" + enc(state)
            + "&prompt=select_account";
    }

    synchronized void stopCallbackServer() {
        ServerSocket s = callbackServer;
        callbackServer = null;
        if (s != null) {
            try {
                s.close();
            } catch (Exception ignored) {
            }
        }
    }

    /** Whether a browser sign-in is waiting for Google to come back. */
    boolean signInPending() {
        ServerSocket s = callbackServer;
        return s != null && !s.isClosed();
    }

    private void serveCallback(ServerSocket server, long expires, SignInListener listener) {
        try {
            server.setSoTimeout(15_000);
        } catch (Exception ignored) {
        }
        while (!server.isClosed() && System.currentTimeMillis() < expires) {
            Socket client = null;
            try {
                client = server.accept();
                client.setSoTimeout(10_000);
                BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                String requestLine = reader.readLine();
                String target = requestLine != null && requestLine.startsWith("GET ") ? requestLine.split(" ")[1] : "";
                if (!target.startsWith("/cloud-callback")) {
                    respond(client, 404, false, "Не найдено", "", false);
                    continue;
                }
                int q = target.indexOf('?');
                Map<String, String> params = query(q >= 0 ? target.substring(q + 1) : "");
                CloudException error = null;
                if (params.containsKey("error")) {
                    error = new CloudException(ERR_AUTH, 0, "access_denied".equals(params.get("error"))
                        ? "Вход отменён. Если вы не отменяли его, проверьте, что ваш Gmail добавлен в тестовые пользователи OAuth-клиента."
                        : "Google ответил: " + params.get("error"));
                } else {
                    try {
                        capture(params.get("code"), params.get("state"));
                    } catch (CloudException e) {
                        error = e;
                    }
                }
                // The code is only kept here: the app is in the background now, and
                // Android 15+ gives it no network until it is in front again.
                if (error == null) {
                    respond(client, 200, true, "Почти готово",
                        "Вернитесь в приложение AGY Roleplay — вход завершится там сам.", true);
                } else {
                    respond(client, 200, false, "Вход не выполнен", error.getMessage(), false);
                }
                stopCallbackServer();
                listener.onBrowserReturned(error);
                return;
            } catch (java.net.SocketTimeoutException timeout) {
                // keep waiting until the sign-in expires
            } catch (Exception ignored) {
                // a broken request: keep waiting
            } finally {
                if (client != null) {
                    try {
                        client.close();
                    } catch (Exception ignored) {
                    }
                }
            }
        }
        if (callbackServer == server) stopCallbackServer();
    }

    private static void respond(Socket client, int status, boolean ok, String title, String text, boolean backLink)
        throws IOException {
        String html = "<!DOCTYPE html><html><head><meta charset='utf-8'>"
            + "<meta name='viewport' content='width=device-width,initial-scale=1'><title>AGY Roleplay</title>"
            + "<style>body{background:#0f1115;color:#e9ebf0;font-family:sans-serif;display:flex;align-items:center;"
            + "justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box;text-align:center}"
            + ".card{background:#181b22;border-radius:18px;padding:28px;max-width:420px}"
            + "h2{margin-top:0;color:" + (ok ? "#34d399" : "#f87171") + "}"
            + ".btn{display:inline-block;margin-top:10px;padding:13px 24px;border-radius:999px;background:#6366f1;"
            + "color:#fff;text-decoration:none;font-weight:600}</style></head><body>"
            + "<div class='card'><h2>" + html(title) + "</h2><p>" + html(text) + "</p>"
            + (backLink ? "<a class='btn' href='" + RETURN_LINK + "'>Вернуться в приложение</a>" : "")
            + "</div></body></html>";
        byte[] body = html.getBytes(StandardCharsets.UTF_8);
        OutputStream out = client.getOutputStream();
        out.write(("HTTP/1.1 " + status + (status == 200 ? " OK" : " Not Found") + "\r\n"
            + "Content-Type: text/html; charset=utf-8\r\n"
            + "Cache-Control: no-store\r\n"
            + "Referrer-Policy: no-referrer\r\n"
            + "Content-Length: " + body.length + "\r\n"
            + "Connection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static String html(String s) {
        return String.valueOf(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    /** The address the browser was sent to, pasted by hand when it did not come back by itself. */
    Session exchangeManually(String codeOrUrl) throws CloudException {
        String raw = codeOrUrl != null ? codeOrUrl.trim() : "";
        int q = raw.indexOf('?');
        Map<String, String> params = query(q >= 0 ? raw.substring(q + 1) : raw);
        if (params.containsKey("error")) throw new CloudException(ERR_AUTH, 0, "Google ответил: " + params.get("error"));
        if (!params.containsKey("code") || !params.containsKey("state")) {
            throw new CloudException(ERR_AUTH, 0, "Вставьте адрес целиком: http://127.0.0.1:…/cloud-callback?state=…&code=…");
        }
        capture(params.get("code"), params.get("state"));
        stopCallbackServer();
        return finishCapturedSignIn();
    }

    /** The sign-in in progress (state, PKCE verifier, redirect, and later the code or Google's token); null when none. */
    private JSONObject pending() {
        try {
            JSONObject p = new JSONObject(prefs.get("cloud_oauth_pending"));
            return System.currentTimeMillis() < p.optLong("expires", 0L) ? p : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Keeps the code the browser brought back, once it is checked to belong to this sign-in. */
    private synchronized void capture(String code, String state) throws CloudException {
        JSONObject p = pending();
        if (p == null) throw new CloudException(ERR_AUTH, 0, "Ссылка входа устарела. Нажмите «Войти через Google» ещё раз.");
        if (code == null || code.isEmpty() || state == null
            || !MessageDigest.isEqual(state.getBytes(StandardCharsets.UTF_8), p.optString("state").getBytes(StandardCharsets.UTF_8))) {
            throw new CloudException(ERR_AUTH, 0, "Это ссылка от другой попытки входа. Нажмите «Войти через Google» ещё раз.");
        }
        try {
            prefs.set("cloud_oauth_pending", p.put("code", code).toString());
        } catch (Exception e) {
            throw new CloudException(ERR_OTHER, 0, "Не удалось сохранить код входа");
        }
    }

    /** The browser brought a sign-in back that waits for the app to be in the foreground. */
    boolean hasCapturedSignIn() {
        JSONObject p = pending();
        return p != null && (p.has("code") || p.has("gid"));
    }

    /**
     * Turns what the browser brought back into a Firebase session. Called with
     * the app in the foreground: Android 15+ blocks the network of an app in the
     * background. A network failure keeps the progress for another try (Google's
     * one-time code becomes its ID token, valid for an hour); any other error
     * ends this sign-in.
     */
    synchronized Session finishCapturedSignIn() throws CloudException {
        Config cfg = requireConfig();
        JSONObject p = pending();
        if (p == null || (!p.has("code") && !p.has("gid"))) {
            throw new CloudException(ERR_AUTH, 0, "Ссылка входа устарела. Нажмите «Войти через Google» ещё раз.");
        }
        try {
            String googleIdToken = p.optString("gid", "");
            if (googleIdToken.isEmpty()) {
                googleIdToken = exchangeCode(cfg, p.optString("code"), p.optString("verifier"), p.optString("redirect"));
                p.remove("code");
                p.put("gid", googleIdToken).put("expires", System.currentTimeMillis() + 50 * 60_000L);
                prefs.set("cloud_oauth_pending", p.toString());
            }
            Session s = firebaseSignIn(cfg, googleIdToken);
            prefs.set("cloud_oauth_pending", "");
            return s;
        } catch (CloudException e) {
            if (e.kind != ERR_NETWORK) prefs.set("cloud_oauth_pending", "");
            throw e;
        } catch (Exception e) {
            prefs.set("cloud_oauth_pending", "");
            throw new CloudException(ERR_OTHER, 0, "Не удалось завершить вход");
        }
    }

    /** Google's one-time code (with the PKCE verifier) for its ID token. */
    private static String exchangeCode(Config cfg, String code, String verifier, String redirect) throws CloudException {
        String form = "client_id=" + enc(cfg.clientId)
            + "&client_secret=" + enc(cfg.clientSecret)
            + "&code=" + enc(code)
            + "&code_verifier=" + enc(verifier)
            + "&redirect_uri=" + enc(redirect)
            + "&grant_type=authorization_code";
        Response r = send("POST", "https://oauth2.googleapis.com/token", "application/x-www-form-urlencoded",
            form.getBytes(StandardCharsets.UTF_8), null);
        JSONObject tok = r.json();
        if (r.status >= 500) throw new CloudException(ERR_NETWORK, r.status, "Google временно недоступен (HTTP " + r.status + ").");
        if (r.status != 200) {
            String err = tok.optString("error", "");
            String hint = "invalid_client".equals(err) ? "неверный Client ID или Client secret."
                : "invalid_grant".equals(err) ? "код входа устарел или уже использован — войдите ещё раз."
                : "redirect_uri_mismatch".equals(err) ? "OAuth-клиент должен быть типа «Desktop app»."
                : tok.optString("error_description", err);
            throw new CloudException(ERR_AUTH, r.status, "Google не выдал токен: " + hint);
        }
        String googleIdToken = tok.optString("id_token", "");
        if (googleIdToken.isEmpty()) throw new CloudException(ERR_AUTH, r.status, "Google не вернул id_token (нужна область openid).");
        return googleIdToken;
    }

    /** Google's ID token for a Firebase session (accounts:signInWithIdp). */
    private Session firebaseSignIn(Config cfg, String googleIdToken) throws CloudException {
        JSONObject body = new JSONObject();
        try {
            body.put("postBody", "id_token=" + enc(googleIdToken) + "&providerId=google.com")
                .put("requestUri", "http://localhost")
                .put("returnSecureToken", true)
                .put("returnIdpCredential", false);
        } catch (Exception e) {
            throw new CloudException(ERR_OTHER, 0, "JSON");
        }
        Response fr = send("POST", "https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=" + enc(cfg.apiKey),
            "application/json", body.toString().getBytes(StandardCharsets.UTF_8), androidHeaders());
        JSONObject fb = fr.json();
        if (fr.status != 200) throw identityError(fr, fb);
        String uid = fb.optString("localId", "");
        String email = fb.optString("email", "");
        if (uid.isEmpty() || fb.optString("idToken").isEmpty() || fb.optString("refreshToken").isEmpty()) {
            throw new CloudException(ERR_OTHER, fr.status, "Firebase не вернул сессию.");
        }
        if (!fb.optBoolean("emailVerified", false)) {
            throw new CloudException(ERR_AUTH, fr.status, "Адрес " + email + " не подтверждён в Google.");
        }
        long expiresIn = parseLong(fb.optString("expiresIn", "3600"), 3600L);
        return new Session(uid, email, fb.optString("idToken"), fb.optString("refreshToken"),
            System.currentTimeMillis() + expiresIn * 1000L);
    }

    /** A Firebase ID token for Firestore, refreshed shortly before it expires. */
    synchronized String idToken(boolean forceRefresh) throws CloudException {
        if (!forceRefresh && !idToken.isEmpty() && System.currentTimeMillis() < idTokenExpiry - ID_TOKEN_MARGIN_MS) {
            return idToken;
        }
        Config cfg = requireConfig();
        String refresh = prefs.get("cloud_refresh_token");
        if (refresh.isEmpty() || uid().isEmpty()) throw new CloudException(ERR_AUTH, 0, "Войдите в облако заново.");
        String form = "grant_type=refresh_token&refresh_token=" + enc(refresh);
        Response r = send("POST", "https://securetoken.googleapis.com/v1/token?key=" + enc(cfg.apiKey),
            "application/x-www-form-urlencoded", form.getBytes(StandardCharsets.UTF_8), androidHeaders());
        JSONObject tok = r.json();
        if (r.status != 200) {
            CloudException e = identityError(r, tok);
            if (e.kind == ERR_AUTH) dropSession();
            throw e;
        }
        if (!uid().equals(tok.optString("user_id", ""))) {
            dropSession();
            throw new CloudException(ERR_AUTH, r.status, "Сессия облака относится к другому аккаунту. Войдите заново.");
        }
        idToken = tok.optString("id_token", "");
        idTokenExpiry = System.currentTimeMillis() + parseLong(tok.optString("expires_in", "3600"), 3600L) * 1000L;
        String rotated = tok.optString("refresh_token", "");
        if (!rotated.isEmpty() && !rotated.equals(refresh)) prefs.set("cloud_refresh_token", rotated);
        return idToken;
    }

    /** Deletes the Firebase account itself (after its data). */
    void deleteAccount() throws CloudException {
        Config cfg = requireConfig();
        String body;
        try {
            body = new JSONObject().put("idToken", idToken(false)).toString();
        } catch (CloudException e) {
            throw e;
        } catch (Exception e) {
            throw new CloudException(ERR_OTHER, 0, "JSON");
        }
        Response r = send("POST", "https://identitytoolkit.googleapis.com/v1/accounts:delete?key=" + enc(cfg.apiKey),
            "application/json", body.getBytes(StandardCharsets.UTF_8), androidHeaders());
        if (r.status != 200) throw identityError(r, r.json());
    }

    private CloudException identityError(Response r, JSONObject body) {
        JSONObject err = body.optJSONObject("error");
        String msg = err != null ? err.optString("message", "") : body.optString("error", "");
        String upper = msg.toUpperCase(Locale.ROOT);
        if (upper.contains("OPERATION_NOT_ALLOWED")) {
            return new CloudException(ERR_CONFIG, r.status, "В Firebase не включён вход через Google: Authentication → Sign-in method → Google.");
        }
        if (upper.contains("INVALID_IDP_RESPONSE")) {
            return new CloudException(ERR_CONFIG, r.status, "Firebase не принял вход Google. Добавьте Client ID в разрешённые: "
                + "Authentication → Sign-in method → Google → «Safelist client IDs». (" + msg + ")");
        }
        if (upper.contains("API KEY NOT VALID") || upper.contains("API_KEY_INVALID")) {
            return new CloudException(ERR_CONFIG, r.status, "Неверный apiKey в конфигурации облака.");
        }
        if (upper.contains("BLOCKED") && upper.contains("ANDROID")) {
            return new CloudException(ERR_CONFIG, r.status, "API-ключ ограничен другим приложением или подписью. "
                + "Разрешите пакет com.agy.roleplay с SHA-1 " + signingCertSha1() + " или снимите ограничение.");
        }
        if (upper.contains("BLOCKED")) {
            return new CloudException(ERR_CONFIG, r.status, "API-ключу запрещён этот сервис: в ограничениях ключа "
                + "разрешите Identity Toolkit API и Token Service API. (" + msg + ")");
        }
        if (upper.contains("TOKEN_EXPIRED") || upper.contains("INVALID_REFRESH_TOKEN") || upper.contains("USER_NOT_FOUND")
            || upper.contains("USER_DISABLED") || upper.contains("INVALID_GRANT") || upper.contains("CREDENTIAL_TOO_OLD")) {
            return new CloudException(ERR_AUTH, r.status, "Сессия облака закончилась (" + msg + "). Войдите заново.");
        }
        if (r.status == 429 || upper.contains("TOO_MANY_ATTEMPTS")) {
            return new CloudException(ERR_QUOTA, r.status, "Слишком много попыток входа, повторите позже.");
        }
        if (r.status >= 500 || r.status == 0) {
            return new CloudException(ERR_NETWORK, r.status, "Сервер Firebase недоступен (HTTP " + r.status + ").");
        }
        return new CloudException(ERR_OTHER, r.status, "Firebase: " + (msg.isEmpty() ? "HTTP " + r.status : msg));
    }

    // ---- Firestore -----------------------------------------------------------------------

    String lastReadTime() {
        return lastReadTime;
    }

    /** "projects/<p>/databases/(default)/documents/<path>": Firestore names documents by this. */
    String docName(String path) throws CloudException {
        return "projects/" + requireConfig().projectId + "/databases/(default)/documents/" + path;
    }

    private String documentsUrl() throws CloudException {
        return "https://firestore.googleapis.com/v1/projects/" + requireConfig().projectId + "/databases/(default)/documents";
    }

    /** One document, or null when it does not exist. */
    JSONObject getDocument(String path) throws CloudException {
        Response r = firestore("GET", documentsUrl() + "/" + path, null);
        usage.count(1, 0, 0);
        if (r.status == 404) return null;
        if (r.status != 200) throw firestoreError(r);
        return r.json();
    }

    /** Applies writes atomically; each is {update|delete, [updateTransforms], [currentDocument]}. */
    JSONObject commit(JSONArray writes) throws CloudException {
        if (writes.length() == 0) return new JSONObject();
        int puts = 0;
        int deletes = 0;
        for (int i = 0; i < writes.length(); i++) {
            if (writes.optJSONObject(i).has("delete")) deletes++;
            else puts++;
        }
        String body;
        try {
            body = new JSONObject().put("writes", writes).toString();
        } catch (Exception e) {
            throw new CloudException(ERR_OTHER, 0, "JSON");
        }
        Response r = firestore("POST", documentsUrl() + ":commit", body);
        if (r.status != 200) throw firestoreError(r);
        usage.count(0, puts, deletes);
        return r.json();
    }

    /** A structured query under parent ("users/<uid>"): the documents found, in order. */
    JSONArray runQuery(String parent, JSONObject structuredQuery) throws CloudException {
        String body;
        try {
            body = new JSONObject().put("structuredQuery", structuredQuery).toString();
        } catch (Exception e) {
            throw new CloudException(ERR_OTHER, 0, "JSON");
        }
        Response r = firestore("POST", documentsUrl() + "/" + parent + ":runQuery", body);
        if (r.status != 200) throw firestoreError(r);
        JSONArray out = new JSONArray();
        try {
            JSONArray items = new JSONArray(r.body);
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                if (item.has("readTime")) lastReadTime = item.optString("readTime");
                JSONObject doc = item.optJSONObject("document");
                if (doc != null) out.put(doc);
            }
        } catch (Exception e) {
            throw new CloudException(ERR_OTHER, r.status, "Firestore вернул непонятный ответ.");
        }
        // A query is billed one read even when it finds nothing.
        usage.count(Math.max(1, out.length()), 0, 0);
        return out;
    }

    /** Several documents by full name; missing ones are left out. */
    Map<String, JSONObject> batchGet(List<String> names) throws CloudException {
        Map<String, JSONObject> found = new HashMap<>();
        if (names.isEmpty()) return found;
        String body;
        try {
            body = new JSONObject().put("documents", new JSONArray(names)).toString();
        } catch (Exception e) {
            throw new CloudException(ERR_OTHER, 0, "JSON");
        }
        Response r = firestore("POST", documentsUrl() + ":batchGet", body);
        if (r.status != 200) throw firestoreError(r);
        usage.count(names.size(), 0, 0);
        try {
            JSONArray items = new JSONArray(r.body);
            for (int i = 0; i < items.length(); i++) {
                JSONObject doc = items.optJSONObject(i) != null ? items.optJSONObject(i).optJSONObject("found") : null;
                if (doc != null) found.put(doc.optString("name"), doc);
            }
        } catch (Exception e) {
            throw new CloudException(ERR_OTHER, r.status, "Firestore вернул непонятный ответ.");
        }
        return found;
    }

    /** A Firestore call with the Firebase ID token; a rejected token is refreshed and the call retried once. */
    private Response firestore(String method, String url, String body) throws CloudException {
        byte[] bytes = body != null ? body.getBytes(StandardCharsets.UTF_8) : null;
        Map<String, String> headers = new HashMap<>();
        headers.put("Authorization", "Bearer " + idToken(false));
        Response r = send(method, url, "application/json", bytes, headers);
        if (r.status == 401) {
            headers.put("Authorization", "Bearer " + idToken(true));
            r = send(method, url, "application/json", bytes, headers);
        }
        return r;
    }

    private CloudException firestoreError(Response r) {
        JSONObject err = r.json().optJSONObject("error");
        String status = err != null ? err.optString("status", "") : "";
        String msg = err != null ? err.optString("message", "") : "";
        if (r.status == 401 || "UNAUTHENTICATED".equals(status)) {
            return new CloudException(ERR_AUTH, r.status, "Облако не приняло вход. Войдите заново.");
        }
        if (r.status == 403 || "PERMISSION_DENIED".equals(status)) {
            return new CloudException(ERR_PERMISSION, r.status, "Firestore отказал в доступе. Проверьте, что правила из "
                + "firebase/firestore.rules опубликованы и в них указан ваш email (" + email() + ").");
        }
        if (r.status == 429 || "RESOURCE_EXHAUSTED".equals(status)) {
            return new CloudException(ERR_QUOTA, r.status, "Исчерпан бесплатный суточный лимит Firestore.");
        }
        if (r.status == 409 || "ALREADY_EXISTS".equals(status) || "FAILED_PRECONDITION".equals(status) || "ABORTED".equals(status)) {
            return new CloudException(ERR_CONFLICT, r.status, msg.isEmpty() ? "Конфликт записи" : msg);
        }
        if (r.status == 404 || "NOT_FOUND".equals(status)) {
            return new CloudException(ERR_NOT_FOUND, r.status, msg.isEmpty()
                ? "Не найдено. Создана ли база Firestore (default)?" : "Firestore: " + msg);
        }
        if (r.status == 0 || r.status >= 500 || "UNAVAILABLE".equals(status) || "DEADLINE_EXCEEDED".equals(status)) {
            return new CloudException(ERR_NETWORK, r.status, "Firestore временно недоступен (HTTP " + r.status + ").");
        }
        return new CloudException(ERR_OTHER, r.status, "Firestore: " + (msg.isEmpty() ? "HTTP " + r.status : msg));
    }

    // ---- Firestore values ------------------------------------------------------------------

    static JSONObject bytesValue(byte[] b) throws Exception {
        return new JSONObject().put("bytesValue", Base64.encodeToString(b, Base64.NO_WRAP));
    }

    static JSONObject intValue(long v) throws Exception {
        return new JSONObject().put("integerValue", String.valueOf(v));
    }

    static JSONObject stringValue(String s) throws Exception {
        return new JSONObject().put("stringValue", s);
    }

    static byte[] bytesField(JSONObject doc, String field) {
        JSONObject fields = doc.optJSONObject("fields");
        JSONObject v = fields != null ? fields.optJSONObject(field) : null;
        if (v == null || !v.has("bytesValue")) return null;
        try {
            return Base64.decode(v.optString("bytesValue"), Base64.DEFAULT);
        } catch (Exception e) {
            return null;
        }
    }

    static long intField(JSONObject doc, String field, long fallback) {
        JSONObject fields = doc.optJSONObject("fields");
        JSONObject v = fields != null ? fields.optJSONObject(field) : null;
        return v != null ? parseLong(v.optString("integerValue", ""), fallback) : fallback;
    }

    static String stringField(JSONObject doc, String field) {
        JSONObject fields = doc.optJSONObject("fields");
        JSONObject v = fields != null ? fields.optJSONObject(field) : null;
        return v != null ? v.optString("stringValue", "") : "";
    }

    static String timestampField(JSONObject doc, String field) {
        JSONObject fields = doc.optJSONObject("fields");
        JSONObject v = fields != null ? fields.optJSONObject(field) : null;
        return v != null ? v.optString("timestampValue", "") : "";
    }

    /** An upsert of the whole document; u becomes the server's commit time (the rules insist). */
    static JSONObject putWrite(String name, JSONObject fields, Boolean mustExist) throws Exception {
        JSONObject w = new JSONObject()
            .put("update", new JSONObject().put("name", name).put("fields", fields))
            .put("updateTransforms", new JSONArray().put(new JSONObject().put("fieldPath", "u").put("setToServerValue", "REQUEST_TIME")));
        if (mustExist != null) w.put("currentDocument", new JSONObject().put("exists", mustExist.booleanValue()));
        return w;
    }

    static JSONObject deleteWrite(String name) throws Exception {
        return new JSONObject().put("delete", name);
    }

    // ---- HTTP --------------------------------------------------------------------------------

    private static final class Response {
        final int status;
        final String body;

        Response(int status, String body) {
            this.status = status;
            this.body = body;
        }

        JSONObject json() {
            try {
                return new JSONObject(body);
            } catch (Exception e) {
                return new JSONObject();
            }
        }
    }

    /** Lets a Firebase API key restricted to Android apps accept this one. */
    private Map<String, String> androidHeaders() {
        Map<String, String> h = new HashMap<>();
        h.put("X-Android-Package", context.getPackageName());
        String sha = signingCertSha1().replace(":", "");
        if (!sha.isEmpty()) h.put("X-Android-Cert", sha);
        return h;
    }

    private static Response send(String method, String url, String contentType, byte[] body, Map<String, String> headers)
        throws CloudException {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(60_000);
            conn.setUseCaches(false);
            conn.setRequestProperty("Accept", "application/json");
            if (headers != null) {
                for (Map.Entry<String, String> e : headers.entrySet()) conn.setRequestProperty(e.getKey(), e.getValue());
            }
            if (body != null) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", contentType);
                conn.setFixedLengthStreamingMode(body.length);
                OutputStream os = conn.getOutputStream();
                os.write(body);
                os.close();
            }
            int status = conn.getResponseCode();
            InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            return new Response(status, is != null ? new String(readAll(is), StandardCharsets.UTF_8) : "");
        } catch (CloudException e) {
            throw e;
        } catch (IOException e) {
            throw new CloudException(ERR_NETWORK, 0, "Нет связи с облаком: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static byte[] readAll(InputStream is) throws IOException, CloudException {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) != -1) {
                if (out.size() + n > MAX_RESPONSE_BYTES) throw new CloudException(ERR_OTHER, 0, "Слишком большой ответ облака.");
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } finally {
            is.close();
        }
    }

    private static Map<String, String> query(String q) {
        Map<String, String> map = new HashMap<>();
        for (String pair : q.split("&")) {
            int i = pair.indexOf('=');
            if (i <= 0) continue;
            try {
                map.put(URLDecoder.decode(pair.substring(0, i), "UTF-8"), URLDecoder.decode(pair.substring(i + 1), "UTF-8"));
            } catch (Exception ignored) {
            }
        }
        return map;
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s != null ? s : "", "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    private static String b64url(byte[] b) {
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static long parseLong(String s, long fallback) {
        try {
            return Long.parseLong(s.trim());
        } catch (Exception e) {
            return fallback;
        }
    }
}
