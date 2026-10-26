package com.agy.roleplay;

import android.content.Context;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/**
 * On-device runtime for the Claude Code CLI.
 *
 * Claude Code ships as a single ~283 MB native binary built with Bun for
 * aarch64/musl (interpreter /lib/ld-musl-aarch64.so.1). Android's bionic loader
 * cannot run it, and Android >= API 29 forbids executing any file from
 * app-writable storage at all. This app therefore targets API 28 (legacy
 * untrusted_app_27 SELinux domain, which permits exec of app data files) and
 * starts the binary straight on Android through Alpine's musl loader, with
 * libraries from a minimal Alpine rootfs. There is no proot: under ptrace,
 * Bun's very first thread creation livelocks on some kernels (4.14: clone()
 * returns ERESTARTNOINTR forever), and every system call would pay a ptrace
 * round trip.
 *
 * Every component is downloaded once (user-triggered) straight from its
 * official upstream — Alpine Linux CDN and the npm registry — and verified
 * against a SHA-256 pinned below. The pins live in this signed APK rather than
 * in version.json because version.json fields are not covered by the OTA
 * signature, and these files are executable code. Nothing is re-hosted.
 *
 * Installed layout under filesDir/claude_runtime:
 *
 *   rootfs/            Alpine minirootfs + libgcc/libstdc++ (loader, libraries)
 *   claude             Claude Code CLI (npm @anthropic-ai/claude-code-linux-arm64-musl)
 *   ld-musl-agy.so.1   musl loader copy that reads .agy-resolv.conf (see ensureDirectLoader)
 *   home/              HOME and working directory: credentials, generated prompts
 *   tmp/               TMPDIR
 *   bin/agy-open       BROWSER shim that hands sign-in links to the app
 *   .compat            "safe" when Claude Code only starts with Bun's safe flags
 *
 * This class owns only the environment: download/verify/extract, readiness and
 * auth checks, and building a configured (unstarted) ProcessBuilder. The
 * generation/auth streaming lives in LocalBackendServer so it can update the
 * existing GenerationProgress telemetry.
 */
final class ClaudeRuntime {

    interface ProgressSink {
        void onProgress(String message);
    }

    /** One downloadable component of the runtime. */
    private static final class Part {
        final String label;
        final String url;
        final String sha256;
        final long approxBytes;
        final Kind kind;
        final String member; // file to take from the archive (CLAUDE part)

        Part(String label, String url, String sha256, long approxBytes, Kind kind, String member) {
            this.label = label;
            this.url = url;
            this.sha256 = sha256;
            this.approxBytes = approxBytes;
            this.kind = kind;
            this.member = member;
        }
    }

    private enum Kind { ROOTFS, CLAUDE }

    /** Bump whenever any pinned part changes: a different marker forces a reinstall. */
    static final String RUNTIME_VERSION = "claude-2.1.310+alpine-3.24.3";
    /** Marker of the same runtime installed by 1.6.x, which also downloaded proot. */
    private static final String LEGACY_RUNTIME_VERSION = RUNTIME_VERSION + "+proot-5.4.0-r2";

    private static final String ALPINE = "https://dl-cdn.alpinelinux.org/alpine/v3.24";

    private static final Part[] PARTS = new Part[]{
        new Part("Alpine Linux",
            ALPINE + "/releases/aarch64/alpine-minirootfs-3.24.3-aarch64.tar.gz",
            "4d3f80afaebd447c5591a63a73bde380a149fe8b2d85488cafabb2ff97551f50",
            4029999L, Kind.ROOTFS, null),
        new Part("libgcc",
            ALPINE + "/main/aarch64/libgcc-15.2.0-r5.apk",
            "369aaa6e9d099a737bad6dd3e6c2fe7bb1547ca26d22b94ee0411228f709b403",
            66323L, Kind.ROOTFS, null),
        new Part("libstdc++",
            ALPINE + "/main/aarch64/libstdc%2B%2B-15.2.0-r5.apk",
            "2302e766d4e4926038ec166ecb85837ee884576115236ddb565e3a5fca4a11d7",
            908984L, Kind.ROOTFS, null),
        new Part("Claude Code 2.1.310",
            "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64-musl/-/claude-code-linux-arm64-musl-2.1.310.tgz",
            "2fa33a03490fcb23faefdb136b4a7f12692371441e6c5a70546d275c679813b9",
            129840368L, Kind.CLAUDE, "package/claude"),
    };

    /** Download + extracted size with headroom; checked before starting. */
    private static final long REQUIRED_FREE_BYTES = 700L * 1024L * 1024L;

    /** SHA-256 of lib/ld-musl-aarch64.so.1 from the pinned Alpine minirootfs. */
    static final String MUSL_LOADER_SHA256 = "53282acc2be8a08a9fdcf880334bf35bbfd0a13862b7f3616be3919fcda11793";
    /**
     * musl reads its DNS servers only from the hard-coded "/etc/resolv.conf",
     * which Android does not have. The loader copy reads this name instead: the
     * same length, relative to the working directory (HOME), which gets the
     * phone's DNS servers before every launch.
     */
    static final String DIRECT_RESOLV_NAME = ".agy-resolv.conf";

    private final Context context;
    private final File runtimeDir;
    private final File rootfsDir;
    private final File claudeBin;
    private final File homeDir;
    private final File tmpDir;
    private final File readyMarker;
    private final File compatFile;
    private final File freshHomeDir;
    private final File directLoader;
    private final File binDir;

    ClaudeRuntime(Context context) {
        this.context = context;
        this.runtimeDir = new File(context.getFilesDir(), "claude_runtime");
        this.rootfsDir = new File(runtimeDir, "rootfs");
        this.claudeBin = new File(runtimeDir, "claude");
        this.homeDir = new File(runtimeDir, "home");
        this.tmpDir = new File(runtimeDir, "tmp");
        this.readyMarker = new File(runtimeDir, ".ready");
        this.compatFile = new File(runtimeDir, ".compat");
        this.freshHomeDir = new File(runtimeDir, "home-check");
        this.directLoader = new File(runtimeDir, "ld-musl-agy.so.1");
        this.binDir = new File(runtimeDir, "bin");
    }

    File getRuntimeDir() {
        return runtimeDir;
    }

    static String version() {
        return RUNTIME_VERSION;
    }

    /** Total download size of all parts, for the UI. */
    static long downloadBytes() {
        long total = 0;
        for (Part p : PARTS) total += p.approxBytes;
        return total;
    }

    /** True once the pinned runtime has been fully extracted and chmod'd. */
    boolean isReady() {
        if (!claudeBin.isFile() || !new File(rootfsDir, "lib/ld-musl-aarch64.so.1").isFile()) return false;
        String have = readMarker(readyMarker);
        return RUNTIME_VERSION.equals(have) || LEGACY_RUNTIME_VERSION.equals(have);
    }

    /**
     * Removes what builds before 1.7.0 left in the runtime folder: the proot
     * engines and their scratch files, the engine choice, and leftovers of
     * on-device debugging. Idempotent and cheap; the runtime itself is kept.
     */
    synchronized void cleanupLegacy() {
        for (String name : new String[]{"proot", "android", "procfake", ".launch", ".engine",
                "home-check", "home-direct", "dev-run.sh", "resolv.conf"}) {
            deleteRecursive(new File(runtimeDir, name));
        }
        File[] scratch = tmpDir.listFiles();
        if (scratch != null) {
            for (File f : scratch) {
                String n = f.getName();
                if (n.startsWith("proot-") || n.endsWith(".log")) deleteRecursive(f);
            }
        }
        deleteRecursive(new File(rootfsDir, "usr/local/bin/agy-open"));
        if (LEGACY_RUNTIME_VERSION.equals(readMarker(readyMarker))) {
            try {
                writeText(readyMarker, RUNTIME_VERSION);
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * True once `claude auth login` has stored subscription credentials: an
     * OAuth token in ~/.claude/.credentials.json. (~/.claude.json is Claude
     * Code's settings file, written on every start; it says nothing about it.)
     */
    boolean isAuthenticated() {
        File creds = credentialsFile();
        if (!creds.isFile() || creds.length() < 10) return false;
        try {
            String text = new String(readAll(new FileInputStream(creds)), StandardCharsets.UTF_8);
            return text.contains("\"accessToken\"") || text.contains("\"refreshToken\"");
        } catch (Exception e) {
            return false;
        }
    }

    /** Changes whenever Claude Code writes new credentials (0 = none). */
    long credentialsStamp() {
        File creds = credentialsFile();
        return creds.isFile() ? creds.lastModified() : 0L;
    }

    private File credentialsFile() {
        return new File(homeDir, ".claude/.credentials.json");
    }

    void logout() {
        deleteRecursive(new File(homeDir, ".claude"));
        deleteRecursive(new File(homeDir, ".claude.json"));
    }

    /** File the BROWSER shim appends URLs to. */
    File browserUrlFile() {
        return new File(tmpDir, "agy-open-url");
    }

    /** A file in TMPDIR, e.g. a debug log. */
    File tmpFile(String name) {
        return new File(tmpDir, name);
    }

    /**
     * Installs the BROWSER shim. Claude Code opens its sign-in link by running
     * $BROWSER <url>; there is no browser it could reach, so the shim records
     * the URL for the app, which shows it and opens it in Android's browser.
     */
    void ensureBrowserShim() throws Exception {
        tmpDir.mkdirs();
        binDir.mkdirs();
        File shim = new File(binDir, "agy-open");
        writeText(shim, "#!/system/bin/sh\n"
            + "# Hands URLs that Claude Code wants to open to the Android app.\n"
            + "printf '%s\\n' \"$1\" >> '" + browserUrlFile().getAbsolutePath() + "'\n"
            + "exit 0\n");
        shim.setExecutable(true, false);
    }

    /** $BROWSER for Claude Code: the shim installed by {@link #ensureBrowserShim}. */
    String browserShimPath() {
        return new File(binDir, "agy-open").getAbsolutePath();
    }

    /** Writes a file into HOME and returns its absolute path, e.g. for --system-prompt-file. */
    String writeHomeFile(String relName, String content) throws Exception {
        File f = new File(homeDir, relName);
        File parent = f.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        writeText(f, content != null ? content : "");
        return f.getAbsolutePath();
    }

    void deleteHomeFile(String relName) {
        new File(homeDir, relName).delete();
    }

    /** Files of a HOME folder (null when it does not exist). */
    File[] homeFiles(String relDir) {
        return new File(homeDir, relDir).listFiles();
    }

    /**
     * Downloads, verifies and extracts every pinned part. Safe to call when
     * already ready (returns immediately). Throws with a readable message on any
     * failure; a failed attempt leaves no ready marker. Signed-in credentials in
     * home/ survive a reinstall.
     */
    synchronized void ensureReady(ProgressSink sink, boolean force) throws Exception {
        if (!force && isReady()) return;

        runtimeDir.mkdirs();
        long free = runtimeDir.getUsableSpace();
        if (free > 0 && free < REQUIRED_FREE_BYTES) {
            throw new Exception("Недостаточно места: нужно около " + (REQUIRED_FREE_BYTES >> 20)
                + " МБ, свободно " + (free >> 20) + " МБ.");
        }

        // A stale/incompatible install must go before a fresh extract. HOME is
        // kept so an existing Claude sign-in survives the upgrade.
        readyMarker.delete();
        claudeBin.delete();
        directLoader.delete();
        new File(runtimeDir, ".ld-musl-agy").delete();
        scriptsInstalled = false;
        cleanupLegacy();
        deleteRecursive(rootfsDir);
        deleteRecursive(tmpDir);
        File[] leftovers = runtimeDir.listFiles();
        if (leftovers != null) {
            for (File f : leftovers) {
                if (f.getName().startsWith("stage-") || f.getName().endsWith(".part")) deleteRecursive(f);
            }
        }
        rootfsDir.mkdirs();
        homeDir.mkdirs();
        tmpDir.mkdirs();

        long total = downloadBytes();
        long doneBefore = 0;
        for (int i = 0; i < PARTS.length; i++) {
            Part part = PARTS[i];
            File archive = new File(runtimeDir, "download-" + i + ".part");
            downloadVerified(part, archive, sink, doneBefore, total);
            doneBefore += part.approxBytes;

            if (sink != null) sink.onProgress("Распаковка: " + part.label + "…");
            if (part.kind == Kind.ROOTFS) {
                extractTarGz(archive, rootfsDir, true);
            } else {
                File stage = new File(runtimeDir, "stage-" + i);
                deleteRecursive(stage);
                stage.mkdirs();
                extractTarGz(archive, stage, true);
                File picked = new File(stage, part.member);
                if (!picked.isFile() || !picked.renameTo(claudeBin)) {
                    deleteRecursive(stage);
                    archive.delete();
                    throw new Exception("В пакете «" + part.label + "» нет файла " + part.member + ".");
                }
                deleteRecursive(stage);
            }
            archive.delete();
        }

        if (!claudeBin.exists() || !new File(rootfsDir, "lib/ld-musl-aarch64.so.1").exists()) {
            throw new Exception("Среда распакована неполно: нет claude или загрузчика musl.");
        }

        // Executables in app storage need the exec bit explicitly on some ROMs.
        claudeBin.setExecutable(true, false);
        makeTreeExecutable(rootfsDir);

        writeText(readyMarker, RUNTIME_VERSION);
        if (sink != null) sink.onProgress("Среда Claude готова.");
    }

    /** DNS servers of the phone's active network (Android has no /etc/resolv.conf). */
    private volatile List<String> dnsServers = Collections.emptyList();

    void setDnsServers(List<String> servers) {
        dnsServers = servers != null ? new ArrayList<>(servers) : Collections.<String>emptyList();
    }

    /**
     * The network's own resolvers first (mobile carriers often block public
     * DNS), then a public fallback; musl uses at most three.
     */
    private List<String> pickDnsServers() {
        List<String> picked = new ArrayList<>();
        for (String s : dnsServers) {
            if (s == null) continue;
            String v = s.trim();
            if (v.isEmpty() || v.contains("%") || picked.contains(v)) continue;
            picked.add(v);
            if (picked.size() == 2) break;
        }
        for (String fallback : new String[]{"1.1.1.1", "8.8.8.8"}) {
            if (picked.size() >= 3) break;
            if (!picked.contains(fallback)) picked.add(fallback);
        }
        return picked;
    }

    /** resolv.conf for musl, written next to every launch as {@link #DIRECT_RESOLV_NAME}. */
    String resolvConf() {
        StringBuilder sb = new StringBuilder();
        for (String s : pickDnsServers()) sb.append("nameserver ").append(s).append("\n");
        sb.append("options timeout:3 attempts:2\n");
        return sb.toString();
    }

    /**
     * The loader for the launch: a copy of Alpine's musl loader (which is also
     * its libc) that reads {@link #DIRECT_RESOLV_NAME} instead of
     * /etc/resolv.conf. Built from the verified rootfs file, one same-length
     * string replaced; the rootfs itself stays untouched.
     */
    synchronized File ensureDirectLoader() throws Exception {
        File marker = new File(runtimeDir, ".ld-musl-agy");
        if (directLoader.isFile() && marker.isFile()) return directLoader;
        File src = new File(rootfsDir, "lib/ld-musl-aarch64.so.1");
        byte[] data = readAll(new FileInputStream(src));
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        if (!MUSL_LOADER_SHA256.equals(toHex(md.digest(data)))) {
            throw new Exception("Неожиданная версия загрузчика musl в среде — переустановите среду.");
        }
        byte[] needle = "/etc/resolv.conf".getBytes(StandardCharsets.US_ASCII);
        byte[] repl = DIRECT_RESOLV_NAME.getBytes(StandardCharsets.US_ASCII);
        int at = -1;
        for (int i = 0; i + needle.length <= data.length; i++) {
            boolean match = true;
            for (int j = 0; j < needle.length && match; j++) match = data[i + j] == needle[j];
            if (!match) continue;
            if (at >= 0) throw new Exception("Загрузчик musl: путь resolv.conf встречается дважды.");
            at = i;
        }
        if (at < 0 || repl.length != needle.length) throw new Exception("Загрузчик musl: путь resolv.conf не найден.");
        System.arraycopy(repl, 0, data, at, repl.length);
        File part = new File(runtimeDir, "ld-musl-agy.so.1.part");
        FileOutputStream out = new FileOutputStream(part);
        try {
            out.write(data);
        } finally {
            out.close();
        }
        if (!part.renameTo(directLoader)) throw new Exception("Не удалось сохранить загрузчик musl.");
        directLoader.setExecutable(true, false);
        writeText(marker, MUSL_LOADER_SHA256);
        return directLoader;
    }

    // -------------------------------------------------------------------------
    // Bun compatibility mode and preload scripts
    // -------------------------------------------------------------------------

    /**
     * Switches of Bun (the runtime inside the Claude Code binary) that turn off
     * newer-kernel fast paths: epoll_pwait2, pidfd child waits, the spawnSync
     * fast path, RWF_NOWAIT reads, memfd and madvise tricks. Older phone kernels
     * can stall on them; the fallbacks are slower but plain. Turned on when the
     * self-test finds Claude Code only starts so.
     */
    static final String[][] BUN_SAFE_FLAGS = new String[][]{
        {"BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2", "1"},
        {"BUN_FEATURE_FLAG_FORCE_WAITER_THREAD", "1"},
        {"BUN_FEATURE_FLAG_DISABLE_SPAWNSYNC_FAST_PATH", "1"},
        {"BUN_FEATURE_FLAG_DISABLE_RWF_NONBLOCK", "1"},
        {"BUN_FEATURE_FLAG_DISABLE_MEMFD", "1"},
        {"BUN_FEATURE_FLAG_DISABLE_STANDALONE_MADVISE", "1"},
    };

    /**
     * Scripts from APK assets that Bun preloads (BUN_OPTIONS=--preload), kept in
     * the rootfs under /opt/agy: the Android shim every launch needs, and the
     * self-test's probe and start-up trace.
     */
    static final String PRELOAD_ANDROID = "android.cjs";
    static final String PRELOAD_PROBE = "probe.mjs";
    static final String PRELOAD_TRACE = "trace.cjs";
    private static final String SCRIPTS_ASSET_DIR = "claude-diag";
    private volatile boolean scriptsInstalled = false;

    /** How one launch is set up; the defaults are what sign-in and replies use. */
    static final class RunOptions {
        /** Bun safe flags (see {@link #BUN_SAFE_FLAGS}). */
        boolean safe;
        /** Used as HOME instead of home/, e.g. an empty profile for a check. */
        File home;
        /** Extra preload scripts (PRELOAD_PROBE, PRELOAD_TRACE). */
        final List<String> preloads = new ArrayList<>();
        final Map<String, String> env = new java.util.LinkedHashMap<>();
    }

    /** Options matching the saved compatibility mode. */
    RunOptions defaultOptions() {
        RunOptions o = new RunOptions();
        o.safe = isSafeMode();
        return o;
    }

    boolean isSafeMode() {
        return "safe".equals(readMarker(compatFile));
    }

    void setSafeMode(boolean on) {
        if (!on) {
            compatFile.delete();
            return;
        }
        try {
            writeText(compatFile, "safe");
        } catch (Exception ignored) {
        }
    }

    /** Copies the preload scripts into the rootfs (/opt/agy), once per app start. */
    private void installScripts() throws Exception {
        if (scriptsInstalled) return;
        File dir = new File(rootfsDir, "opt/agy");
        dir.mkdirs();
        for (String name : new String[]{PRELOAD_ANDROID, PRELOAD_PROBE, PRELOAD_TRACE}) {
            copyAsset(SCRIPTS_ASSET_DIR + "/" + name, new File(dir, name));
        }
        scriptsInstalled = true;
    }

    private void copyAsset(String assetPath, File dest) throws Exception {
        InputStream in = context.getAssets().open(assetPath);
        FileOutputStream out = new FileOutputStream(dest);
        try {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        } finally {
            try { out.close(); } catch (Exception ignored) {}
            try { in.close(); } catch (Exception ignored) {}
        }
    }

    /** An empty HOME for a check run, recreated on every call. */
    File freshHome() {
        deleteRecursive(freshHomeDir);
        freshHomeDir.mkdirs();
        return freshHomeDir;
    }

    void discardFreshHome() {
        deleteRecursive(freshHomeDir);
    }

    /**
     * Starts Claude Code's profile over: the old HOME is kept aside as
     * home.stale (replacing an older one), sign-in credentials are carried over.
     */
    void resetHome() throws Exception {
        File stale = new File(runtimeDir, "home.stale");
        deleteRecursive(stale);
        File creds = credentialsFile();
        byte[] keep = creds.isFile() ? readAll(new FileInputStream(creds)) : null;
        if (homeDir.exists() && !homeDir.renameTo(stale)) deleteRecursive(homeDir);
        homeDir.mkdirs();
        if (keep != null) {
            File dest = credentialsFile();
            dest.getParentFile().mkdirs();
            FileOutputStream out = new FileOutputStream(dest);
            try {
                out.write(keep);
            } finally {
                out.close();
            }
        }
        deleteRecursive(freshHomeDir);
    }

    // -------------------------------------------------------------------------
    // Launching and stopping
    // -------------------------------------------------------------------------

    /**
     * Builds a configured (not started) ProcessBuilder for Claude Code: the
     * patched musl loader runs the binary with libraries from the rootfs. HOME
     * is the working directory; the phone's DNS servers go into its
     * {@link #DIRECT_RESOLV_NAME} (for musl) and into AGY_DNS_SERVERS (for Bun's
     * own resolver, set by the android.cjs preload).
     */
    ProcessBuilder newClaudeProcess(List<String> claudeArgs, RunOptions opts) throws Exception {
        File loader = ensureDirectLoader();
        installScripts();
        File home = opts.home != null ? opts.home : homeDir;
        home.mkdirs();
        tmpDir.mkdirs();
        writeText(new File(home, DIRECT_RESOLV_NAME), resolvConf());

        List<String> cmd = new ArrayList<>();
        cmd.add(loader.getAbsolutePath());
        cmd.add(claudeBin.getAbsolutePath());
        cmd.addAll(claudeArgs);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(home);
        pb.redirectErrorStream(false);

        Map<String, String> env = pb.environment();
        applyEnv(env, home);
        List<String> preloads = new ArrayList<>();
        preloads.add(PRELOAD_ANDROID);
        preloads.addAll(opts.preloads);
        StringBuilder bunOptions = new StringBuilder();
        for (String name : preloads) {
            if (bunOptions.length() > 0) bunOptions.append(' ');
            bunOptions.append("--preload ").append(new File(rootfsDir, "opt/agy/" + name).getAbsolutePath());
        }
        env.put("BUN_OPTIONS", bunOptions.toString());
        if (opts.safe) {
            for (String[] flag : BUN_SAFE_FLAGS) env.put(flag[0], flag[1]);
        }
        env.putAll(opts.env);
        return pb;
    }

    private void applyEnv(Map<String, String> env, File home) {
        for (String k : new String[]{"LD_PRELOAD", "BUN_OPTIONS"}) env.remove(k);
        env.put("HOME", home.getAbsolutePath());
        env.put("USER", "root");
        env.put("LOGNAME", "root");
        env.put("TERM", "dumb");
        env.put("LANG", "C.UTF-8");
        env.put("LC_ALL", "C.UTF-8");
        env.put("PATH", "/system/bin:/system/xbin");
        env.put("SHELL", "/system/bin/sh");
        env.put("TMPDIR", tmpDir.getAbsolutePath());
        env.put("LD_LIBRARY_PATH", new File(rootfsDir, "lib").getAbsolutePath() + ":" + new File(rootfsDir, "usr/lib").getAbsolutePath());
        StringBuilder dns = new StringBuilder();
        for (String s : pickDnsServers()) {
            if (dns.length() > 0) dns.append(',');
            dns.append(s);
        }
        env.put("AGY_DNS_SERVERS", dns.toString());
        // Reduce chatter on a phone. (CI=1 is set by the generation path only.)
        env.put("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
        // The binary is pinned and verified by this app; it must not replace itself.
        env.put("DISABLE_AUTOUPDATER", "1");
    }

    /** Files the self-test's probe reads and writes on Android. */
    Map<String, String> probeEnv() {
        Map<String, String> env = new java.util.LinkedHashMap<>();
        env.put("AGY_PROBE_FILE", new File(rootfsDir, "etc/os-release").getAbsolutePath());
        env.put("AGY_PROBE_TMP", tmpDir.getAbsolutePath());
        env.put("AGY_PROBE_ECHO", "/system/bin/toybox");
        return env;
    }

    /** Any host command with Claude Code's environment, in the runtime folder (test builds). */
    ProcessBuilder newHostProcess(List<String> cmd) {
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(runtimeDir);
        tmpDir.mkdirs();
        applyEnv(pb.environment(), homeDir);
        return pb;
    }

    /**
     * Really stops a run: every process of its tree gets SIGKILL, children
     * first. Process.destroy() only sends SIGTERM, which a stuck runtime can
     * ignore while it keeps a CPU core busy.
     */
    static void kill(Process p) {
        if (p == null) return;
        int pid = pidOf(p);
        if (pid > 0) killTree(pid);
        try {
            p.destroy();
        } catch (Exception ignored) {
        }
    }

    private static void killTree(int pid) {
        for (int child : ProcSnapshot.descendants(pid)) android.os.Process.sendSignal(child, 9);
        android.os.Process.sendSignal(pid, 9);
    }

    /** Kills every Claude Code launch except {@code keep} (runs still in use). */
    int killStray(java.util.Collection<Process> keep) {
        java.util.Set<Integer> keepPids = new java.util.HashSet<>();
        for (Process p : keep) {
            if (p != null) keepPids.add(pidOf(p));
        }
        int killed = 0;
        String dir;
        try {
            dir = runtimeDir.getCanonicalPath(); // /proc/PID/exe shows the resolved path
        } catch (Exception e) {
            dir = runtimeDir.getAbsolutePath();
        }
        for (int pid : ProcSnapshot.childrenRunningFrom(android.os.Process.myPid(), dir)) {
            if (keepPids.contains(pid)) continue;
            killTree(pid);
            killed++;
        }
        return killed;
    }

    /** The pid of a started process (Android's Process has no public accessor). */
    static int pidOf(Process p) {
        try {
            java.lang.reflect.Field f = p.getClass().getDeclaredField("pid");
            f.setAccessible(true);
            return f.getInt(p);
        } catch (Throwable ignored) {
        }
        // Android's process class prints "Process[pid=1234, ...]".
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("pid=(\\d+)").matcher(String.valueOf(p));
        return m.find() ? Integer.parseInt(m.group(1)) : -1;
    }

    // -------------------------------------------------------------------------
    // Download + SHA-256
    // -------------------------------------------------------------------------
    private void downloadVerified(Part part, File dest, ProgressSink sink, long doneBefore, long total) throws Exception {
        Exception last = null;
        for (int attempt = 1; attempt <= 3; attempt++) {
            try {
                String got = downloadWithSha256(part, dest, sink, doneBefore, total);
                if (!got.equalsIgnoreCase(part.sha256)) {
                    dest.delete();
                    throw new SecurityException("Контрольная сумма «" + part.label + "» не совпала (ожидалась "
                        + part.sha256 + ", получена " + got + "). Установка отклонена.");
                }
                return;
            } catch (SecurityException se) {
                throw new Exception(se.getMessage());
            } catch (Exception e) {
                last = e;
                dest.delete();
                if (sink != null) sink.onProgress("Сбой загрузки «" + part.label + "», попытка " + (attempt + 1) + " из 3…");
                try {
                    Thread.sleep(1500L * attempt);
                } catch (InterruptedException ie) {
                    throw new Exception("Установка прервана");
                }
            }
        }
        throw new Exception("Не удалось скачать «" + part.label + "»: "
            + (last != null && last.getMessage() != null ? last.getMessage() : "ошибка сети"));
    }

    private String downloadWithSha256(Part part, File dest, ProgressSink sink, long doneBefore, long total) throws Exception {
        URLConnection conn = new URL(part.url).openConnection();
        conn.setConnectTimeout(30000);
        conn.setReadTimeout(120000);
        conn.setRequestProperty("User-Agent", "AGY-Roleplay-Android/ClaudeRuntime");
        conn.setRequestProperty("Accept", "application/octet-stream, */*");
        if (conn instanceof HttpURLConnection) {
            HttpURLConnection http = (HttpURLConnection) conn;
            http.setInstanceFollowRedirects(true);
            int code = http.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new Exception("HTTP " + code);
            }
        }
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        InputStream in = new BufferedInputStream(conn.getInputStream(), 1 << 16);
        FileOutputStream out = new FileOutputStream(dest);
        try {
            byte[] buf = new byte[1 << 16];
            long done = 0;
            int lastPct = -1;
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
                md.update(buf, 0, n);
                done += n;
                if (sink != null && total > 0) {
                    long overall = Math.min(total, doneBefore + done);
                    int pct = (int) (overall * 100 / total);
                    if (pct != lastPct) {
                        lastPct = pct;
                        sink.onProgress("Скачивание: " + pct + "% (" + (overall >> 20) + " из " + (total >> 20) + " МБ)");
                    }
                }
            }
            out.flush();
        } finally {
            try { out.close(); } catch (Exception ignored) {}
            try { in.close(); } catch (Exception ignored) {}
        }
        return toHex(md.digest());
    }

    // -------------------------------------------------------------------------
    // Minimal tar.gz extractor (ustar + GNU long names + pax path, symlinks).
    // Alpine .apk packages are concatenated gzip members of tar segments, which
    // GZIPInputStream reads as one stream; their .SIGN*/.PKGINFO metadata is
    // skipped when skipDotMeta is set.
    // -------------------------------------------------------------------------
    private void extractTarGz(File archive, File outDir, boolean skipDotMeta) throws Exception {
        InputStream raw = new BufferedInputStream(new FileInputStream(archive), 1 << 16);
        InputStream in = new GZIPInputStream(raw, 1 << 16);
        try {
            byte[] header = new byte[512];
            List<File[]> failedLinks = new ArrayList<>(); // {link, resolved target}
            String longName = null;    // pending GNU 'L' long name
            String paxPath = null;     // pending pax path= override
            String rootCanon = outDir.getCanonicalPath();

            while (true) {
                if (!readFully(in, header, 0, 512)) break;
                if (isAllZero(header)) break; // end-of-archive marker

                String name = cStr(header, 0, 100);
                String prefix = cStr(header, 345, 155);
                if (!prefix.isEmpty()) name = prefix + "/" + name;
                if (longName != null) { name = longName; longName = null; }
                if (paxPath != null) { name = paxPath; paxPath = null; }

                long size = parseOctal(header, 124, 12);
                int mode = (int) parseOctal(header, 100, 8);
                char type = (char) (header[156] & 0xff);
                String linkName = cStr(header, 157, 100);

                if (type == 'L') { // GNU long name: payload is the next entry's name
                    longName = new String(readBytes(in, size), StandardCharsets.UTF_8).trim();
                    skipPadding(in, size);
                    continue;
                }
                if (type == 'K') { // GNU long link name
                    linkName = new String(readBytes(in, size), StandardCharsets.UTF_8).trim();
                    skipPadding(in, size);
                    continue;
                }
                if (type == 'x' || type == 'g') { // pax extended header
                    String rec = new String(readBytes(in, size), StandardCharsets.UTF_8);
                    String p = paxField(rec, "path");
                    if (type == 'x' && p != null) paxPath = p;
                    skipPadding(in, size);
                    continue;
                }

                String clean = name;
                while (clean.startsWith("./")) clean = clean.substring(2);
                if (skipDotMeta && (clean.startsWith(".SIGN") || clean.equals(".PKGINFO")
                        || clean.startsWith(".pre-") || clean.startsWith(".post-") || clean.startsWith(".trigger"))) {
                    skip(in, size);
                    skipPadding(in, size);
                    continue;
                }

                File outFile = new File(outDir, clean);
                String canon = outFile.getCanonicalPath();
                if (!canon.equals(rootCanon) && !canon.startsWith(rootCanon + File.separator)) {
                    // Traversal attempt: skip the payload and move on.
                    skip(in, size);
                    skipPadding(in, size);
                    continue;
                }

                if (type == '5') { // directory
                    outFile.mkdirs();
                } else if (type == '2') { // symlink
                    File parent = outFile.getParentFile();
                    if (parent != null && !parent.exists()) parent.mkdirs();
                    Path link = Paths.get(outFile.getAbsolutePath());
                    try {
                        Files.deleteIfExists(link);
                        Files.createSymbolicLink(link, Paths.get(linkName));
                    } catch (Exception symEx) {
                        // No symlink support here: copy the target once it is extracted
                        // (e.g. lib/libc.musl-aarch64.so.1 -> ld-musl-aarch64.so.1).
                        File target = linkName.startsWith("/")
                            ? new File(outDir, linkName.substring(1))
                            : new File(outFile.getParentFile(), linkName);
                        failedLinks.add(new File[]{outFile, target});
                    }
                } else if (type == '0' || type == '\0' || type == '7') { // regular file
                    File parent = outFile.getParentFile();
                    if (parent != null && !parent.exists()) parent.mkdirs();
                    try {
                        Files.deleteIfExists(Paths.get(outFile.getAbsolutePath()));
                    } catch (Exception ignored) {
                    }
                    FileOutputStream fos = new FileOutputStream(outFile);
                    try {
                        copyExactly(in, fos, size);
                    } finally {
                        fos.close();
                    }
                    if ((mode & 0111) != 0) outFile.setExecutable(true, false);
                } else {
                    // hardlink ('1') and anything else: skip payload.
                    skip(in, size);
                }
                skipPadding(in, size);
            }
            for (File[] fl : failedLinks) {
                try {
                    String canon = fl[1].getCanonicalPath();
                    if (fl[1].isFile() && canon.startsWith(rootCanon + File.separator)) {
                        Files.copy(fl[1].toPath(), fl[0].toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                        if (fl[1].canExecute()) fl[0].setExecutable(true, false);
                    }
                } catch (Exception ignored) {
                }
            }
        } finally {
            try { in.close(); } catch (Exception ignored) {}
        }
    }

    private static String paxField(String record, String key) {
        // pax records: "<len> <key>=<value>\n"
        int idx = 0;
        while (idx < record.length()) {
            int sp = record.indexOf(' ', idx);
            if (sp < 0) break;
            int len;
            try {
                len = Integer.parseInt(record.substring(idx, sp).trim());
            } catch (Exception e) {
                break;
            }
            if (len <= 0 || idx + len > record.length()) break;
            String kv = record.substring(sp + 1, idx + len - 1); // drop trailing \n
            int eq = kv.indexOf('=');
            if (eq > 0 && kv.substring(0, eq).equals(key)) {
                return kv.substring(eq + 1);
            }
            idx += len;
        }
        return null;
    }

    private void makeTreeExecutable(File dir) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File f : kids) {
            if (f.isDirectory()) {
                makeTreeExecutable(f);
            } else {
                // Cheap and safe: the rootfs is all verified upstream binaries/libs.
                f.setExecutable(true, false);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Low-level helpers
    // -------------------------------------------------------------------------
    private static boolean readFully(InputStream in, byte[] buf, int off, int len) throws Exception {
        int got = 0;
        while (got < len) {
            int n = in.read(buf, off + got, len - got);
            if (n < 0) return false;
            got += n;
        }
        return true;
    }

    private static byte[] readBytes(InputStream in, long size) throws Exception {
        byte[] b = new byte[(int) size];
        readFully(in, b, 0, b.length);
        return b;
    }

    private static void copyExactly(InputStream in, OutputStream out, long size) throws Exception {
        byte[] buf = new byte[1 << 16];
        long remaining = size;
        while (remaining > 0) {
            int want = (int) Math.min(buf.length, remaining);
            int n = in.read(buf, 0, want);
            if (n < 0) throw new Exception("Усечённый tar-поток");
            out.write(buf, 0, n);
            remaining -= n;
        }
    }

    private static void skip(InputStream in, long size) throws Exception {
        long remaining = size;
        byte[] buf = new byte[1 << 16];
        while (remaining > 0) {
            int want = (int) Math.min(buf.length, remaining);
            int n = in.read(buf, 0, want);
            if (n < 0) break;
            remaining -= n;
        }
    }

    private static void skipPadding(InputStream in, long size) throws Exception {
        int pad = (int) (512 - (size % 512)) % 512;
        if (pad > 0) {
            byte[] b = new byte[pad];
            readFully(in, b, 0, pad);
        }
    }

    private static boolean isAllZero(byte[] b) {
        for (byte x : b) if (x != 0) return false;
        return true;
    }

    private static String cStr(byte[] b, int off, int len) {
        int end = off;
        int max = off + len;
        while (end < max && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.UTF_8);
    }

    private static long parseOctal(byte[] b, int off, int len) {
        long val = 0;
        int i = off;
        int max = off + len;
        while (i < max && (b[i] == ' ' || b[i] == 0)) i++;
        while (i < max && b[i] >= '0' && b[i] <= '7') {
            val = (val << 3) + (b[i] - '0');
            i++;
        }
        return val;
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte x : bytes) sb.append(String.format(Locale.US, "%02x", x & 0xff));
        return sb.toString();
    }

    private static String readMarker(File f) {
        if (!f.isFile()) return "";
        try {
            return new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8).trim();
        } catch (Exception e) {
            return "";
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally {
            in.close();
        }
    }

    private static void writeText(File f, String text) throws Exception {
        FileOutputStream fos = new FileOutputStream(f);
        try {
            fos.write(text.getBytes(StandardCharsets.UTF_8));
        } finally {
            fos.close();
        }
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists() && !Files.isSymbolicLink(f.toPath())) return;
        if (f.isDirectory() && !Files.isSymbolicLink(f.toPath())) {
            File[] kids = f.listFiles();
            if (kids != null) for (File c : kids) deleteRecursive(c);
        }
        f.delete();
    }
}
