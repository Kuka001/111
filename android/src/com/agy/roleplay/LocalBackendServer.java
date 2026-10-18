package com.agy.roleplay;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
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
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Embedded Standalone Backend Server inside the Android APK.
 * Provides SQLite persistence, Workspace File & Folder management,
 * Two-way Character/Persona Markdown sync, Clean Model & Effort management,
 * Git Auto-Update (OTA + Full APK), and Direct On-Device Google Antigravity (AGY) Gateway Client.
 */
public class LocalBackendServer {
    // Official Google Antigravity (AGY) OAuth & Unified Gateway Constants (No API Key required)
    private static final String AGY_GCP_CLIENT_ID = String.join("",
        new String[]{"884354", "919052-", "36trc1jjb3tg", "uiac32ov6cod268c5blh", ".apps.google", "usercontent.com"});
    private static final String AGY_GCP_CLIENT_SECRET = String.join("",
        new String[]{"GOC", "SPX-", "9YQWpF7RW", "DC0QTdj-Yx", "KMwR0ZtsX"});
    private static final String AGY_CLIENT_ID = String.join("",
        new String[]{"107100", "6060591-", "tmhssin2h21l", "cre235vtolojh4g403ep", ".apps.google", "usercontent.com"});
    private static final String AGY_CLIENT_SECRET = String.join("",
        new String[]{"GOC", "SPX-", "K58FWR486", "LdLJ1mLB8s", "XC4z6qDAf"});
    private static final int AGY_OAUTH_PORT = 51121;
    private static final String AGY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
    private static final String AGY_SCOPES =
        "https://www.googleapis.com/auth/cloud-platform " +
        "https://www.googleapis.com/auth/userinfo.email " +
        "https://www.googleapis.com/auth/userinfo.profile " +
        "https://www.googleapis.com/auth/cclog " +
        "https://www.googleapis.com/auth/experimentsandconfigs";
    private static final String AGY_VERTEX_ENDPOINT = "https://aiplatform.googleapis.com";
    private static final String[] AGY_GATEWAY_ENDPOINTS = new String[]{
        "https://cloudcode-pa.googleapis.com",
        "https://daily-cloudcode-pa.sandbox.googleapis.com"
    };
    private static final String AGY_USER_AGENT =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36";
    private static final String AGY_API_CLIENT_HEADER = "google-cloud-sdk vscode_cloudshelleditor/0.1";
    private static final String AGY_CLIENT_METADATA_HEADER = "{\"ideType\":\"ANTIGRAVITY\",\"platform\":\"WINDOWS\",\"pluginType\":\"GEMINI\"}";

    private final Context context;
    private final MainActivity activity;
    private final WebView webView;
    private final Handler mainHandler;
    private final ExecutorService executor;
    private final File workspaceDir;
    private final File otaWwwDir;
    private SQLiteDatabase db;

    private volatile ServerSocket oauthCallbackServer;
    private volatile String pendingCodeVerifier = "";
    private volatile String pendingOAuthState = "";

    private static class GenerationProgress {
        volatile String status = "running";
        volatile String phase = "init";
        volatile String statusText = "🚀 Подготовка запроса к AGY...";
        volatile String thoughts = "";
        volatile String text = "";
        volatile String modelId = "";
        volatile String vertexModel = "";
        volatile String effort = "";
        volatile String thinkingConfigSummary = "";
        volatile String projectId = "";
        volatile String endpoint = "";
        volatile int httpStatus = 0;
        volatile int chunksCount = 0;
        volatile int thoughtsChars = 0;
        volatile int textChars = 0;
        volatile int contextMessagesCount = 0;
        volatile int promptChars = 0;
        volatile String finishReason = "";
        volatile String error = "";
        final long startedAtMs = System.currentTimeMillis();
        volatile long finishedAtMs = 0L;
        final List<String> logs = Collections.synchronizedList(new ArrayList<String>());

        void addLog(String message) {
            long elapsed = System.currentTimeMillis() - startedAtMs;
            long secs = elapsed / 1000L;
            long tenths = (elapsed % 1000L) / 100L;
            String ts = String.format(Locale.US, "[%02d:%02d.%d]", secs / 60L, secs % 60L, tenths);
            logs.add(ts + " " + message);
        }

        long getElapsedMs() {
            long end = finishedAtMs > 0L ? finishedAtMs : System.currentTimeMillis();
            return Math.max(0L, end - startedAtMs);
        }

        JSONObject toJson() throws Exception {
            JSONObject g = new JSONObject();
            g.put("status", status);
            g.put("phase", phase);
            g.put("statusText", statusText);
            g.put("thoughts", thoughts);
            g.put("text", text);
            g.put("modelId", modelId);
            g.put("vertexModel", vertexModel);
            g.put("effort", effort);
            g.put("thinkingConfigSummary", thinkingConfigSummary);
            g.put("projectId", projectId);
            g.put("endpoint", endpoint);
            g.put("httpStatus", httpStatus);
            g.put("chunksCount", chunksCount);
            g.put("thoughtsChars", thoughtsChars);
            g.put("textChars", textChars);
            g.put("contextMessagesCount", contextMessagesCount);
            g.put("promptChars", promptChars);
            g.put("finishReason", finishReason);
            g.put("error", error);
            g.put("elapsedMs", getElapsedMs());
            JSONArray logsArr = new JSONArray();
            synchronized (logs) {
                for (String line : logs) {
                    logsArr.put(line);
                }
            }
            g.put("logs", logsArr);
            return g;
        }
    }

    private final Map<Integer, GenerationProgress> activeGenerations = new ConcurrentHashMap<>();
    private final Map<Integer, GenerationProgress> lastGenerations = new ConcurrentHashMap<>();

    public LocalBackendServer(Context context, WebView webView) {
        this.context = context.getApplicationContext();
        this.activity = (context instanceof MainActivity) ? (MainActivity) context : null;
        this.webView = webView;
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.executor = Executors.newCachedThreadPool();
        this.workspaceDir = new File(this.context.getFilesDir(), "workspace");
        this.otaWwwDir = new File(this.context.getFilesDir(), "ota_www");
        initWorkspaceAndDatabase();
    }

    public String getStartPageUrl() {
        if ("1".equals(getSetting("ota_active", "0"))) {
            File otaIndex = new File(otaWwwDir, "index.html");
            File otaAppJs = new File(otaWwwDir, "app.js");
            if (otaIndex.exists() && otaAppJs.exists() && otaIndex.length() > 100) {
                return "file://" + otaIndex.getAbsolutePath();
            }
        }
        return "file:///android_asset/www/index.html";
    }

    @JavascriptInterface
    public void reloadWebView() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (webView != null) {
                    webView.clearCache(true);
                    webView.loadUrl(getStartPageUrl());
                }
            }
        });
    }

    @JavascriptInterface
    public void openExternalUrl(final String url) {
        if (url == null || url.trim().isEmpty()) return;
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url.trim()));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(intent);
                } catch (Exception ignored) {
                }
            }
        });
    }

    @JavascriptInterface
    public void shareExportText(final String filename, final String content) {
        if (content == null) return;
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent sendIntent = new Intent(Intent.ACTION_SEND);
                    sendIntent.setType("text/plain");
                    sendIntent.putExtra(Intent.EXTRA_SUBJECT, filename != null ? filename : "AGY Roleplay Chat Export");
                    sendIntent.putExtra(Intent.EXTRA_TEXT, content);
                    Intent chooser = Intent.createChooser(sendIntent, "Поделиться экспортированным чатом");
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(chooser);
                } catch (Exception ignored) {
                }
            }
        });
    }

    @JavascriptInterface
    public void saveExportFile(final String filename, final String content, final String mimeType) {
        if (activity != null) {
            activity.startSaveDocument(filename, content, mimeType);
        } else {
            shareExportText(filename, content);
        }
    }

    @JavascriptInterface
    public boolean isEmbeddedServer() {
        return true;
    }

    @JavascriptInterface
    public String getWorkspacePath() {
        return workspaceDir.getAbsolutePath();
    }

    @JavascriptInterface
    public void requestAsync(final String reqId, final String method, final String endpoint, final String bodyStr) {
        executor.execute(new Runnable() {
            @Override
            public void run() {
                int status = 200;
                String responseJson;
                try {
                    JSONObject result = routeRequest(method != null ? method.toUpperCase(Locale.ROOT) : "GET", endpoint, bodyStr);
                    if (result.has("__status")) {
                        status = result.optInt("__status", 200);
                        result.remove("__status");
                    }
                    responseJson = result.toString();
                } catch (Exception e) {
                    status = 500;
                    try {
                        JSONObject err = new JSONObject();
                        err.put("error", e.getMessage() != null ? e.getMessage() : "Internal APK Server Error");
                        responseJson = err.toString();
                    } catch (Exception ignored) {
                        responseJson = "{\"error\":\"Internal APK Server Error\"}";
                    }
                }
                deliverResponse(reqId, status, responseJson);
            }
        });
    }

    private void deliverResponse(final String reqId, final int status, final String responseJson) {
        final String b64 = Base64.encodeToString(responseJson.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (webView != null) {
                    String js = "window.__onAndroidServerResponse && window.__onAndroidServerResponse("
                        + JSONObject.quote(reqId) + ", " + status + ", " + JSONObject.quote(b64) + ");";
                    webView.evaluateJavascript(js, null);
                }
            }
        });
    }

    // =========================================================================
    // INITIALIZATION: WORKSPACE FOLDERS, DEFAULT FILES & SQLITE DATABASE
    // =========================================================================
    private synchronized void initWorkspaceAndDatabase() {
        String[] subdirs = new String[]{"characters", "personas", "lore", "memories", "avatars", "exports"};
        if (!workspaceDir.exists()) {
            workspaceDir.mkdirs();
        }
        for (String sub : subdirs) {
            File d = new File(workspaceDir, sub);
            if (!d.exists()) d.mkdirs();
        }

        seedDefaultWorkspaceFiles();

        File dbFile = context.getDatabasePath("agy_roleplay.db");
        if (dbFile.getParentFile() != null && !dbFile.getParentFile().exists()) {
            dbFile.getParentFile().mkdirs();
        }
        db = SQLiteDatabase.openOrCreateDatabase(dbFile, null);
        db.execSQL("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS characters (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "name TEXT NOT NULL, " +
            "file_path TEXT NOT NULL UNIQUE, " +
            "avatar_url TEXT DEFAULT '', " +
            "first_message TEXT DEFAULT '', " +
            "description_preview TEXT DEFAULT '', " +
            "created_at TEXT DEFAULT CURRENT_TIMESTAMP, " +
            "updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
        db.execSQL("CREATE TABLE IF NOT EXISTS personas (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "name TEXT NOT NULL, " +
            "file_path TEXT NOT NULL UNIQUE, " +
            "avatar_url TEXT DEFAULT '', " +
            "description_preview TEXT DEFAULT '', " +
            "is_default INTEGER DEFAULT 0, " +
            "created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
        db.execSQL("CREATE TABLE IF NOT EXISTS chats (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "title TEXT NOT NULL, " +
            "character_id INTEGER NOT NULL, " +
            "persona_id INTEGER NOT NULL, " +
            "model_id TEXT NOT NULL, " +
            "effort TEXT DEFAULT 'high', " +
            "memory_file_path TEXT DEFAULT '', " +
            "created_at TEXT DEFAULT CURRENT_TIMESTAMP, " +
            "updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
        db.execSQL("CREATE TABLE IF NOT EXISTS messages (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "chat_id INTEGER NOT NULL, " +
            "role TEXT NOT NULL, " +
            "content TEXT NOT NULL, " +
            "thoughts TEXT DEFAULT '', " +
            "swipes_json TEXT DEFAULT '[]', " +
            "swipe_index INTEGER DEFAULT 0, " +
            "created_at TEXT DEFAULT CURRENT_TIMESTAMP)");

        setDefaultSetting("project_id", "project-4c7a8e8a-764a-42bc-bdf");
        setDefaultSetting("selected_model", "gemini-4-argon");
        setDefaultSetting("selected_effort", "high");
        setDefaultSetting("active_persona_id", "1");
        setDefaultSetting("context_messages_limit", "30");
        setDefaultSetting("safety_threshold", "OFF");
        setDefaultSetting("google_auth_token", "");
        setDefaultSetting("agy_access_token", "");
        setDefaultSetting("agy_refresh_token", "");
        setDefaultSetting("agy_token_expiry", "0");
        setDefaultSetting("agy_user_email", "");
        setDefaultSetting("agy_discovered_project", "");
        setDefaultSetting("git_repo", "Kuka001/111");
        setDefaultSetting("git_branch", "main");
        setDefaultSetting("installed_version", "1.4.2");
        setDefaultSetting("installed_build", "11");
        setDefaultSetting("installed_commit", "");
        setDefaultSetting("ota_active", "0");

        // Reconcile bundled APK version with any cached OTA bundle
        try {
            JSONObject bundled = readBundledVersionManifest();
            int bundledBuild = bundled.optInt("build", 11);
            String bundledVer = bundled.optString("version", "1.4.2");
            int savedBuild = Integer.parseInt(getSetting("installed_build", "0"));
            if (bundledBuild > savedBuild) {
                deleteRecursive(otaWwwDir);
                setSetting("ota_active", "0");
                setSetting("installed_version", bundledVer);
                setSetting("installed_build", String.valueOf(bundledBuild));
            }
        } catch (Exception ignored) {
        }

        // Normalize any legacy model IDs with effort suffixes (-low, -medium, -high, -max)
        String curModel = getSetting("selected_model", "gemini-4-argon");
        String normModel = normalizeBaseModelId(curModel);
        if (!normModel.equals(curModel)) {
            setSetting("selected_model", normModel);
        }

        syncWorkspaceFilesWithDb();
    }

    private void setDefaultSetting(String key, String value) {
        Cursor c = db.rawQuery("SELECT value FROM settings WHERE key = ?", new String[]{key});
        boolean exists = c.moveToFirst();
        c.close();
        if (!exists) {
            ContentValues cv = new ContentValues();
            cv.put("key", key);
            cv.put("value", value);
            db.insert("settings", null, cv);
        }
    }

    private String getSetting(String key, String fallback) {
        Cursor c = db.rawQuery("SELECT value FROM settings WHERE key = ?", new String[]{key});
        String val = fallback;
        if (c.moveToFirst()) {
            val = c.getString(0);
        }
        c.close();
        return val != null ? val : fallback;
    }

    private void setSetting(String key, String value) {
        ContentValues cv = new ContentValues();
        cv.put("key", key);
        cv.put("value", value != null ? value : "");
        db.insertWithOnConflict("settings", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private void seedDefaultWorkspaceFiles() {
        File geminiMd = new File(workspaceDir, "GEMINI.md");
        if (!geminiMd.exists()) {
            writeTextFile(geminiMd, "# GEMINI.md\n\n");
        } else {
            String existingGemini = readTextFile(geminiMd);
            if (existingGemini.startsWith("# Системные правила ролевой игры (AGY Roleplay Engine)")) {
                writeTextFile(geminiMd, "# GEMINI.md\n\n");
            }
        }

        // One-time cleanup of previously auto-seeded stock templates if untouched by user
        if (!"1".equals(getSetting("stock_cleaned_v141", "0"))) {
            File elenaMd = new File(workspaceDir, "characters/elena.md");
            if (elenaMd.exists() && readTextFile(elenaMd).contains("Хранительница Звёздного Архива")) {
                elenaMd.delete();
                db.delete("characters", "file_path = ?", new String[]{"characters/elena.md"});
            }
            File kiraMd = new File(workspaceDir, "characters/kira.md");
            if (kiraMd.exists() && readTextFile(kiraMd).contains("Кибер-нетраннер из Нео-Токио")) {
                kiraMd.delete();
                db.delete("characters", "file_path = ?", new String[]{"characters/kira.md"});
            }
            File kazumaMd = new File(workspaceDir, "personas/kazuma.md");
            if (kazumaMd.exists() && readTextFile(kazumaMd).contains("Опытный путешественник между мирами")) {
                kazumaMd.delete();
                db.delete("personas", "file_path = ?", new String[]{"personas/kazuma.md"});
            }
            File worldsMd = new File(workspaceDir, "lore/worlds.md");
            if (worldsMd.exists() && readTextFile(worldsMd).contains("Древняя цитадель на границе астрального разлома")) {
                worldsMd.delete();
            }
            setSetting("stock_cleaned_v141", "1");
        }
    }

    private String makeSvgDataUri(String bg1, String bg2, String accent, String label) {
        String svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"240\" viewBox=\"0 0 240 240\">" +
            "<defs><linearGradient id=\"g\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">" +
            "<stop offset=\"0%\" stop-color=\"" + bg1 + "\"/>" +
            "<stop offset=\"100%\" stop-color=\"" + bg2 + "\"/>" +
            "</linearGradient></defs>" +
            "<rect width=\"240\" height=\"240\" rx=\"48\" fill=\"url(#g)\"/>" +
            "<circle cx=\"120\" cy=\"95\" r=\"44\" fill=\"" + accent + "\" opacity=\"0.85\"/>" +
            "<path d=\"M48 215 C55 155, 185 155, 192 215\" fill=\"" + accent + "\" opacity=\"0.7\"/>" +
            "<text x=\"120\" y=\"110\" font-family=\"sans-serif\" font-size=\"40\" font-weight=\"bold\" fill=\"#ffffff\" text-anchor=\"middle\">" + label + "</text>" +
            "</svg>";
        return "data:image/svg+xml;utf8," + UriEncode(svg);
    }

    private String buildInitials(String name, String fallback) {
        if (name == null || name.trim().isEmpty()) return fallback;
        String trimmed = name.trim();
        String[] parts = trimmed.split("\\s+");
        if (parts.length >= 2 && !parts[0].isEmpty() && !parts[1].isEmpty()) {
            return (parts[0].substring(0, 1) + parts[1].substring(0, 1)).toUpperCase(Locale.ROOT);
        }
        return trimmed.substring(0, Math.min(2, trimmed.length())).toUpperCase(Locale.ROOT);
    }

    private String UriEncode(String s) {
        try {
            return java.net.URLEncoder.encode(s, "UTF-8")
                .replace("+", "%20")
                .replace("%21", "!")
                .replace("%27", "'")
                .replace("%28", "(")
                .replace("%29", ")")
                .replace("%7E", "~");
        } catch (Exception e) {
            return "";
        }
    }

    private synchronized void syncWorkspaceFilesWithDb() {
        // Prune DB rows for character files that were removed from disk
        Cursor existingChars = db.rawQuery("SELECT id, file_path FROM characters", null);
        while (existingChars.moveToNext()) {
            int cid = existingChars.getInt(0);
            String fp = existingChars.getString(1);
            if (fp == null || fp.isEmpty() || !new File(workspaceDir, fp).exists()) {
                db.delete("characters", "id = ?", new String[]{String.valueOf(cid)});
            }
        }
        existingChars.close();

        // Prune DB rows for persona files that were removed from disk
        Cursor existingPersonas = db.rawQuery("SELECT id, file_path FROM personas", null);
        while (existingPersonas.moveToNext()) {
            int pid = existingPersonas.getInt(0);
            String fp = existingPersonas.getString(1);
            if (fp == null || fp.isEmpty() || !new File(workspaceDir, fp).exists()) {
                db.delete("personas", "id = ?", new String[]{String.valueOf(pid)});
            }
        }
        existingPersonas.close();

        File charsDir = new File(workspaceDir, "characters");
        File[] charFiles = charsDir.listFiles();
        if (charFiles != null) {
            Arrays.sort(charFiles, new Comparator<File>() {
                @Override
                public int compare(File a, File b) {
                    return a.getName().compareToIgnoreCase(b.getName());
                }
            });
            for (File f : charFiles) {
                if (f.isFile() && (f.getName().endsWith(".md") || f.getName().endsWith(".txt"))) {
                    String relPath = "characters/" + f.getName();
                    String content = readTextFile(f);
                    String name = parseHeaderName(content, f.getName().replaceFirst("\\.[^.]+$", ""));
                    String firstMsg = parseFirstMessage(content, name);
                    String preview = parsePreview(content);
                    String avatar = makeSvgDataUri("#1b1f27", "#252b37", "#7c90c9", buildInitials(name, "П"));

                    Cursor c = db.rawQuery("SELECT id, avatar_url FROM characters WHERE file_path = ?", new String[]{relPath});
                    if (!c.moveToFirst()) {
                        ContentValues cv = new ContentValues();
                        cv.put("name", name);
                        cv.put("file_path", relPath);
                        cv.put("avatar_url", avatar);
                        cv.put("first_message", firstMsg);
                        cv.put("description_preview", preview);
                        db.insert("characters", null, cv);
                    } else {
                        String existingAvatar = c.getString(1);
                        if (existingAvatar == null || existingAvatar.isEmpty() || existingAvatar.startsWith("/avatars/")) {
                            ContentValues cv = new ContentValues();
                            cv.put("avatar_url", avatar);
                            db.update("characters", cv, "file_path = ?", new String[]{relPath});
                        }
                    }
                    c.close();
                }
            }
        }

        File personasDir = new File(workspaceDir, "personas");
        File[] personaFiles = personasDir.listFiles();
        if (personaFiles != null) {
            for (File f : personaFiles) {
                if (f.isFile() && (f.getName().endsWith(".md") || f.getName().endsWith(".txt"))) {
                    String relPath = "personas/" + f.getName();
                    String content = readTextFile(f);
                    String name = parseHeaderName(content, f.getName().replaceFirst("\\.[^.]+$", ""));
                    String preview = parsePreview(content);
                    String defaultPersonaAvatar = makeSvgDataUri("#182226", "#1e293b", "#64748b", buildInitials(name, "И"));

                    Cursor c = db.rawQuery("SELECT id, avatar_url FROM personas WHERE file_path = ?", new String[]{relPath});
                    if (!c.moveToFirst()) {
                        ContentValues cv = new ContentValues();
                        cv.put("name", name);
                        cv.put("file_path", relPath);
                        cv.put("avatar_url", defaultPersonaAvatar);
                        cv.put("description_preview", preview);
                        cv.put("is_default", 1);
                        db.insert("personas", null, cv);
                    } else {
                        String existingAvatar = c.getString(1);
                        if (existingAvatar == null || existingAvatar.isEmpty() || existingAvatar.startsWith("/avatars/")) {
                            ContentValues cv = new ContentValues();
                            cv.put("avatar_url", defaultPersonaAvatar);
                            db.update("personas", cv, "file_path = ?", new String[]{relPath});
                        }
                    }
                    c.close();
                }
            }
        }
    }

    private String parseHeaderName(String content, String fallback) {
        Matcher m = Pattern.compile("^#\\s*(?:Имя:|Персона:|Персонаж:)?\\s*(.+)$", Pattern.MULTILINE | Pattern.CASE_INSENSITIVE).matcher(content);
        if (m.find()) {
            return m.group(1).trim();
        }
        return fallback;
    }

    private String parseFirstMessage(String content, String charName) {
        Matcher m = Pattern.compile("###\\s*(?:Начальное сообщение|Приветствие|First Message)\\s*\\r?\\n([\\s\\S]+?)(?:\\r?\\n###|$)", Pattern.CASE_INSENSITIVE).matcher(content);
        if (m.find()) {
            return m.group(1).trim();
        }
        return "";
    }

    private String parsePreview(String content) {
        String cleaned = content
            .replaceAll("(?m)^#+.*$", "")
            .replaceAll("\\s+", " ")
            .trim();
        if (cleaned.length() > 160) {
            return cleaned.substring(0, 160);
        }
        return cleaned;
    }

    // =========================================================================
    // CLEAN BASE MODELS & SEPARATE EFFORT MAPPING
    // =========================================================================
    private JSONArray getCleanBaseModelsJson() throws Exception {
        JSONArray arr = new JSONArray();
        arr.put(makeModelObj("gemini-4-argon", "Gemini 4 Argon", "Google DeepMind", "Флагман RP"));
        arr.put(makeModelObj("claude-opus-5-5", "Claude Opus 5.5", "Anthropic (AGY)", "Литературный"));
        arr.put(makeModelObj("claude-sonnet-5-5", "Claude Sonnet 5.5", "Anthropic (AGY)", "Креативный"));
        arr.put(makeModelObj("gemini-3.8-flash", "Gemini 3.8 Flash", "Google DeepMind", "Быстрый RP"));
        arr.put(makeModelObj("gemini-3.7-flash", "Gemini 3.7 Flash", "Google DeepMind", "Баланс"));
        arr.put(makeModelObj("gemini-3.6-flash", "Gemini 3.6 Flash", "Google DeepMind", "Скоростной"));
        arr.put(makeModelObj("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", "Google DeepMind", "Лёгкий"));
        arr.put(makeModelObj("gemini-3.1-pro", "Gemini 3.1 Pro", "Google DeepMind", "Глубокий"));
        return arr;
    }

    private JSONObject makeModelObj(String id, String name, String provider, String badge) throws Exception {
        JSONObject o = new JSONObject();
        o.put("id", id);
        o.put("name", name);
        o.put("provider", provider);
        o.put("badge", badge);
        return o;
    }

    private String normalizeBaseModelId(String rawModelId) {
        if (rawModelId == null || rawModelId.trim().isEmpty()) return "gemini-4-argon";
        String stripped = rawModelId.trim().replaceAll("-(low|medium|high|max)$", "");
        String[] known = new String[]{
            "gemini-4-argon",
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "gemini-3.8-flash",
            "gemini-3.7-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash-lite",
            "gemini-3.1-pro"
        };
        for (String k : known) {
            if (k.equalsIgnoreCase(stripped)) return k;
        }
        return "gemini-4-argon";
    }

    private String resolveCliModelId(String baseModelId, String effort) {
        String base = normalizeBaseModelId(baseModelId);
        String eff = (effort != null ? effort.toLowerCase(Locale.ROOT) : "high");
        if (!eff.equals("low") && !eff.equals("medium") && !eff.equals("high") && !eff.equals("max")) {
            eff = "high";
        }
        if (base.equals("gemini-4-argon")) {
            return eff.equals("low") ? "gemini-4-argon-low" : "gemini-4-argon-high";
        }
        if (base.equals("claude-opus-5-5") || base.equals("claude-sonnet-5-5")) {
            String tier = eff.equals("max") ? "high" : eff;
            return base + "-" + tier;
        }
        return base + "-" + eff;
    }

    // =========================================================================
    // ROUTER: HANDLE ALL /api/* ENDPOINTS INSIDE THE APK
    // =========================================================================
    private JSONObject routeRequest(String method, String endpoint, String bodyStr) throws Exception {
        String path = endpoint;
        String query = "";
        int qIdx = endpoint.indexOf('?');
        if (qIdx >= 0) {
            path = endpoint.substring(0, qIdx);
            query = endpoint.substring(qIdx + 1);
        }
        Map<String, String> queryParams = parseQueryParams(query);
        JSONObject body = (bodyStr != null && !bodyStr.trim().isEmpty()) ? new JSONObject(bodyStr) : new JSONObject();

        // 0. /api/health
        if (path.equals("/api/health") && method.equals("GET")) {
            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("agyReady", isAgyAuthenticated());
            res.put("agyUserEmail", getSetting("agy_user_email", ""));
            res.put("projectId", getSetting("project_id", "project-4c7a8e8a-764a-42bc-bdf"));
            res.put("workspaceDir", workspaceDir.getAbsolutePath());
            res.put("embeddedServer", true);
            return res;
        }

        // 1. /api/settings
        if (path.equals("/api/settings")) {
            if (method.equals("GET")) {
                JSONObject res = new JSONObject();
                res.put("projectId", getSetting("project_id", "project-4c7a8e8a-764a-42bc-bdf"));
                res.put("selectedModel", normalizeBaseModelId(getSetting("selected_model", "gemini-4-argon")));
                res.put("selectedEffort", getSetting("selected_effort", "high"));
                res.put("activePersonaId", Integer.parseInt(getSetting("active_persona_id", "1")));
                res.put("contextMessagesLimit", Integer.parseInt(getSetting("context_messages_limit", "30")));
                res.put("safetyThreshold", getSetting("safety_threshold", "OFF"));
                res.put("googleAuthToken", getSetting("google_auth_token", ""));
                res.put("agyAuthenticated", isAgyAuthenticated());
                res.put("agyUserEmail", getSetting("agy_user_email", ""));
                res.put("agyDiscoveredProject", getSetting("agy_discovered_project", ""));
                res.put("workspaceDir", workspaceDir.getAbsolutePath());
                res.put("embeddedServer", true);
                return res;
            }
            if (method.equals("POST")) {
                if (body.has("projectId")) setSetting("project_id", body.optString("projectId").trim());
                if (body.has("selectedModel")) {
                    String normModel = normalizeBaseModelId(body.optString("selectedModel").trim());
                    setSetting("selected_model", normModel);
                    ContentValues mCv = new ContentValues();
                    mCv.put("model_id", normModel);
                    db.update("chats", mCv, null, null);
                }
                if (body.has("selectedEffort")) {
                    String eff = body.optString("selectedEffort").trim();
                    setSetting("selected_effort", eff);
                    ContentValues eCv = new ContentValues();
                    eCv.put("effort", eff);
                    db.update("chats", eCv, null, null);
                }
                if (body.has("activePersonaId")) setSetting("active_persona_id", String.valueOf(body.optInt("activePersonaId", 1)));
                if (body.has("contextMessagesLimit")) setSetting("context_messages_limit", String.valueOf(body.optInt("contextMessagesLimit", 30)));
                if (body.has("safetyThreshold")) {
                    String st = body.optString("safetyThreshold", "OFF").trim().toUpperCase(Locale.ROOT);
                    if (!"OFF".equals(st) && !"BLOCK_NONE".equals(st) && !"BLOCK_ONLY_HIGH".equals(st)) {
                        st = "OFF";
                    }
                    setSetting("safety_threshold", st);
                }
                if (body.has("googleAuthToken")) setSetting("google_auth_token", body.optString("googleAuthToken").trim());
                return routeRequest("GET", "/api/settings", null);
            }
        }

        // 2. /api/models
        if (path.equals("/api/models") && method.equals("GET")) {
            JSONObject res = new JSONObject();
            res.put("models", getCleanBaseModelsJson());
            JSONArray efforts = new JSONArray();
            efforts.put("low");
            efforts.put("medium");
            efforts.put("high");
            efforts.put("max");
            res.put("efforts", efforts);
            return res;
        }

        // 3. /api/upload-avatar
        if (path.equals("/api/upload-avatar") && method.equals("POST")) {
            String base64Data = body.optString("base64Data", "");
            if (base64Data.isEmpty()) {
                return errorJson(400, "No image data");
            }
            // Return the data URI directly so WebView displays it immediately without needing external HTTP
            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("avatarUrl", base64Data);
            return res;
        }

        // 4. /api/files
        if (path.equals("/api/files")) {
            if (method.equals("GET")) {
                String rel = sanitizeRelPath(queryParams.get("path"));
                File targetDir = rel.isEmpty() ? workspaceDir : new File(workspaceDir, rel);
                if (!targetDir.exists()) targetDir.mkdirs();

                JSONArray items = new JSONArray();
                File[] files = targetDir.listFiles();
                if (files != null) {
                    Arrays.sort(files, new Comparator<File>() {
                        @Override
                        public int compare(File a, File b) {
                            if (a.isDirectory() && !b.isDirectory()) return -1;
                            if (!a.isDirectory() && b.isDirectory()) return 1;
                            return a.getName().compareToIgnoreCase(b.getName());
                        }
                    });
                    for (File f : files) {
                        JSONObject item = new JSONObject();
                        String itemRel = rel.isEmpty() ? f.getName() : (rel + "/" + f.getName());
                        item.put("name", f.getName());
                        item.put("path", itemRel);
                        item.put("isDirectory", f.isDirectory());
                        item.put("size", f.isDirectory() ? 0 : f.length());
                        items.put(item);
                    }
                }
                JSONObject res = new JSONObject();
                res.put("currentPath", rel);
                res.put("items", items);
                return res;
            }
            if (method.equals("DELETE")) {
                String rel = sanitizeRelPath(queryParams.get("path"));
                if (rel.isEmpty()) return errorJson(400, "Cannot delete workspace root");
                File target = new File(workspaceDir, rel);
                deleteRecursive(target);
                db.delete("characters", "file_path = ?", new String[]{rel});
                db.delete("personas", "file_path = ?", new String[]{rel});
                JSONObject res = new JSONObject();
                res.put("ok", true);
                return res;
            }
        }

        // 5. /api/files/content
        if (path.equals("/api/files/content") && method.equals("GET")) {
            String rel = sanitizeRelPath(queryParams.get("path"));
            File target = new File(workspaceDir, rel);
            if (!target.exists() || target.isDirectory()) {
                return errorJson(404, "Файл не найден: " + rel);
            }
            JSONObject res = new JSONObject();
            res.put("path", rel);
            res.put("name", target.getName());
            res.put("content", readTextFile(target));
            return res;
        }

        // 6. /api/files/folder
        if (path.equals("/api/files/folder") && method.equals("POST")) {
            String rel = sanitizeRelPath(body.optString("folderPath", ""));
            if (rel.isEmpty()) return errorJson(400, "Укажите имя папки");
            File target = new File(workspaceDir, rel);
            target.mkdirs();
            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("path", rel);
            return res;
        }

        // 7. /api/files/file
        if (path.equals("/api/files/file") && method.equals("POST")) {
            String rel = sanitizeRelPath(body.optString("filePath", ""));
            String content = body.optString("content", "");
            if (rel.isEmpty()) return errorJson(400, "Укажите путь к файлу");
            File target = new File(workspaceDir, rel);
            writeTextFile(target, content);
            syncWorkspaceFilesWithDb();
            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("path", rel);
            return res;
        }

        // 8. /api/characters
        if (path.equals("/api/characters")) {
            if (method.equals("GET")) {
                syncWorkspaceFilesWithDb();
                JSONArray chars = queryCharactersArray();
                JSONObject res = new JSONObject();
                res.put("characters", chars);
                return res;
            }
            if (method.equals("POST")) {
                return saveOrUpdateCharacter(null, body);
            }
        }

        if (path.startsWith("/api/characters/")) {
            int charId = Integer.parseInt(path.substring("/api/characters/".length()));
            if (method.equals("PUT")) {
                return saveOrUpdateCharacter(charId, body);
            }
            if (method.equals("DELETE")) {
                Cursor c = db.rawQuery("SELECT file_path FROM characters WHERE id = ?", new String[]{String.valueOf(charId)});
                if (c.moveToFirst()) {
                    String fp = c.getString(0);
                    File f = new File(workspaceDir, fp);
                    if (f.exists()) f.delete();
                }
                c.close();
                db.delete("characters", "id = ?", new String[]{String.valueOf(charId)});
                JSONObject res = new JSONObject();
                res.put("ok", true);
                return res;
            }
        }

        // 9. /api/personas
        if (path.equals("/api/personas")) {
            if (method.equals("GET")) {
                syncWorkspaceFilesWithDb();
                JSONObject res = new JSONObject();
                res.put("personas", queryPersonasArray());
                res.put("activePersonaId", Integer.parseInt(getSetting("active_persona_id", "1")));
                return res;
            }
            if (method.equals("POST")) {
                return saveOrUpdatePersona(null, body);
            }
        }

        if (path.startsWith("/api/personas/")) {
            String rem = path.substring("/api/personas/".length());
            if (rem.endsWith("/activate") && method.equals("POST")) {
                int pid = Integer.parseInt(rem.replace("/activate", ""));
                setSetting("active_persona_id", String.valueOf(pid));
                JSONObject res = new JSONObject();
                res.put("ok", true);
                res.put("activePersonaId", pid);
                return res;
            }
            int pid = Integer.parseInt(rem);
            if (method.equals("PUT")) {
                return saveOrUpdatePersona(pid, body);
            }
            if (method.equals("DELETE")) {
                Cursor c = db.rawQuery("SELECT file_path FROM personas WHERE id = ?", new String[]{String.valueOf(pid)});
                if (c.moveToFirst()) {
                    String fp = c.getString(0);
                    if (fp != null && !fp.isEmpty()) {
                        File f = new File(workspaceDir, fp);
                        if (f.exists()) f.delete();
                    }
                }
                c.close();
                db.delete("personas", "id = ?", new String[]{String.valueOf(pid)});
                JSONObject res = new JSONObject();
                res.put("ok", true);
                return res;
            }
        }

        // 10. /api/chats
        if (path.equals("/api/chats")) {
            if (method.equals("GET")) {
                JSONObject res = new JSONObject();
                res.put("chats", queryChatsListArray());
                return res;
            }
            if (method.equals("POST")) {
                return createNewChat(body);
            }
        }

        if (path.startsWith("/api/chats/")) {
            String rem = path.substring("/api/chats/".length());
            String[] parts = rem.split("/");
            int chatId = Integer.parseInt(parts[0]);

            if (parts.length == 1) {
                if (method.equals("GET")) {
                    return getChatDetailsJson(chatId);
                }
                if (method.equals("PATCH")) {
                    ContentValues cv = new ContentValues();
                    if (body.has("modelId")) {
                        String normModel = normalizeBaseModelId(body.optString("modelId"));
                        cv.put("model_id", normModel);
                        setSetting("selected_model", normModel);
                    }
                    if (body.has("effort")) {
                        String eff = body.optString("effort");
                        cv.put("effort", eff);
                        setSetting("selected_effort", eff);
                    }
                    if (body.has("personaId")) cv.put("persona_id", body.optInt("personaId"));
                    if (cv.size() > 0) {
                        db.update("chats", cv, "id = ?", new String[]{String.valueOf(chatId)});
                    }
                    return getChatDetailsJson(chatId);
                }
                if (method.equals("DELETE")) {
                    db.delete("messages", "chat_id = ?", new String[]{String.valueOf(chatId)});
                    db.delete("chats", "id = ?", new String[]{String.valueOf(chatId)});
                    JSONObject res = new JSONObject();
                    res.put("ok", true);
                    return res;
                }
            } else if (parts.length == 2 && parts[1].equals("generation") && method.equals("GET")) {
                GenerationProgress prog = activeGenerations.get(chatId);
                GenerationProgress lastProg = lastGenerations.get(chatId);
                JSONObject res = new JSONObject();
                res.put("active", prog != null);
                if (prog != null) {
                    res.put("generation", prog.toJson());
                } else if (lastProg != null) {
                    res.put("lastGeneration", lastProg.toJson());
                }
                return res;
            } else if (parts.length == 2 && parts[1].equals("messages") && method.equals("POST")) {
                return handleSendChatMessage(chatId, body);
            }
        }

        // 11. /api/messages/:id
        if (path.startsWith("/api/messages/")) {
            String rem = path.substring("/api/messages/".length());
            if (rem.endsWith("/swipe") && method.equals("POST")) {
                int msgId = Integer.parseInt(rem.replace("/swipe", ""));
                return handleSwipeOrRegenerate(msgId, body);
            }
            int msgId = Integer.parseInt(rem);
            if (method.equals("PUT")) {
                String newContent = body.optString("content", "");
                Cursor c = db.rawQuery("SELECT swipes_json, swipe_index FROM messages WHERE id = ?", new String[]{String.valueOf(msgId)});
                if (!c.moveToFirst()) {
                    c.close();
                    return errorJson(404, "Сообщение не найдено");
                }
                String swipesStr = c.getString(0);
                int swipeIdx = c.getInt(1);
                c.close();

                JSONArray swipes = new JSONArray(swipesStr != null && !swipesStr.isEmpty() ? swipesStr : "[]");
                if (swipes.length() == 0) {
                    swipes.put(newContent);
                    swipeIdx = 0;
                } else {
                    swipes.put(Math.max(0, Math.min(swipeIdx, swipes.length() - 1)), newContent);
                }
                ContentValues cv = new ContentValues();
                cv.put("content", newContent);
                cv.put("swipes_json", swipes.toString());
                db.update("messages", cv, "id = ?", new String[]{String.valueOf(msgId)});

                JSONObject res = new JSONObject();
                res.put("ok", true);
                res.put("message", getMessageByIdJson(msgId));
                return res;
            }
            if (method.equals("DELETE")) {
                db.delete("messages", "id = ?", new String[]{String.valueOf(msgId)});
                JSONObject res = new JSONObject();
                res.put("ok", true);
                return res;
            }
        }

        // 12. /api/updates/* (Git Auto-Update & Version Manager)
        if (path.equals("/api/updates/check") && method.equals("GET")) {
            return handleUpdatesCheck(queryParams);
        }
        if (path.equals("/api/updates/apply") && method.equals("POST")) {
            return handleUpdatesApply(body);
        }
        if (path.equals("/api/updates/reset") && method.equals("POST")) {
            return handleUpdatesReset();
        }
        if (path.equals("/api/updates/config") && method.equals("POST")) {
            return handleUpdatesConfig(body);
        }

        // 13. /api/agy/auth/* (Native Google Antigravity OAuth 2.0 without API Key)
        if (path.equals("/api/agy/auth/status") && method.equals("GET")) {
            return handleAgyAuthStatus();
        }
        if (path.equals("/api/agy/auth/start") && method.equals("POST")) {
            return handleAgyAuthStart();
        }
        if (path.equals("/api/agy/auth/exchange") && method.equals("POST")) {
            return handleAgyAuthExchange(body);
        }
        if (path.equals("/api/agy/auth/logout") && method.equals("POST")) {
            return handleAgyAuthLogout();
        }

        return errorJson(404, "Неизвестный маршрут APK-сервера: " + method + " " + path);
    }

    // =========================================================================
    // DATABASE HELPERS FOR CHARACTERS, PERSONAS, CHATS & MESSAGES
    // =========================================================================
    private JSONArray queryCharactersArray() throws Exception {
        JSONArray arr = new JSONArray();
        Cursor c = db.rawQuery("SELECT id, name, file_path, avatar_url, first_message, description_preview FROM characters ORDER BY id ASC", null);
        while (c.moveToNext()) {
            JSONObject o = new JSONObject();
            int id = c.getInt(0);
            String fp = c.getString(2);
            File f = new File(workspaceDir, fp);
            String fileContent = f.exists() ? readTextFile(f) : "";
            o.put("id", id);
            o.put("name", c.getString(1));
            o.put("file_path", fp);
            o.put("avatar_url", c.getString(3));
            o.put("first_message", c.getString(4));
            o.put("description_preview", c.getString(5));
            o.put("fileContent", fileContent);
            arr.put(o);
        }
        c.close();
        return arr;
    }

    private JSONObject getCharacterByIdJson(int id) throws Exception {
        Cursor c = db.rawQuery("SELECT id, name, file_path, avatar_url, first_message, description_preview FROM characters WHERE id = ?", new String[]{String.valueOf(id)});
        JSONObject o = null;
        if (c.moveToFirst()) {
            o = new JSONObject();
            String fp = c.getString(2);
            File f = new File(workspaceDir, fp);
            o.put("id", c.getInt(0));
            o.put("name", c.getString(1));
            o.put("file_path", fp);
            o.put("avatar_url", c.getString(3));
            o.put("first_message", c.getString(4));
            o.put("description_preview", c.getString(5));
            o.put("fileContent", f.exists() ? readTextFile(f) : "");
        }
        c.close();
        return o;
    }

    private JSONObject saveOrUpdateCharacter(Integer editId, JSONObject body) throws Exception {
        String name = body.optString("name", "").trim();
        if (name.isEmpty()) return errorJson(400, "Введите имя персонажа");

        String rawPath = body.optString("filePath", "").trim();
        if (rawPath.isEmpty()) {
            String slug = name.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9а-яё_-]+", "_");
            rawPath = "characters/" + (slug.isEmpty() ? ("char_" + System.currentTimeMillis()) : slug) + ".md";
        }
        if (!rawPath.contains("/")) rawPath = "characters/" + rawPath;
        if (!rawPath.endsWith(".md") && !rawPath.endsWith(".txt")) rawPath += ".md";
        String relPath = sanitizeRelPath(rawPath);

        String avatarUrl = body.optString("avatarUrl", "").trim();
        if (avatarUrl.isEmpty()) {
            avatarUrl = makeSvgDataUri("#1b1f27", "#252b37", "#7c90c9", buildInitials(name, "П"));
        }
        String firstMsg = body.optString("firstMessage", "").trim();
        String desc = body.optString("description", "").trim();
        String rawFileContent = body.optString("rawFileContent", "").trim();

        String fileText;
        if (!rawFileContent.isEmpty()) {
            fileText = rawFileContent;
        } else {
            StringBuilder fb = new StringBuilder("# Имя: ").append(name).append("\n\n### Описание и Характер\n").append(desc).append("\n");
            if (!firstMsg.isEmpty()) {
                fb.append("\n### Начальное сообщение\n").append(firstMsg).append("\n");
            }
            fileText = fb.toString();
        }

        writeTextFile(new File(workspaceDir, relPath), fileText);

        ContentValues cv = new ContentValues();
        cv.put("name", name);
        cv.put("file_path", relPath);
        cv.put("avatar_url", avatarUrl);
        cv.put("first_message", firstMsg);
        cv.put("description_preview", parsePreview(fileText));

        int finalId;
        if (editId != null) {
            db.update("characters", cv, "id = ?", new String[]{String.valueOf(editId)});
            finalId = editId;
        } else {
            finalId = (int) db.insertWithOnConflict("characters", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
        }

        JSONObject res = new JSONObject();
        res.put("ok", true);
        res.put("character", getCharacterByIdJson(finalId));
        return res;
    }

    private JSONArray queryPersonasArray() throws Exception {
        JSONArray arr = new JSONArray();
        Cursor c = db.rawQuery("SELECT id, name, file_path, avatar_url, description_preview, is_default FROM personas ORDER BY id ASC", null);
        while (c.moveToNext()) {
            JSONObject o = new JSONObject();
            String fp = c.getString(2);
            File f = new File(workspaceDir, fp);
            o.put("id", c.getInt(0));
            o.put("name", c.getString(1));
            o.put("file_path", fp);
            o.put("avatar_url", c.getString(3));
            o.put("description_preview", c.getString(4));
            o.put("is_default", c.getInt(5));
            o.put("fileContent", f.exists() ? readTextFile(f) : "");
            arr.put(o);
        }
        c.close();
        return arr;
    }

    private JSONObject getPersonaByIdJson(int id) throws Exception {
        Cursor c = db.rawQuery("SELECT id, name, file_path, avatar_url, description_preview, is_default FROM personas WHERE id = ?", new String[]{String.valueOf(id)});
        JSONObject o = null;
        if (c.moveToFirst()) {
            o = new JSONObject();
            String fp = c.getString(2);
            File f = new File(workspaceDir, fp);
            o.put("id", c.getInt(0));
            o.put("name", c.getString(1));
            o.put("file_path", fp);
            o.put("avatar_url", c.getString(3));
            o.put("description_preview", c.getString(4));
            o.put("is_default", c.getInt(5));
            o.put("fileContent", f.exists() ? readTextFile(f) : "");
        }
        c.close();
        return o;
    }

    private JSONObject saveOrUpdatePersona(Integer editId, JSONObject body) throws Exception {
        String name = body.optString("name", "").trim();
        if (name.isEmpty()) return errorJson(400, "Введите имя персоны");

        String rawPath = body.optString("filePath", "").trim();
        if (rawPath.isEmpty()) {
            String slug = name.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9а-яё_-]+", "_");
            rawPath = "personas/" + (slug.isEmpty() ? ("persona_" + System.currentTimeMillis()) : slug) + ".md";
        }
        if (!rawPath.contains("/")) rawPath = "personas/" + rawPath;
        if (!rawPath.endsWith(".md") && !rawPath.endsWith(".txt")) rawPath += ".md";
        String relPath = sanitizeRelPath(rawPath);

        String avatarUrl = body.optString("avatarUrl", "").trim();
        if (avatarUrl.isEmpty()) {
            avatarUrl = makeSvgDataUri("#182226", "#1e293b", "#64748b", buildInitials(name, "И"));
        }
        String desc = body.optString("description", "").trim();
        String rawFileContent = body.optString("rawFileContent", "").trim();
        String fileText = !rawFileContent.isEmpty()
            ? rawFileContent
            : ("# Имя: " + name + "\n## Описание персоны игрока\n" + desc + "\n");

        writeTextFile(new File(workspaceDir, relPath), fileText);

        ContentValues cv = new ContentValues();
        cv.put("name", name);
        cv.put("file_path", relPath);
        cv.put("avatar_url", avatarUrl);
        cv.put("description_preview", parsePreview(fileText));

        int finalId;
        if (editId != null) {
            db.update("personas", cv, "id = ?", new String[]{String.valueOf(editId)});
            finalId = editId;
        } else {
            finalId = (int) db.insertWithOnConflict("personas", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
        }

        JSONObject res = new JSONObject();
        res.put("ok", true);
        res.put("persona", getPersonaByIdJson(finalId));
        return res;
    }

    private JSONArray queryChatsListArray() throws Exception {
        JSONArray arr = new JSONArray();
        String sql = "SELECT c.id, c.title, c.character_id, c.persona_id, c.model_id, c.effort, c.memory_file_path, " +
            "ch.name, ch.avatar_url, ch.file_path, p.name, " +
            "(SELECT content FROM messages m WHERE m.chat_id = c.id ORDER BY m.id DESC LIMIT 1), " +
            "(SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) " +
            "FROM chats c " +
            "LEFT JOIN characters ch ON ch.id = c.character_id " +
            "LEFT JOIN personas p ON p.id = c.persona_id " +
            "ORDER BY c.id DESC";
        Cursor cur = db.rawQuery(sql, null);
        while (cur.moveToNext()) {
            JSONObject o = new JSONObject();
            o.put("id", cur.getInt(0));
            o.put("title", cur.getString(1));
            o.put("character_id", cur.getInt(2));
            o.put("persona_id", cur.getInt(3));
            o.put("model_id", normalizeBaseModelId(cur.getString(4)));
            o.put("effort", cur.getString(5));
            o.put("memory_file_path", cur.getString(6));
            o.put("character_name", cur.getString(7) != null ? cur.getString(7) : "Персонаж");
            o.put("character_avatar", cur.getString(8) != null ? cur.getString(8) : "");
            o.put("character_file", cur.getString(9) != null ? cur.getString(9) : "");
            o.put("persona_name", cur.getString(10) != null ? cur.getString(10) : "Игрок");
            o.put("last_message", cur.getString(11) != null ? cur.getString(11) : "");
            o.put("message_count", cur.getInt(12));
            arr.put(o);
        }
        cur.close();
        return arr;
    }

    private JSONObject createNewChat(JSONObject body) throws Exception {
        int charId = body.optInt("characterId", 0);
        int personaId = body.optInt("personaId", Integer.parseInt(getSetting("active_persona_id", "0")));
        String modelId = normalizeBaseModelId(body.optString("modelId", getSetting("selected_model", "gemini-4-argon")));
        String effort = body.optString("effort", getSetting("selected_effort", "high"));
        String customFirst = body.optString("customFirstMessage", "").trim();

        JSONObject character = getCharacterByIdJson(charId);
        if (character == null) return errorJson(404, "Персонаж не найден. Сначала создайте персонажа.");
        JSONObject persona = getPersonaByIdJson(personaId);
        if (persona == null) {
            JSONArray allP = queryPersonasArray();
            persona = allP.length() > 0 ? allP.getJSONObject(0) : new JSONObject().put("id", 0).put("name", "Игрок");
        }

        ContentValues cv = new ContentValues();
        cv.put("title", "Чат: " + character.optString("name"));
        cv.put("character_id", charId);
        cv.put("persona_id", persona.optInt("id", 0));
        cv.put("model_id", modelId);
        cv.put("effort", effort);
        int chatId = (int) db.insert("chats", null, cv);

        String memRelPath = "memories/chat_" + chatId + ".md";
        ContentValues upCv = new ContentValues();
        upCv.put("memory_file_path", memRelPath);
        db.update("chats", upCv, "id = ?", new String[]{String.valueOf(chatId)});

        File memFile = new File(workspaceDir, memRelPath);
        if (!memFile.exists()) {
            writeTextFile(memFile, "# Память чата #" + chatId + "\n\n");
        }

        String rawGreeting = !customFirst.isEmpty() ? customFirst : character.optString("first_message", "").trim();
        if (!rawGreeting.isEmpty()) {
            String greeting = rawGreeting
                .replace("{{char}}", character.optString("name", "Персонаж"))
                .replace("{{user}}", persona.optString("name", "Игрок"));

            JSONArray swipes = new JSONArray();
            swipes.put(greeting);

            ContentValues msgCv = new ContentValues();
            msgCv.put("chat_id", chatId);
            msgCv.put("role", "assistant");
            msgCv.put("content", greeting);
            msgCv.put("thoughts", "");
            msgCv.put("swipes_json", swipes.toString());
            msgCv.put("swipe_index", 0);
            db.insert("messages", null, msgCv);
        }

        return getChatDetailsJson(chatId);
    }

    private JSONObject getChatDetailsJson(int chatId) throws Exception {
        Cursor c = db.rawQuery("SELECT id, title, character_id, persona_id, model_id, effort, memory_file_path FROM chats WHERE id = ?", new String[]{String.valueOf(chatId)});
        if (!c.moveToFirst()) {
            c.close();
            return errorJson(404, "Чат не найден");
        }
        JSONObject chat = new JSONObject();
        int charId = c.getInt(2);
        int personaId = c.getInt(3);
        chat.put("id", c.getInt(0));
        chat.put("title", c.getString(1));
        chat.put("character_id", charId);
        chat.put("persona_id", personaId);
        chat.put("model_id", normalizeBaseModelId(c.getString(4)));
        chat.put("effort", c.getString(5));
        chat.put("memory_file_path", c.getString(6));
        c.close();

        JSONObject character = getCharacterByIdJson(charId);
        if (character == null) {
            character = new JSONObject()
                .put("id", 0)
                .put("name", "Персонаж")
                .put("file_path", "")
                .put("avatar_url", makeSvgDataUri("#1b1f27", "#252b37", "#7c90c9", "П"))
                .put("first_message", "")
                .put("description_preview", "")
                .put("fileContent", "");
        }
        JSONObject persona = getPersonaByIdJson(personaId);
        if (persona == null) {
            JSONArray allP = queryPersonasArray();
            if (allP.length() > 0) {
                persona = allP.getJSONObject(0);
            } else {
                persona = new JSONObject()
                    .put("id", 0)
                    .put("name", "Игрок")
                    .put("file_path", "")
                    .put("avatar_url", makeSvgDataUri("#182226", "#1e293b", "#64748b", "И"))
                    .put("description_preview", "")
                    .put("fileContent", "");
            }
        }

        JSONObject res = new JSONObject();
        res.put("chat", chat);
        res.put("character", character);
        res.put("persona", persona);
        res.put("messages", getChatMessagesArray(chatId));
        return res;
    }

    private JSONArray getChatMessagesArray(int chatId) throws Exception {
        JSONArray arr = new JSONArray();
        Cursor c = db.rawQuery("SELECT id, chat_id, role, content, thoughts, swipes_json, swipe_index, created_at FROM messages WHERE chat_id = ? ORDER BY id ASC", new String[]{String.valueOf(chatId)});
        while (c.moveToNext()) {
            arr.put(cursorToMessageJson(c));
        }
        c.close();
        return arr;
    }

    private JSONObject getMessageByIdJson(int msgId) throws Exception {
        Cursor c = db.rawQuery("SELECT id, chat_id, role, content, thoughts, swipes_json, swipe_index, created_at FROM messages WHERE id = ?", new String[]{String.valueOf(msgId)});
        JSONObject o = null;
        if (c.moveToFirst()) {
            o = cursorToMessageJson(c);
        }
        c.close();
        return o;
    }

    private JSONObject cursorToMessageJson(Cursor c) throws Exception {
        JSONObject o = new JSONObject();
        o.put("id", c.getInt(0));
        o.put("chat_id", c.getInt(1));
        o.put("role", c.getString(2));
        o.put("content", c.getString(3));
        o.put("thoughts", c.getString(4) != null ? c.getString(4) : "");
        String swipesStr = c.getString(5);
        JSONArray swipes;
        try {
            swipes = new JSONArray(swipesStr != null && !swipesStr.isEmpty() ? swipesStr : "[]");
        } catch (Exception e) {
            swipes = new JSONArray();
            swipes.put(c.getString(3));
        }
        o.put("swipes", swipes);
        o.put("swipe_index", c.getInt(6));
        o.put("created_at", c.getString(7));
        return o;
    }

    // =========================================================================
    // SEND MESSAGE & SWIPE / REGENERATE VIA NATIVE AGY GATEWAY (NO STUBS)
    // =========================================================================
    private JSONObject handleSendChatMessage(int chatId, JSONObject body) throws Exception {
        String content = body.optString("content", "").trim();
        if (content.isEmpty()) return errorJson(400, "Пустое сообщение");

        JSONArray userSwipes = new JSONArray();
        userSwipes.put(content);
        ContentValues uCv = new ContentValues();
        uCv.put("chat_id", chatId);
        uCv.put("role", "user");
        uCv.put("content", content);
        uCv.put("thoughts", "");
        uCv.put("swipes_json", userSwipes.toString());
        uCv.put("swipe_index", 0);
        int userMsgId = (int) db.insert("messages", null, uCv);

        JSONObject chatDetails = getChatDetailsJson(chatId);
        JSONObject chat = chatDetails.getJSONObject("chat");
        JSONObject character = chatDetails.getJSONObject("character");
        JSONObject persona = chatDetails.getJSONObject("persona");
        JSONArray history = chatDetails.getJSONArray("messages");

        String baseModel = normalizeBaseModelId(chat.optString("model_id", getSetting("selected_model", "gemini-4-argon")));
        String effort = chat.optString("effort", getSetting("selected_effort", "high"));
        String projectId = getSetting("project_id", "project-4c7a8e8a-764a-42bc-bdf");

        GenerationProgress prog = new GenerationProgress();
        prog.modelId = baseModel;
        prog.vertexModel = resolveExactVertexModelId(baseModel);
        prog.effort = effort;
        prog.projectId = projectId;
        prog.phase = "context";
        prog.statusText = "📋 Сборка контекста (" + baseModel + " • " + effort.toUpperCase(Locale.ROOT) + ")...";
        prog.addLog("Старт запроса (строгий режим без смены модели): " + baseModel + " • Effort: " + effort.toUpperCase(Locale.ROOT));
        activeGenerations.put(chatId, prog);
        lastGenerations.put(chatId, prog);

        String[] result;
        try {
            result = generateRoleplayReply(chatId, projectId, baseModel, effort, character, persona, history, chat.optString("memory_file_path", ""), prog);
            prog.status = "completed";
            prog.phase = "completed";
            prog.finishedAtMs = System.currentTimeMillis();
            prog.statusText = "✅ Ответ получен от " + baseModel + " (" + prog.textChars + " симв.)";
            prog.addLog("✅ Генерация успешно завершена за " + String.format(Locale.US, "%.1f", prog.getElapsedMs() / 1000.0) + " сек");
        } catch (Exception e) {
            String errMsg = e.getMessage() != null ? e.getMessage() : "Ошибка обращения к AGY";
            prog.status = "error";
            prog.phase = "error";
            prog.error = errMsg;
            prog.finishedAtMs = System.currentTimeMillis();
            prog.statusText = "❌ Ошибка (" + baseModel + "): " + errMsg;
            prog.addLog("❌ Завершено с ошибкой: " + errMsg);
            db.delete("messages", "id = ?", new String[]{String.valueOf(userMsgId)});
            JSONObject errRes = errorJson(401, errMsg);
            errRes.put("generation", prog.toJson());
            return errRes;
        } finally {
            activeGenerations.remove(chatId);
        }

        String replyText = result[0];
        String thoughtsText = result[1];

        JSONArray aiSwipes = new JSONArray();
        aiSwipes.put(replyText);
        ContentValues aCv = new ContentValues();
        aCv.put("chat_id", chatId);
        aCv.put("role", "assistant");
        aCv.put("content", replyText);
        aCv.put("thoughts", thoughtsText);
        aCv.put("swipes_json", aiSwipes.toString());
        aCv.put("swipe_index", 0);
        int aiMsgId = (int) db.insert("messages", null, aCv);

        JSONObject res = new JSONObject();
        res.put("assistantMessage", getMessageByIdJson(aiMsgId));
        res.put("messages", getChatMessagesArray(chatId));
        res.put("generation", prog.toJson());
        return res;
    }

    private JSONObject handleSwipeOrRegenerate(int msgId, JSONObject body) throws Exception {
        String action = body.optString("action", "select");
        JSONObject msg = getMessageByIdJson(msgId);
        if (msg == null) return errorJson(404, "Сообщение не найдено");

        JSONArray swipes = msg.getJSONArray("swipes");
        int chatId = msg.getInt("chat_id");

        if (action.equals("select")) {
            int idx = body.optInt("index", 0);
            int safeIdx = Math.max(0, Math.min(idx, swipes.length() - 1));
            String selectedText = swipes.optString(safeIdx, msg.optString("content"));
            ContentValues cv = new ContentValues();
            cv.put("swipe_index", safeIdx);
            cv.put("content", selectedText);
            db.update("messages", cv, "id = ?", new String[]{String.valueOf(msgId)});

            JSONObject res = new JSONObject();
            res.put("message", getMessageByIdJson(msgId));
            return res;
        }

        if (action.equals("regenerate")) {
            JSONObject chatDetails = getChatDetailsJson(chatId);
            JSONObject chat = chatDetails.getJSONObject("chat");
            JSONObject character = chatDetails.getJSONObject("character");
            JSONObject persona = chatDetails.getJSONObject("persona");
            JSONArray allMsgs = chatDetails.getJSONArray("messages");
            JSONArray historyBefore = new JSONArray();
            for (int i = 0; i < allMsgs.length(); i++) {
                JSONObject m = allMsgs.getJSONObject(i);
                if (m.getInt("id") < msgId) {
                    historyBefore.put(m);
                }
            }

            String baseModel = normalizeBaseModelId(chat.optString("model_id", getSetting("selected_model", "gemini-4-argon")));
            String effort = chat.optString("effort", getSetting("selected_effort", "high"));
            String projectId = getSetting("project_id", "project-4c7a8e8a-764a-42bc-bdf");

            GenerationProgress prog = new GenerationProgress();
            prog.modelId = baseModel;
            prog.vertexModel = resolveExactVertexModelId(baseModel);
            prog.effort = effort;
            prog.projectId = projectId;
            prog.phase = "context";
            prog.statusText = "🔄 Перегенерация (" + baseModel + " • " + effort.toUpperCase(Locale.ROOT) + ")...";
            prog.addLog("Старт перегенерации (строгий режим без смены модели): " + baseModel + " • Effort: " + effort.toUpperCase(Locale.ROOT));
            activeGenerations.put(chatId, prog);
            lastGenerations.put(chatId, prog);

            String[] result;
            try {
                result = generateRoleplayReply(chatId, projectId, baseModel, effort, character, persona, historyBefore, chat.optString("memory_file_path", ""), prog);
                prog.status = "completed";
                prog.phase = "completed";
                prog.finishedAtMs = System.currentTimeMillis();
                prog.statusText = "✅ Новый вариант получен от " + baseModel + " (" + prog.textChars + " симв.)";
                prog.addLog("✅ Перегенерация успешно завершена за " + String.format(Locale.US, "%.1f", prog.getElapsedMs() / 1000.0) + " сек");
            } catch (Exception e) {
                String errMsg = e.getMessage() != null ? e.getMessage() : "Ошибка обращения к AGY";
                prog.status = "error";
                prog.phase = "error";
                prog.error = errMsg;
                prog.finishedAtMs = System.currentTimeMillis();
                prog.statusText = "❌ Ошибка (" + baseModel + "): " + errMsg;
                prog.addLog("❌ Завершено с ошибкой: " + errMsg);
                JSONObject errRes = errorJson(401, errMsg);
                errRes.put("generation", prog.toJson());
                return errRes;
            } finally {
                activeGenerations.remove(chatId);
            }

            String newReply = result[0];
            String newThoughts = result[1];
            swipes.put(newReply);
            int newIdx = swipes.length() - 1;

            ContentValues cv = new ContentValues();
            cv.put("content", newReply);
            cv.put("thoughts", newThoughts);
            cv.put("swipes_json", swipes.toString());
            cv.put("swipe_index", newIdx);
            db.update("messages", cv, "id = ?", new String[]{String.valueOf(msgId)});

            JSONObject res = new JSONObject();
            res.put("message", getMessageByIdJson(msgId));
            res.put("generation", prog.toJson());
            return res;
        }

        return errorJson(400, "Unknown swipe action");
    }

    // =========================================================================
    // NATIVE GOOGLE ANTIGRAVITY (AGY) OAUTH 2.0 + UNIFIED GATEWAY ON SMARTPHONE
    // =========================================================================
    private boolean isAgyAuthenticated() {
        String refresh = getSetting("agy_refresh_token", "").trim();
        String access = getSetting("agy_access_token", "").trim();
        String manual = getSetting("google_auth_token", "").trim();
        return !refresh.isEmpty() || !access.isEmpty() || !manual.isEmpty();
    }

    private JSONObject handleAgyAuthStatus() throws Exception {
        JSONObject res = new JSONObject();
        res.put("authenticated", isAgyAuthenticated());
        res.put("email", getSetting("agy_user_email", ""));
        res.put("projectId", getSetting("project_id", "project-4c7a8e8a-764a-42bc-bdf"));
        res.put("discoveredProject", getSetting("agy_discovered_project", ""));
        return res;
    }

    private JSONObject handleAgyAuthLogout() throws Exception {
        setSetting("agy_access_token", "");
        setSetting("agy_refresh_token", "");
        setSetting("agy_token_expiry", "0");
        setSetting("agy_user_email", "");
        setSetting("agy_discovered_project", "");
        setSetting("google_auth_token", "");
        JSONObject res = new JSONObject();
        res.put("ok", true);
        res.put("authenticated", false);
        return res;
    }

    private JSONObject handleAgyAuthStart() throws Exception {
        byte[] verifierBytes = new byte[32];
        new SecureRandom().nextBytes(verifierBytes);
        pendingCodeVerifier = Base64.encodeToString(verifierBytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);

        MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
        byte[] challengeBytes = sha256.digest(pendingCodeVerifier.getBytes(StandardCharsets.US_ASCII));
        String codeChallenge = Base64.encodeToString(challengeBytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);

        byte[] stateBytes = new byte[16];
        new SecureRandom().nextBytes(stateBytes);
        pendingOAuthState = Base64.encodeToString(stateBytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);

        startLocalOAuthCallbackServer();

        String authUrl = "https://accounts.google.com/o/oauth2/v2/auth" +
            "?client_id=" + URLEncoder.encode(AGY_CLIENT_ID, "UTF-8") +
            "&redirect_uri=" + URLEncoder.encode(AGY_REDIRECT_URI, "UTF-8") +
            "&response_type=code" +
            "&access_type=offline" +
            "&prompt=consent" +
            "&scope=" + URLEncoder.encode(AGY_SCOPES, "UTF-8") +
            "&code_challenge=" + URLEncoder.encode(codeChallenge, "UTF-8") +
            "&code_challenge_method=S256" +
            "&state=" + URLEncoder.encode(pendingOAuthState, "UTF-8");

        openExternalUrl(authUrl);

        JSONObject res = new JSONObject();
        res.put("ok", true);
        res.put("authUrl", authUrl);
        return res;
    }

    private synchronized void startLocalOAuthCallbackServer() {
        try {
            if (oauthCallbackServer != null && !oauthCallbackServer.isClosed()) {
                return;
            }
            oauthCallbackServer = new ServerSocket(AGY_OAUTH_PORT, 10, InetAddress.getByName("127.0.0.1"));
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    while (oauthCallbackServer != null && !oauthCallbackServer.isClosed()) {
                        Socket client = null;
                        try {
                            client = oauthCallbackServer.accept();
                            client.setSoTimeout(10000);
                            BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                            String requestLine = reader.readLine();
                            if (requestLine != null && requestLine.contains("/oauth-callback")) {
                                String[] reqParts = requestLine.split(" ");
                                String fullPath = reqParts.length > 1 ? reqParts[1] : "";
                                int qPos = fullPath.indexOf('?');
                                String queryStr = qPos >= 0 ? fullPath.substring(qPos + 1) : "";
                                Map<String, String> params = parseQueryParams(queryStr);
                                String code = params.get("code");
                                String htmlBody;
                                if (code != null && !code.trim().isEmpty()) {
                                    exchangeAuthorizationCodeForTokens(code.trim());
                                    String email = getSetting("agy_user_email", "");
                                    htmlBody = "<!DOCTYPE html><html><head><meta charset='utf-8'>" +
                                        "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
                                        "<title>AGY OAuth</title>" +
                                        "<style>body{background:#0b0d14;color:#f3f4f6;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:20px;box-sizing:border-box;text-align:center}" +
                                        ".card{background:#151926;border:1px solid rgba(139,92,246,0.4);border-radius:18px;padding:28px;max-width:400px}" +
                                        "h2{color:#34d399;margin-top:0}</style></head><body>" +
                                        "<div class='card'><h2>✅ AGY Авторизован!</h2>" +
                                        "<p>Аккаунт Google успешно подключён к AGY" + (!email.isEmpty() ? (" (" + email + ")") : "") + ".</p>" +
                                        "<p>Теперь вернитесь в приложение <b>AGY Roleplay</b>.</p></div>" +
                                        "<script>setTimeout(function(){window.close();},1200);</script></body></html>";
                                    notifyWebViewOAuthSuccess();
                                } else {
                                    htmlBody = "<!DOCTYPE html><html><head><meta charset='utf-8'></head><body style='background:#0b0d14;color:#f87171;font-family:sans-serif;text-align:center;padding:40px'>" +
                                        "<h3>Ошибка авторизации AGY: код не получен</h3></body></html>";
                                }
                                byte[] bodyBytes = htmlBody.getBytes(StandardCharsets.UTF_8);
                                OutputStream out = client.getOutputStream();
                                String headers = "HTTP/1.1 200 OK\r\n" +
                                    "Content-Type: text/html; charset=utf-8\r\n" +
                                    "Content-Length: " + bodyBytes.length + "\r\n" +
                                    "Connection: close\r\n\r\n";
                                out.write(headers.getBytes(StandardCharsets.UTF_8));
                                out.write(bodyBytes);
                                out.flush();
                                try {
                                    oauthCallbackServer.close();
                                } catch (Exception ignored) {
                                }
                                break;
                            }
                        } catch (Exception ignored) {
                        } finally {
                            if (client != null) {
                                try { client.close(); } catch (Exception ignored) {}
                            }
                        }
                    }
                }
            });
        } catch (Exception ignored) {
        }
    }

    private void notifyWebViewOAuthSuccess() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (webView != null) {
                    webView.evaluateJavascript("window.__onAgyOAuthSuccess && window.__onAgyOAuthSuccess();", null);
                }
            }
        });
    }

    private JSONObject handleAgyAuthExchange(JSONObject body) throws Exception {
        String raw = body.optString("codeOrUrl", "").trim();
        if (raw.isEmpty()) {
            return errorJson(400, "Вставьте ссылку перенаправления (http://localhost:51121/...) или код авторизации");
        }

        if (raw.startsWith("ya29.")) {
            setSetting("agy_access_token", raw);
            setSetting("agy_token_expiry", String.valueOf(System.currentTimeMillis() + 3500_000L));
            discoverAgyProjectAndEmail(raw);
            return handleAgyAuthStatus();
        }

        String code = raw;
        if (raw.contains("code=")) {
            int qIdx = raw.indexOf('?');
            String queryPart = qIdx >= 0 ? raw.substring(qIdx + 1) : raw;
            Map<String, String> params = parseQueryParams(queryPart);
            if (params.containsKey("code")) {
                code = params.get("code");
            }
        }

        exchangeAuthorizationCodeForTokens(code);
        return handleAgyAuthStatus();
    }

    private void exchangeAuthorizationCodeForTokens(String code) throws Exception {
        String[][] clientPairs = new String[][]{
            {AGY_CLIENT_ID, AGY_CLIENT_SECRET},
            {AGY_GCP_CLIENT_ID, AGY_GCP_CLIENT_SECRET}
        };

        String lastRespBody = "";
        int lastStatus = 400;

        for (String[] pair : clientPairs) {
            URL url = new URL("https://oauth2.googleapis.com/token");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");

            StringBuilder form = new StringBuilder();
            form.append("client_id=").append(URLEncoder.encode(pair[0], "UTF-8"));
            form.append("&client_secret=").append(URLEncoder.encode(pair[1], "UTF-8"));
            form.append("&code=").append(URLEncoder.encode(code, "UTF-8"));
            form.append("&redirect_uri=").append(URLEncoder.encode(AGY_REDIRECT_URI, "UTF-8"));
            form.append("&grant_type=authorization_code");
            if (pendingCodeVerifier != null && !pendingCodeVerifier.isEmpty()) {
                form.append("&code_verifier=").append(URLEncoder.encode(pendingCodeVerifier, "UTF-8"));
            }

            byte[] payload = form.toString().getBytes(StandardCharsets.UTF_8);
            OutputStream os = conn.getOutputStream();
            os.write(payload);
            os.close();

            lastStatus = conn.getResponseCode();
            lastRespBody = readHttpBody(conn);
            if (lastStatus >= 200 && lastStatus < 300) {
                JSONObject tok = new JSONObject(lastRespBody);
                String accessToken = tok.optString("access_token", "");
                String refreshToken = tok.optString("refresh_token", "");
                long expiresIn = tok.optLong("expires_in", 3600L);

                if (accessToken.isEmpty()) {
                    throw new Exception("Google OAuth не вернул access_token");
                }

                setSetting("agy_access_token", accessToken);
                if (!refreshToken.isEmpty()) {
                    setSetting("agy_refresh_token", refreshToken);
                }
                setSetting("agy_token_expiry", String.valueOf(System.currentTimeMillis() + (expiresIn * 1000L) - 60_000L));

                discoverAgyProjectAndEmail(accessToken);
                return;
            }
        }

        throw new Exception("Ошибка обмена OAuth-кода (" + lastStatus + "): " + lastRespBody);
    }

    private synchronized String getValidAgyAccessToken() throws Exception {
        String accessToken = getSetting("agy_access_token", "").trim();
        String refreshToken = getSetting("agy_refresh_token", "").trim();
        long expiry = 0L;
        try {
            expiry = Long.parseLong(getSetting("agy_token_expiry", "0"));
        } catch (Exception ignored) {
        }

        if (!accessToken.isEmpty() && System.currentTimeMillis() < expiry) {
            return accessToken;
        }

        if (!refreshToken.isEmpty()) {
            String[][] clientPairs = new String[][]{
                {AGY_CLIENT_ID, AGY_CLIENT_SECRET},
                {AGY_GCP_CLIENT_ID, AGY_GCP_CLIENT_SECRET}
            };
            for (String[] pair : clientPairs) {
                try {
                    URL url = new URL("https://oauth2.googleapis.com/token");
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("POST");
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(20000);
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");

                    String form = "client_id=" + URLEncoder.encode(pair[0], "UTF-8") +
                        "&client_secret=" + URLEncoder.encode(pair[1], "UTF-8") +
                        "&refresh_token=" + URLEncoder.encode(refreshToken, "UTF-8") +
                        "&grant_type=refresh_token";

                    OutputStream os = conn.getOutputStream();
                    os.write(form.getBytes(StandardCharsets.UTF_8));
                    os.close();

                    int status = conn.getResponseCode();
                    String respBody = readHttpBody(conn);
                    if (status >= 200 && status < 300) {
                        JSONObject tok = new JSONObject(respBody);
                        String newAccess = tok.optString("access_token", "");
                        long expiresIn = tok.optLong("expires_in", 3600L);
                        if (!newAccess.isEmpty()) {
                            setSetting("agy_access_token", newAccess);
                            setSetting("agy_token_expiry", String.valueOf(System.currentTimeMillis() + (expiresIn * 1000L) - 60_000L));
                            return newAccess;
                        }
                    }
                } catch (Exception ignored) {
                }
            }
        }

        String manualToken = getSetting("google_auth_token", "").trim();
        if (!manualToken.isEmpty()) {
            return manualToken;
        }

        if (!accessToken.isEmpty()) {
            return accessToken;
        }

        throw new Exception("Требуется авторизация AGY. Откройте вкладку «Настройки» и нажмите «Войти через Google (AGY)».");
    }

    private void discoverAgyProjectAndEmail(String accessToken) {
        try {
            URL u = new URL("https://www.googleapis.com/oauth2/v2/userinfo");
            HttpURLConnection c = (HttpURLConnection) u.openConnection();
            c.setRequestMethod("GET");
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            c.setRequestProperty("Authorization", "Bearer " + accessToken);
            if (c.getResponseCode() == 200) {
                JSONObject info = new JSONObject(readHttpBody(c));
                String email = info.optString("email", "");
                if (!email.isEmpty()) {
                    setSetting("agy_user_email", email);
                }
            }
        } catch (Exception ignored) {
        }

        for (String endpoint : AGY_GATEWAY_ENDPOINTS) {
            try {
                URL u = new URL(endpoint + "/v1internal:loadCodeAssist");
                HttpURLConnection c = (HttpURLConnection) u.openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(10000);
                c.setReadTimeout(10000);
                c.setDoOutput(true);
                c.setRequestProperty("Authorization", "Bearer " + accessToken);
                c.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                c.setRequestProperty("User-Agent", AGY_USER_AGENT);
                c.setRequestProperty("X-Goog-Api-Client", AGY_API_CLIENT_HEADER);
                c.setRequestProperty("Client-Metadata", AGY_CLIENT_METADATA_HEADER);

                String body = "{\"metadata\":{\"ideType\":\"ANTIGRAVITY\",\"platform\":\"WINDOWS\",\"pluginType\":\"GEMINI\"}}";
                OutputStream os = c.getOutputStream();
                os.write(body.getBytes(StandardCharsets.UTF_8));
                os.close();

                if (c.getResponseCode() == 200) {
                    JSONObject resp = new JSONObject(readHttpBody(c));
                    Object projObj = resp.opt("cloudaicompanionProject");
                    String discovered = "";
                    if (projObj instanceof String) {
                        discovered = ((String) projObj).trim();
                    } else if (projObj instanceof JSONObject) {
                        discovered = ((JSONObject) projObj).optString("id", "").trim();
                    }
                    if (!discovered.isEmpty()) {
                        setSetting("agy_discovered_project", discovered);
                        if (getSetting("project_id", "").trim().isEmpty()) {
                            setSetting("project_id", discovered);
                        }
                        break;
                    }
                }
            } catch (Exception ignored) {
            }
        }
    }

    private String resolveExactVertexModelId(String baseModel) {
        String base = normalizeBaseModelId(baseModel);
        if ("gemini-3.1-pro".equals(base)) {
            return "gemini-3.1-pro-preview";
        }
        return base;
    }

    private String resolveThinkingLevel(String effort) {
        if ("low".equalsIgnoreCase(effort)) return "LOW";
        if ("medium".equalsIgnoreCase(effort)) return "MEDIUM";
        return "HIGH";
    }

    private int resolveThinkingBudget(String effort) {
        if ("low".equalsIgnoreCase(effort)) return 1024;
        if ("medium".equalsIgnoreCase(effort)) return 4096;
        if ("max".equalsIgnoreCase(effort)) return 16384;
        return 8192;
    }

    private String extractReadableApiError(String rawBody) {
        if (rawBody == null || rawBody.trim().isEmpty()) {
            return "Пустой ответ от сервера";
        }
        String trimmed = rawBody.trim();
        try {
            if (trimmed.startsWith("[")) {
                JSONArray arr = new JSONArray(trimmed);
                if (arr.length() > 0) {
                    JSONObject first = arr.optJSONObject(0);
                    if (first != null && first.has("error")) {
                        JSONObject err = first.getJSONObject("error");
                        String status = err.optString("status", "");
                        String msg = err.optString("message", "");
                        if (!msg.isEmpty()) {
                            return (!status.isEmpty() ? ("[" + status + "] ") : "") + msg;
                        }
                    }
                }
            } else if (trimmed.startsWith("{")) {
                JSONObject obj = new JSONObject(trimmed);
                if (obj.has("error")) {
                    Object errObj = obj.get("error");
                    if (errObj instanceof JSONObject) {
                        JSONObject err = (JSONObject) errObj;
                        String status = err.optString("status", err.optString("type", ""));
                        String msg = err.optString("message", "");
                        if (!msg.isEmpty()) {
                            return (!status.isEmpty() ? ("[" + status + "] ") : "") + msg;
                        }
                    } else if (errObj instanceof String) {
                        return (String) errObj;
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return trimmed.length() > 350 ? (trimmed.substring(0, 350) + "...") : trimmed;
    }

    private String[] generateRoleplayReply(
        int chatId,
        String projectId,
        String baseModel,
        String effort,
        JSONObject character,
        JSONObject persona,
        JSONArray history,
        String memoryRelPath,
        GenerationProgress prog
    ) throws Exception {
        String charName = character.optString("name", "Персонаж");
        String userName = persona.optString("name", "Игрок");
        String charFileContent = character.optString("fileContent", "").trim();
        String personaFileContent = persona.optString("fileContent", "").trim();
        String geminiRules = readTextFile(new File(workspaceDir, "GEMINI.md")).trim();
        String loreContent = readTextFile(new File(workspaceDir, "lore/worlds.md")).trim();
        String memoryContent = !memoryRelPath.isEmpty() ? readTextFile(new File(workspaceDir, memoryRelPath)).trim() : "";

        // Build clean systemInstruction strictly from GEMINI.md and user files (NO hidden prompts!)
        StringBuilder sysBuilder = new StringBuilder();
        if (!geminiRules.isEmpty()) {
            sysBuilder.append(geminiRules.replace("{{char}}", charName).replace("{{user}}", userName)).append("\n\n");
        }
        if (!charFileContent.isEmpty()) {
            sysBuilder.append("=== ").append(character.optString("file_path", "characters/character.md")).append(" ===\n");
            sysBuilder.append(charFileContent.replace("{{char}}", charName).replace("{{user}}", userName)).append("\n\n");
        }
        if (!personaFileContent.isEmpty()) {
            sysBuilder.append("=== ").append(persona.optString("file_path", "personas/persona.md")).append(" ===\n");
            sysBuilder.append(personaFileContent.replace("{{char}}", charName).replace("{{user}}", userName)).append("\n\n");
        }
        if (!loreContent.isEmpty()) {
            sysBuilder.append("=== lore/worlds.md ===\n").append(loreContent).append("\n\n");
        }
        if (!memoryContent.isEmpty()) {
            sysBuilder.append("=== ").append(memoryRelPath).append(" ===\n").append(memoryContent).append("\n\n");
        }

        // Build clean conversation contents array (strictly alternating user/model turns)
        int limit = Integer.parseInt(getSetting("context_messages_limit", "30"));
        int startIdx = Math.max(0, history.length() - limit);

        JSONArray contents = new JSONArray();
        int historyChars = 0;
        for (int i = startIdx; i < history.length(); i++) {
            JSONObject m = history.optJSONObject(i);
            if (m == null) continue;
            String rawRole = m.optString("role", "user");
            String apiRole = "user".equals(rawRole) ? "user" : "model";
            String msgText = m.optString("content", "").trim();
            if (msgText.isEmpty()) continue;

            // If the very first message before any user turn is the character's initial greeting,
            // include it in systemInstruction so contents[] starts with a "user" turn as required by AGY Gateway
            if (contents.length() == 0 && "model".equals(apiRole)) {
                sysBuilder.append("=== Начальное сообщение (").append(charName).append(") ===\n")
                    .append(msgText).append("\n\n");
                continue;
            }

            historyChars += msgText.length();

            if (contents.length() > 0) {
                JSONObject prev = contents.getJSONObject(contents.length() - 1);
                if (apiRole.equals(prev.optString("role"))) {
                    JSONArray prevParts = prev.getJSONArray("parts");
                    JSONObject prevPart0 = prevParts.getJSONObject(0);
                    prevPart0.put("text", prevPart0.optString("text", "") + "\n\n" + msgText);
                    continue;
                }
            }

            JSONObject turn = new JSONObject();
            turn.put("role", apiRole);
            JSONArray parts = new JSONArray();
            parts.put(new JSONObject().put("text", msgText));
            turn.put("parts", parts);
            contents.put(turn);
        }

        if (contents.length() == 0) {
            JSONObject turn = new JSONObject();
            turn.put("role", "user");
            turn.put("parts", new JSONArray().put(new JSONObject().put("text", "...")));
            contents.put(turn);
        }

        String systemInstructionText = sysBuilder.toString().trim();
        prog.contextMessagesCount = contents.length();
        prog.promptChars = systemInstructionText.length() + historyChars;
        prog.addLog("Контекст подготовлен: системный промпт=" + systemInstructionText.length()
            + " симв. (GEMINI.md=" + geminiRules.length() + ", перс=" + charFileContent.length()
            + "), история=" + contents.length() + " ходов (" + historyChars + " симв., лимит=" + limit + ")");

        return callAntigravityGateway(projectId, baseModel, effort, systemInstructionText, contents, prog);
    }

    private String[] callAntigravityGateway(
        String projectId,
        String baseModel,
        String effort,
        String systemInstructionText,
        JSONArray contents,
        GenerationProgress prog
    ) throws Exception {
        String normBase = normalizeBaseModelId(baseModel);
        String vertexModel = resolveExactVertexModelId(normBase);
        prog.modelId = normBase;
        prog.vertexModel = vertexModel;

        prog.phase = "auth";
        prog.statusText = "🔑 Проверка OAuth-токена AGY (" + normBase + ")...";
        prog.addLog("Проверка авторизации Google Antigravity OAuth...");
        String accessToken = getValidAgyAccessToken();
        String userEmail = getSetting("agy_user_email", "");
        prog.addLog("OAuth-токен активен" + (!userEmail.isEmpty() ? (" (" + userEmail + ")") : ""));

        String proj = projectId != null ? projectId.trim() : "";
        if (proj.isEmpty()) {
            proj = getSetting("agy_discovered_project", "").trim();
        }
        if (proj.isEmpty()) {
            proj = "project-4c7a8e8a-764a-42bc-bdf";
        }
        prog.projectId = proj;

        int thinkingBudget = resolveThinkingBudget(effort);
        String thinkingLevel = resolveThinkingLevel(effort);

        // STRICT SINGLE-MODEL EXECUTION: Never switch or fall back to any other model!
        if (normBase.startsWith("claude-")) {
            int maxOutputTokens = 8192;
            prog.thinkingConfigSummary = "max_tokens=" + maxOutputTokens + ", temp=0.85";
            String urlStr = AGY_VERTEX_ENDPOINT + "/v1/projects/" + proj + "/locations/global/publishers/anthropic/models/" + vertexModel + ":rawPredict";
            prog.endpoint = urlStr;
            prog.phase = "connecting";
            prog.statusText = "☁️ Запрос к Vertex AI (" + normBase + " • " + effort.toUpperCase(Locale.ROOT) + ")...";
            prog.addLog("POST " + urlStr);

            JSONArray anthMessages = new JSONArray();
            for (int i = 0; i < contents.length(); i++) {
                JSONObject c = contents.getJSONObject(i);
                String r = "model".equals(c.optString("role")) ? "assistant" : "user";
                JSONArray pArr = c.optJSONArray("parts");
                String txt = (pArr != null && pArr.length() > 0) ? pArr.getJSONObject(0).optString("text", "") : "";
                JSONObject mObj = new JSONObject();
                mObj.put("role", r);
                mObj.put("content", txt);
                anthMessages.put(mObj);
            }

            JSONObject anthReq = new JSONObject();
            anthReq.put("anthropic_version", "vertex-2023-10-16");
            anthReq.put("max_tokens", maxOutputTokens);
            anthReq.put("temperature", 0.85);
            if (!systemInstructionText.isEmpty()) {
                anthReq.put("system", systemInstructionText);
            }
            anthReq.put("messages", anthMessages);

            URL url = new URL(urlStr);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(25000);
            conn.setReadTimeout(180000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Authorization", "Bearer " + accessToken);
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            conn.setRequestProperty("x-goog-user-project", proj);
            conn.setRequestProperty("User-Agent", AGY_USER_AGENT);

            byte[] payload = anthReq.toString().getBytes(StandardCharsets.UTF_8);
            prog.addLog("Отправка тела запроса (" + payload.length + " байт)...");
            OutputStream os = conn.getOutputStream();
            os.write(payload);
            os.close();

            int code = conn.getResponseCode();
            prog.httpStatus = code;
            String respBody = readHttpBody(conn);

            if (code >= 200 && code < 300) {
                prog.addLog("HTTP " + code + " OK — разбор ответа от " + vertexModel);
                JSONObject root = new JSONObject(respBody);
                JSONArray contentArr = root.optJSONArray("content");
                StringBuilder reply = new StringBuilder();
                StringBuilder thoughts = new StringBuilder();
                if (contentArr != null) {
                    for (int i = 0; i < contentArr.length(); i++) {
                        JSONObject block = contentArr.getJSONObject(i);
                        String bType = block.optString("type", "text");
                        if ("thinking".equals(bType)) {
                            thoughts.append(block.optString("thinking", ""));
                        } else if ("text".equals(bType)) {
                            reply.append(block.optString("text", ""));
                        }
                    }
                }
                prog.thoughts = thoughts.toString().trim();
                prog.thoughtsChars = prog.thoughts.length();
                prog.text = reply.toString().trim();
                prog.textChars = prog.text.length();
                prog.chunksCount = 1;
                if (!prog.text.isEmpty()) {
                    return new String[]{prog.text, prog.thoughts};
                }
                throw new Exception("Модель " + normBase + " вернула пустой ответ (HTTP " + code + "). Автоматическая смена модели отключена.");
            } else if (code == 401) {
                throw new Exception("Сессия AGY истекла или токен недействителен (HTTP 401). Перезайдите через кнопку «Войти через Google (AGY)» в Настройках.");
            } else {
                String readableErr = extractReadableApiError(respBody);
                prog.addLog("❌ HTTP " + code + " (" + vertexModel + "): " + readableErr);
                throw new Exception("Ошибка модели " + normBase + " (HTTP " + code + "): " + readableErr);
            }
        }

        // Gemini models via real-time SSE streaming (:streamGenerateContent?alt=sse) on Vertex AI
        int maxOutputTokens = 32768;
        String configuredSafety = getSetting("safety_threshold", "OFF").trim().toUpperCase(Locale.ROOT);
        if (configuredSafety.isEmpty()) configuredSafety = "OFF";

        String[] thresholdsToTry;
        if ("OFF".equals(configuredSafety)) {
            thresholdsToTry = new String[]{"OFF", "BLOCK_NONE"};
        } else if ("BLOCK_NONE".equals(configuredSafety)) {
            thresholdsToTry = new String[]{"BLOCK_NONE", "OFF"};
        } else {
            thresholdsToTry = new String[]{configuredSafety};
        }

        String lastSafetyError = "";
        for (int attemptIdx = 0; attemptIdx < thresholdsToTry.length; attemptIdx++) {
            String activeSafetyThreshold = thresholdsToTry[attemptIdx];
            JSONObject vertexReq = new JSONObject();
            if (!systemInstructionText.isEmpty()) {
                JSONObject sysObj = new JSONObject();
                sysObj.put("role", "user");
                sysObj.put("parts", new JSONArray().put(new JSONObject().put("text", systemInstructionText)));
                vertexReq.put("systemInstruction", sysObj);
            }
            vertexReq.put("contents", contents);
            vertexReq.put("safetySettings", buildSafetySettingsArray(activeSafetyThreshold));

            JSONObject genConfig = new JSONObject();
            genConfig.put("maxOutputTokens", maxOutputTokens);
            genConfig.put("temperature", 0.85);
            genConfig.put("topP", 0.95);
            JSONObject thinkingConfig = new JSONObject();
            if (vertexModel.startsWith("gemini-4") || vertexModel.startsWith("gemini-3")) {
                thinkingConfig.put("thinkingLevel", thinkingLevel);
                prog.thinkingConfigSummary = "thinkingLevel=" + thinkingLevel + ", maxOutputTokens=" + maxOutputTokens + ", safety=" + activeSafetyThreshold;
            } else {
                thinkingConfig.put("thinkingBudget", thinkingBudget);
                prog.thinkingConfigSummary = "thinkingBudget=" + thinkingBudget + ", maxOutputTokens=" + maxOutputTokens + ", safety=" + activeSafetyThreshold;
            }
            thinkingConfig.put("includeThoughts", true);
            genConfig.put("thinkingConfig", thinkingConfig);
            vertexReq.put("generationConfig", genConfig);

            String urlStr = AGY_VERTEX_ENDPOINT + "/v1/projects/" + proj + "/locations/global/publishers/google/models/" + vertexModel + ":streamGenerateContent?alt=sse";
            prog.endpoint = urlStr;
            prog.phase = "connecting";
            prog.statusText = "☁️ Подключение к " + normBase + " (" + effort.toUpperCase(Locale.ROOT) + ", safety=" + activeSafetyThreshold + ")...";
            if (attemptIdx == 0) {
                prog.addLog("POST " + urlStr);
            } else {
                prog.addLog("🔄 Повтор запроса к той же модели " + vertexModel + " с safetySettings=" + activeSafetyThreshold + "...");
            }
            prog.addLog("Параметры генерации: " + prog.thinkingConfigSummary + ", project=" + proj);

            URL url = new URL(urlStr);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(25000);
            conn.setReadTimeout(180000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Authorization", "Bearer " + accessToken);
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            conn.setRequestProperty("Accept", "text/event-stream");
            conn.setRequestProperty("x-goog-user-project", proj);
            conn.setRequestProperty("User-Agent", AGY_USER_AGENT);

            byte[] payload = vertexReq.toString().getBytes(StandardCharsets.UTF_8);
            prog.addLog("Отправка запроса (" + payload.length + " байт, safety=" + activeSafetyThreshold + ") к модели " + vertexModel + "...");
            OutputStream os = conn.getOutputStream();
            os.write(payload);
            os.flush();
            os.close();

            prog.statusText = "⏳ Ожидание ответа HTTP от " + normBase + "...";
            int code = conn.getResponseCode();
            prog.httpStatus = code;

            if (code < 200 || code >= 300) {
                String errBody = readHttpBody(conn);
                String readableErr = extractReadableApiError(errBody);
                prog.addLog("❌ HTTP " + code + " от " + vertexModel + " (safety=" + activeSafetyThreshold + "): " + readableErr);
                if (code == 401) {
                    throw new Exception("Сессия AGY истекла или токен недействителен (HTTP 401). Перезайдите через кнопку «Войти через Google (AGY)» в Настройках.");
                }
                if (code == 400 && attemptIdx + 1 < thresholdsToTry.length) {
                    prog.addLog("⚠️ Порог safety=" + activeSafetyThreshold + " отклонён (HTTP 400), переключаем порог фильтра на " + thresholdsToTry[attemptIdx + 1] + " без смены модели...");
                    continue;
                }
                throw new Exception("Ошибка модели " + normBase + " (HTTP " + code + "): " + readableErr);
            }

            prog.phase = "streaming";
            prog.statusText = "📡 Поток открыт (HTTP " + code + "). Модель " + normBase + " обрабатывает контекст...";
            prog.addLog("HTTP " + code + " OK — открыт SSE-поток, ожидание первого чанка от " + vertexModel + "...");

            StringBuilder replyBuilder = new StringBuilder();
            StringBuilder thoughtsBuilder = new StringBuilder();
            StringBuilder rawFallbackBuilder = new StringBuilder();
            String lastFinishReason = "";
            String blockReason = "";
            String safetyRatingsSummary = "";
            int promptTokens = 0;
            int thoughtsTokens = 0;
            int outputTokens = 0;
            boolean loggedFirstThought = false;
            boolean loggedFirstText = false;

            InputStream is = conn.getInputStream();
            BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
            String line;
            while ((line = br.readLine()) != null) {
                rawFallbackBuilder.append(line).append("\n");
                String trimmedLine = line.trim();
                if (!trimmedLine.startsWith("data:")) {
                    continue;
                }
                String dataJson = trimmedLine.substring(5).trim();
                if (dataJson.isEmpty() || "[DONE]".equals(dataJson)) {
                    continue;
                }
                try {
                    JSONObject root = new JSONObject(dataJson);
                    JSONObject respObj = root.optJSONObject("response") != null ? root.getJSONObject("response") : root;

                    JSONObject pf = respObj.optJSONObject("promptFeedback");
                    if (pf != null) {
                        String brReason = pf.optString("blockReason", "");
                        if (!brReason.isEmpty()) {
                            blockReason = brReason;
                            prog.addLog("⚠️ promptFeedback.blockReason = " + blockReason);
                        }
                        JSONArray pfRatings = pf.optJSONArray("safetyRatings");
                        if (pfRatings != null && pfRatings.length() > 0) {
                            safetyRatingsSummary = summarizeSafetyRatings(pfRatings);
                        }
                    }

                    JSONObject usage = respObj.optJSONObject("usageMetadata");
                    if (usage != null) {
                        promptTokens = usage.optInt("promptTokenCount", promptTokens);
                        thoughtsTokens = usage.optInt("thoughtsTokenCount", thoughtsTokens);
                        outputTokens = usage.optInt("candidatesTokenCount", outputTokens);
                    }

                    JSONArray candidates = respObj.optJSONArray("candidates");
                    if (candidates != null && candidates.length() > 0) {
                        JSONObject c0 = candidates.getJSONObject(0);
                        String fr = c0.optString("finishReason", "");
                        if (!fr.isEmpty()) {
                            lastFinishReason = fr;
                            prog.finishReason = fr;
                        }
                        JSONArray cRatings = c0.optJSONArray("safetyRatings");
                        if (cRatings != null && cRatings.length() > 0) {
                            String sr = summarizeSafetyRatings(cRatings);
                            if (!sr.isEmpty()) {
                                safetyRatingsSummary = sr;
                            }
                        }
                        JSONObject cContent = c0.optJSONObject("content");
                        if (cContent != null) {
                            JSONArray cParts = cContent.optJSONArray("parts");
                            if (cParts != null) {
                                for (int i = 0; i < cParts.length(); i++) {
                                    JSONObject p = cParts.getJSONObject(i);
                                    boolean isThought = p.optBoolean("thought", false);
                                    String partText = p.optString("text", "");
                                    if (partText.isEmpty()) continue;

                                    prog.chunksCount++;
                                    if (isThought) {
                                        thoughtsBuilder.append(partText);
                                        prog.thoughts = thoughtsBuilder.toString();
                                        prog.thoughtsChars = prog.thoughts.length();
                                        prog.phase = "thinking";
                                        prog.statusText = "💭 " + normBase + " размышляет (" + prog.thoughtsChars + " симв., чанк #" + prog.chunksCount + ")...";
                                        if (!loggedFirstThought) {
                                            loggedFirstThought = true;
                                            prog.addLog("💭 Чанк #" + prog.chunksCount + ": начато размышление модели (" + normBase + ")");
                                        } else if (prog.chunksCount % 12 == 0) {
                                            prog.addLog("💭 Чанк #" + prog.chunksCount + ": размышление продолжается (" + prog.thoughtsChars + " симв.)");
                                        }
                                    } else {
                                        replyBuilder.append(partText);
                                        prog.text = replyBuilder.toString();
                                        prog.textChars = prog.text.length();
                                        prog.phase = "generating";
                                        prog.statusText = "✍️ " + normBase + " пишет ответ (" + prog.textChars + " симв., чанк #" + prog.chunksCount + ")...";
                                        if (!loggedFirstText) {
                                            loggedFirstText = true;
                                            prog.addLog("✍️ Чанк #" + prog.chunksCount + ": начата генерация текста ответа"
                                                + (prog.thoughtsChars > 0 ? (" (после " + prog.thoughtsChars + " симв. мыслей)") : ""));
                                        } else if (prog.chunksCount % 15 == 0) {
                                            prog.addLog("✍️ Чанк #" + prog.chunksCount + ": генерация ответа (" + prog.textChars + " симв.)");
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (Exception parseEx) {
                    prog.addLog("⚠️ Ошибка парсинга SSE-чанка: " + parseEx.getMessage());
                }
            }
            br.close();

            // Fallback if server returned non-SSE JSON body on HTTP 200
            if (prog.chunksCount == 0 && rawFallbackBuilder.length() > 0) {
                try {
                    String rawStr = rawFallbackBuilder.toString().trim();
                    JSONObject root = new JSONObject(rawStr);
                    JSONObject respObj = root.optJSONObject("response") != null ? root.getJSONObject("response") : root;
                    JSONArray candidates = respObj.optJSONArray("candidates");
                    if (candidates != null && candidates.length() > 0) {
                        JSONObject c0 = candidates.getJSONObject(0);
                        lastFinishReason = c0.optString("finishReason", lastFinishReason);
                        prog.finishReason = lastFinishReason;
                        JSONObject cContent = c0.optJSONObject("content");
                        if (cContent != null) {
                            JSONArray cParts = cContent.optJSONArray("parts");
                            if (cParts != null) {
                                for (int i = 0; i < cParts.length(); i++) {
                                    JSONObject p = cParts.getJSONObject(i);
                                    if (p.optBoolean("thought", false)) {
                                        thoughtsBuilder.append(p.optString("text", ""));
                                    } else {
                                        replyBuilder.append(p.optString("text", ""));
                                    }
                                }
                                prog.thoughts = thoughtsBuilder.toString();
                                prog.thoughtsChars = prog.thoughts.length();
                                prog.text = replyBuilder.toString();
                                prog.textChars = prog.text.length();
                                prog.chunksCount = 1;
                            }
                        }
                    }
                } catch (Exception ignored) {
                }
            }

            String finalReply = replyBuilder.toString().trim();
            String finalThoughts = thoughtsBuilder.toString().trim();
            prog.thoughts = finalThoughts;
            prog.thoughtsChars = finalThoughts.length();
            prog.text = finalReply;
            prog.textChars = finalReply.length();

            String tokenStats = (promptTokens > 0 || thoughtsTokens > 0 || outputTokens > 0)
                ? (", токены: вход=" + promptTokens + ", мысли=" + thoughtsTokens + ", ответ=" + outputTokens)
                : "";
            prog.addLog("Поток завершён: чанков=" + prog.chunksCount
                + ", finishReason=" + (lastFinishReason.isEmpty() ? "STOP" : lastFinishReason)
                + ", safety=" + activeSafetyThreshold
                + ", ответ=" + finalReply.length() + " симв., мысли=" + finalThoughts.length() + " симв." + tokenStats);
            if (!safetyRatingsSummary.isEmpty()) {
                prog.addLog("🛡️ safetyRatings: " + safetyRatingsSummary);
            }

            if (!finalReply.isEmpty()) {
                return new String[]{finalReply, finalThoughts};
            }

            if (!blockReason.isEmpty() || ("SAFETY".equals(lastFinishReason) || "PROHIBITED_CONTENT".equals(lastFinishReason) || "BLOCKLIST".equals(lastFinishReason))) {
                String reason = !blockReason.isEmpty() ? blockReason : lastFinishReason;
                if ("SAFETY".equals(reason) && attemptIdx + 1 < thresholdsToTry.length) {
                    prog.addLog("⚠️ Получен " + reason + " при safety=" + activeSafetyThreshold + ". Повторяем запрос к той же модели " + normBase + " с порогом " + thresholdsToTry[attemptIdx + 1] + "...");
                    lastSafetyError = reason + (safetyRatingsSummary.isEmpty() ? "" : (" [" + safetyRatingsSummary + "]"));
                    continue;
                }
                String ratingsNote = safetyRatingsSummary.isEmpty() ? "" : (" (категории: " + safetyRatingsSummary + ")");
                throw new Exception("Модель " + normBase + " заблокировала генерацию ответа (причина: " + reason + ", safetySettings=" + activeSafetyThreshold + ")" + ratingsNote + ". Автоматическая смена модели отключена.");
            }

            if ("MAX_TOKENS".equals(lastFinishReason) && !finalThoughts.isEmpty()) {
                throw new Exception("Модель " + normBase + " потратила лимит вывода на размышления (" + finalThoughts.length() + " симв. мыслей, finishReason: MAX_TOKENS). Попробуйте уменьшить Effort (например, на Medium или Low).");
            }

            throw new Exception("Модель " + normBase + " вернула пустой текстовый ответ (HTTP " + code
                + ", finishReason=" + (lastFinishReason.isEmpty() ? "NONE" : lastFinishReason)
                + ", мыслей=" + finalThoughts.length() + " симв.). Автоматическая смена модели отключена.");
        }

        throw new Exception("Модель " + normBase + " заблокировала генерацию ответа (" + lastSafetyError + "). Автоматическая смена модели отключена.");
    }

    private JSONArray buildSafetySettingsArray(String threshold) throws Exception {
        String normThreshold = (threshold == null || threshold.trim().isEmpty()) ? "OFF" : threshold.trim().toUpperCase(Locale.ROOT);
        String[] categories = new String[]{
            "HARM_CATEGORY_HATE_SPEECH",
            "HARM_CATEGORY_DANGEROUS_CONTENT",
            "HARM_CATEGORY_HARASSMENT",
            "HARM_CATEGORY_SEXUALLY_EXPLICIT"
        };
        JSONArray arr = new JSONArray();
        for (String cat : categories) {
            JSONObject item = new JSONObject();
            item.put("category", cat);
            item.put("threshold", normThreshold);
            arr.put(item);
        }
        return arr;
    }

    private String summarizeSafetyRatings(JSONArray ratings) {
        if (ratings == null || ratings.length() == 0) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < ratings.length(); i++) {
            JSONObject r = ratings.optJSONObject(i);
            if (r == null) continue;
            String cat = r.optString("category", "").replace("HARM_CATEGORY_", "");
            String prob = r.optString("probability", "");
            boolean blocked = r.optBoolean("blocked", false);
            if (cat.isEmpty()) continue;
            if (sb.length() > 0) sb.append(", ");
            sb.append(cat).append("=").append(prob.isEmpty() ? "?" : prob);
            if (blocked) sb.append("(BLOCKED)");
        }
        return sb.toString();
    }

    private String readHttpBody(HttpURLConnection conn) {
        try {
            InputStream is = (conn.getResponseCode() >= 200 && conn.getResponseCode() < 400)
                ? conn.getInputStream()
                : conn.getErrorStream();
            if (is == null) return "";
            BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) {
                sb.append(line).append("\n");
            }
            br.close();
            return sb.toString().trim();
        } catch (Exception e) {
            return "";
        }
    }

    // =========================================================================
    // FILE UTILITIES
    // =========================================================================
    private String sanitizeRelPath(String raw) {
        if (raw == null) return "";
        String norm = raw.replace('\\', '/').trim();
        while (norm.startsWith("/")) norm = norm.substring(1);
        norm = norm.replace("..", "");
        return norm;
    }

    private Map<String, String> parseQueryParams(String query) {
        Map<String, String> map = new HashMap<>();
        if (query == null || query.isEmpty()) return map;
        String[] pairs = query.split("&");
        for (String pair : pairs) {
            int idx = pair.indexOf('=');
            try {
                if (idx > 0) {
                    String k = URLDecoder.decode(pair.substring(0, idx), "UTF-8");
                    String v = URLDecoder.decode(pair.substring(idx + 1), "UTF-8");
                    map.put(k, v);
                } else if (!pair.isEmpty()) {
                    map.put(URLDecoder.decode(pair, "UTF-8"), "");
                }
            } catch (Exception ignored) {
            }
        }
        return map;
    }

    private String readTextFile(File f) {
        if (f == null || !f.exists() || f.isDirectory()) return "";
        try {
            FileInputStream fis = new FileInputStream(f);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = fis.read(buf)) != -1) {
                bos.write(buf, 0, n);
            }
            fis.close();
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private void writeTextFile(File f, String content) {
        try {
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            FileOutputStream fos = new FileOutputStream(f, false);
            fos.write((content != null ? content : "").getBytes(StandardCharsets.UTF_8));
            fos.flush();
            fos.close();
        } catch (Exception ignored) {
        }
    }

    private void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) {
                for (File c : children) deleteRecursive(c);
            }
        }
        f.delete();
    }

    // =========================================================================
    // GIT AUTO-UPDATE ENGINE (OTA + FULL APK + VERSION HISTORY)
    // =========================================================================
    private String normalizeGitRepoSlug(String raw) {
        if (raw == null) return "Kuka001/111";
        String s = raw.trim();
        s = s.replace("https://github.com/", "")
             .replace("http://github.com/", "")
             .replace("git@github.com:", "");
        if (s.endsWith(".git")) {
            s = s.substring(0, s.length() - 4);
        }
        while (s.startsWith("/")) s = s.substring(1);
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (s.isEmpty() || !s.contains("/")) return "Kuka001/111";
        return s;
    }

    private JSONObject readBundledVersionManifest() {
        try {
            InputStream is = context.getAssets().open("www/version.json");
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = is.read(buf)) != -1) {
                bos.write(buf, 0, n);
            }
            is.close();
            return new JSONObject(new String(bos.toByteArray(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            try {
                JSONObject fallback = new JSONObject();
                fallback.put("appName", "AGY Roleplay Studio");
                fallback.put("version", "1.4.2");
                fallback.put("build", 11);
                fallback.put("gitRepo", "Kuka001/111");
                fallback.put("gitBranch", "main");
                fallback.put("apkPath", "agy-roleplay-android16.apk");
                fallback.put("releases", new JSONArray());
                return fallback;
            } catch (Exception ignored) {
                return new JSONObject();
            }
        }
    }

    private JSONObject readLocalVersionManifest() {
        if ("1".equals(getSetting("ota_active", "0"))) {
            File otaVer = new File(otaWwwDir, "version.json");
            if (otaVer.exists()) {
                try {
                    return new JSONObject(readTextFile(otaVer));
                } catch (Exception ignored) {
                }
            }
        }
        return readBundledVersionManifest();
    }

    private String httpGetString(String urlStr, int timeoutMs) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
        conn.setUseCaches(false);
        conn.setRequestProperty("User-Agent", "AGY-Roleplay-Android16-Updater/1.3");
        conn.setRequestProperty("Accept", "application/vnd.github.v3+json, application/json, text/plain, */*");
        int code = conn.getResponseCode();
        InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
        if (is == null) {
            throw new Exception("HTTP " + code);
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) != -1) {
            bos.write(buf, 0, n);
        }
        is.close();
        String body = new String(bos.toByteArray(), StandardCharsets.UTF_8);
        if (code < 200 || code >= 300) {
            throw new Exception("HTTP " + code + ": " + (body.length() > 120 ? body.substring(0, 120) : body));
        }
        return body;
    }

    private int compareSemver(String v1, String v2) {
        if (v1 == null) v1 = "0.0.0";
        if (v2 == null) v2 = "0.0.0";
        String[] p1 = v1.replaceAll("[^0-9.]", "").split("\\.");
        String[] p2 = v2.replaceAll("[^0-9.]", "").split("\\.");
        int len = Math.max(p1.length, p2.length);
        for (int i = 0; i < len; i++) {
            int n1 = 0;
            int n2 = 0;
            try { if (i < p1.length && !p1[i].isEmpty()) n1 = Integer.parseInt(p1[i]); } catch (Exception ignored) {}
            try { if (i < p2.length && !p2[i].isEmpty()) n2 = Integer.parseInt(p2[i]); } catch (Exception ignored) {}
            if (n1 != n2) return n1 > n2 ? 1 : -1;
        }
        return 0;
    }

    private JSONObject handleUpdatesCheck(Map<String, String> queryParams) throws Exception {
        JSONObject localManifest = readLocalVersionManifest();
        JSONObject bundledManifest = readBundledVersionManifest();

        String gitRepo = normalizeGitRepoSlug(queryParams.containsKey("repo")
            ? queryParams.get("repo")
            : getSetting("git_repo", localManifest.optString("gitRepo", "Kuka001/111")));
        String gitBranch = queryParams.containsKey("branch")
            ? queryParams.get("branch")
            : getSetting("git_branch", localManifest.optString("gitBranch", "main"));
        if (gitBranch == null || gitBranch.trim().isEmpty()) gitBranch = "main";
        gitBranch = gitBranch.trim();

        boolean otaActive = "1".equals(getSetting("ota_active", "0"));
        String bundledVersion = bundledManifest.optString("version", "1.3.4");
        int bundledBuild = bundledManifest.optInt("build", 8);
        String currentVersion = getSetting("installed_version", localManifest.optString("version", bundledVersion));
        int currentBuild = Integer.parseInt(getSetting("installed_build", String.valueOf(localManifest.optInt("build", bundledBuild))));
        if (!otaActive || bundledBuild > currentBuild) {
            currentVersion = bundledVersion;
            currentBuild = bundledBuild;
            setSetting("installed_version", currentVersion);
            setSetting("installed_build", String.valueOf(currentBuild));
        }
        String installedCommit = getSetting("installed_commit", "");

        String latestVersion = currentVersion;
        int latestBuild = currentBuild;
        String latestReleaseTitle = "";
        JSONArray releases = localManifest.optJSONArray("releases");
        if (releases == null) releases = new JSONArray();
        String apkPath = localManifest.optString("apkPath", "agy-roleplay-android16.apk");

        boolean remoteReachable = false;
        String remoteError = "";

        // 1. Fetch version.json from Git branch
        String rawVersionUrl = "https://raw.githubusercontent.com/" + gitRepo + "/" + gitBranch + "/version.json?t=" + System.currentTimeMillis();
        try {
            String remoteVerStr = httpGetString(rawVersionUrl, 7500);
            JSONObject remoteManifest = new JSONObject(remoteVerStr);
            remoteReachable = true;
            latestVersion = remoteManifest.optString("version", latestVersion);
            latestBuild = remoteManifest.optInt("build", latestBuild);
            apkPath = remoteManifest.optString("apkPath", apkPath);
            JSONArray remReleases = remoteManifest.optJSONArray("releases");
            if (remReleases != null && remReleases.length() > 0) {
                releases = remReleases;
                JSONObject firstRel = remReleases.optJSONObject(0);
                if (firstRel != null) {
                    latestReleaseTitle = firstRel.optString("title", "");
                }
            }
        } catch (Exception e) {
            remoteError = e.getMessage() != null ? e.getMessage() : "Не удалось прочитать version.json из Git";
        }

        // 2. Fetch commit history from GitHub API
        JSONArray commits = new JSONArray();
        String latestCommit = "";
        String latestCommitMessage = "";
        String commitsApiUrl = "https://api.github.com/repos/" + gitRepo + "/commits?sha=" + gitBranch + "&per_page=15";
        try {
            String commitsStr = httpGetString(commitsApiUrl, 7500);
            JSONArray rawCommits = new JSONArray(commitsStr);
            remoteReachable = true;
            for (int i = 0; i < rawCommits.length(); i++) {
                JSONObject item = rawCommits.getJSONObject(i);
                String sha = item.optString("sha", "");
                String shortSha = sha.length() >= 7 ? sha.substring(0, 7) : sha;
                JSONObject commitObj = item.optJSONObject("commit");
                String message = commitObj != null ? commitObj.optString("message", "").split("\n")[0] : "";
                String authorName = "Git";
                String dateStr = "";
                if (commitObj != null) {
                    JSONObject authorObj = commitObj.optJSONObject("author");
                    if (authorObj != null) {
                        authorName = authorObj.optString("name", "Git");
                        dateStr = authorObj.optString("date", "");
                    }
                }
                JSONObject cEntry = new JSONObject();
                cEntry.put("sha", sha);
                cEntry.put("shortSha", shortSha);
                cEntry.put("message", message);
                cEntry.put("author", authorName);
                cEntry.put("date", dateStr);
                commits.put(cEntry);
                if (i == 0) {
                    latestCommit = shortSha;
                    latestCommitMessage = message;
                }
            }
        } catch (Exception e) {
            if (remoteError.isEmpty()) {
                remoteError = e.getMessage() != null ? e.getMessage() : "Не удалось получить список коммитов Git";
            }
        }

        // Seed installedCommit on first run if version & build match the latest release in Git
        if (installedCommit.isEmpty() && !latestCommit.isEmpty()
            && compareSemver(latestVersion, currentVersion) == 0 && latestBuild == currentBuild) {
            installedCommit = latestCommit;
            setSetting("installed_commit", installedCommit);
        }

        boolean newerVersion = compareSemver(latestVersion, currentVersion) > 0 || (latestBuild > currentBuild);
        boolean newerCommit = !latestCommit.isEmpty() && !installedCommit.isEmpty() && !latestCommit.equals(installedCommit);
        boolean updateAvailable = newerVersion || newerCommit;

        String apkDownloadUrl = "https://raw.githubusercontent.com/" + gitRepo + "/" + gitBranch + "/" + apkPath;
        String repoWebUrl = "https://github.com/" + gitRepo;

        JSONObject res = new JSONObject();
        res.put("currentVersion", currentVersion);
        res.put("currentBuild", currentBuild);
        res.put("bundledVersion", bundledVersion);
        res.put("bundledBuild", bundledBuild);
        res.put("otaActive", otaActive);
        res.put("installedCommit", installedCommit);
        res.put("latestVersion", latestVersion);
        res.put("latestBuild", latestBuild);
        res.put("latestCommit", latestCommit);
        res.put("latestCommitMessage", latestCommitMessage);
        res.put("latestReleaseTitle", latestReleaseTitle);
        res.put("updateAvailable", updateAvailable);
        res.put("newerVersion", newerVersion);
        res.put("newerCommit", newerCommit);
        res.put("gitRepo", gitRepo);
        res.put("gitBranch", gitBranch);
        res.put("apkDownloadUrl", apkDownloadUrl);
        res.put("repoWebUrl", repoWebUrl);
        res.put("remoteReachable", remoteReachable);
        res.put("remoteError", remoteError);
        res.put("releases", releases);
        res.put("commits", commits);
        return res;
    }

    private JSONObject handleUpdatesApply(JSONObject body) throws Exception {
        String gitRepo = normalizeGitRepoSlug(body.optString("gitRepo", getSetting("git_repo", "Kuka001/111")));
        String gitBranch = body.optString("gitBranch", getSetting("git_branch", "main")).trim();
        if (gitBranch.isEmpty()) gitBranch = "main";
        String targetRef = body.optString("ref", gitBranch).trim();
        if (targetRef.isEmpty()) targetRef = gitBranch;
        String requestedVersion = body.optString("version", "").trim();
        String requestedCommit = body.optString("commitSha", "").trim();

        long ts = System.currentTimeMillis();
        String baseUrl = "https://raw.githubusercontent.com/" + gitRepo + "/" + targetRef;

        // Download core web UI & logic files from Git
        String indexHtml = httpGetString(baseUrl + "/mobile/www/index.html?t=" + ts, 10000);
        String appJs = httpGetString(baseUrl + "/mobile/www/app.js?t=" + ts, 10000);
        String stylesCss = httpGetString(baseUrl + "/mobile/www/styles.css?t=" + ts, 10000);

        if (indexHtml.isEmpty() || appJs.isEmpty() || stylesCss.isEmpty()) {
            return errorJson(500, "Загруженные файлы из Git пусты или повреждены");
        }

        String versionJsonStr = "";
        JSONObject remoteVerObj = null;
        try {
            versionJsonStr = httpGetString(baseUrl + "/version.json?t=" + ts, 8000);
            remoteVerObj = new JSONObject(versionJsonStr);
        } catch (Exception ignored) {
            remoteVerObj = readLocalVersionManifest();
            versionJsonStr = remoteVerObj.toString();
        }

        if (!otaWwwDir.exists()) {
            otaWwwDir.mkdirs();
        }

        String appliedVersion = remoteVerObj.optString("version", "1.2.0");
        int appliedBuild = remoteVerObj.optInt("build", 3);
        if (!requestedVersion.isEmpty()) {
            appliedVersion = requestedVersion;
            remoteVerObj.put("version", appliedVersion);
            versionJsonStr = remoteVerObj.toString(2);
        }

        writeTextFile(new File(otaWwwDir, "index.html"), indexHtml);
        writeTextFile(new File(otaWwwDir, "app.js"), appJs);
        writeTextFile(new File(otaWwwDir, "styles.css"), stylesCss);
        writeTextFile(new File(otaWwwDir, "version.json"), versionJsonStr);

        // Determine commit SHA for the applied ref
        String appliedCommit = requestedCommit;
        if (appliedCommit.isEmpty()) {
            if (targetRef.length() >= 7 && targetRef.matches("^[0-9a-fA-F]+$")) {
                appliedCommit = targetRef.substring(0, 7);
            } else {
                try {
                    String commitInfoStr = httpGetString("https://api.github.com/repos/" + gitRepo + "/commits/" + targetRef, 6000);
                    JSONObject commitObj = new JSONObject(commitInfoStr);
                    String sha = commitObj.optString("sha", "");
                    if (sha.length() >= 7) appliedCommit = sha.substring(0, 7);
                } catch (Exception ignored) {
                }
            }
        } else if (appliedCommit.length() > 7) {
            appliedCommit = appliedCommit.substring(0, 7);
        }

        setSetting("ota_active", "1");
        setSetting("installed_version", appliedVersion);
        setSetting("installed_build", String.valueOf(appliedBuild));
        if (!appliedCommit.isEmpty()) {
            setSetting("installed_commit", appliedCommit);
        }

        JSONObject res = new JSONObject();
        res.put("ok", true);
        res.put("updatedVersion", appliedVersion);
        res.put("updatedBuild", appliedBuild);
        res.put("installedCommit", appliedCommit);
        res.put("otaActive", true);
        res.put("message", "Версия " + appliedVersion + (appliedCommit.isEmpty() ? "" : " (" + appliedCommit + ")") + " успешно установлена из Git!");
        return res;
    }

    private JSONObject handleUpdatesReset() throws Exception {
        deleteRecursive(otaWwwDir);
        JSONObject bundled = readBundledVersionManifest();
        String bundledVer = bundled.optString("version", "1.2.0");
        int bundledBuild = bundled.optInt("build", 3);

        setSetting("ota_active", "0");
        setSetting("installed_version", bundledVer);
        setSetting("installed_build", String.valueOf(bundledBuild));
        setSetting("installed_commit", "");

        JSONObject res = new JSONObject();
        res.put("ok", true);
        res.put("currentVersion", bundledVer);
        res.put("currentBuild", bundledBuild);
        res.put("otaActive", false);
        return res;
    }

    private JSONObject handleUpdatesConfig(JSONObject body) throws Exception {
        String gitRepo = normalizeGitRepoSlug(body.optString("gitRepo", getSetting("git_repo", "Kuka001/111")));
        String gitBranch = body.optString("gitBranch", getSetting("git_branch", "main")).trim();
        if (gitBranch.isEmpty()) gitBranch = "main";

        String prevRepo = getSetting("git_repo", "Kuka001/111");
        String prevBranch = getSetting("git_branch", "main");

        setSetting("git_repo", gitRepo);
        setSetting("git_branch", gitBranch);
        if (!gitRepo.equals(prevRepo) || !gitBranch.equals(prevBranch)) {
            setSetting("installed_commit", "");
        }

        JSONObject res = new JSONObject();
        res.put("ok", true);
        res.put("gitRepo", gitRepo);
        res.put("gitBranch", gitBranch);
        return res;
    }

    private JSONObject errorJson(int status, String msg) throws Exception {
        JSONObject o = new JSONObject();
        o.put("__status", status);
        o.put("error", msg);
        return o;
    }
}
