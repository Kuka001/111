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
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.zip.GZIPInputStream;

/**
 * On-device runtime for the Claude Code CLI.
 *
 * Claude Code ships as a single ~283 MB native binary built with Bun for
 * aarch64/musl (interpreter /lib/ld-musl-aarch64.so.1). It cannot run directly
 * on Android's bionic loader, and Android >= API 29 forbids executing any file
 * from app-writable storage at all. This app therefore targets API 28 (legacy
 * untrusted_app_27 SELinux domain, which permits exec of app data files) and
 * runs the binary through an unprivileged {@code proot} over a minimal musl
 * rootfs, exactly like Termux/UserLAnd.
 *
 * The runtime bundle is downloaded once (user-triggered) from a trusted GitHub
 * Release asset, verified against a SHA-256 pinned in version.json, and
 * extracted into app-private storage. Expected bundle layout (tar.gz):
 *
 *   proot                 aarch64 proot binary
 *   rootfs/               minimal musl rootfs (lib/ld-musl-aarch64.so.1, busybox)
 *   claude                Claude Code CLI (linux-arm64-musl)
 *
 * This class owns only the environment: download/verify/extract, readiness and
 * auth checks, and building a configured (unstarted) proot ProcessBuilder. The
 * generation/auth streaming lives in LocalBackendServer so it can update the
 * existing GenerationProgress telemetry.
 */
final class ClaudeRuntime {

    interface ProgressSink {
        void onProgress(String message);
    }

    private final File runtimeDir;
    private final File prootBin;
    private final File rootfsDir;
    private final File claudeBin;
    private final File homeDir;
    private final File tmpDir;
    private final File readyMarker;
    private final File workspaceDir;

    ClaudeRuntime(Context context, File workspaceDir) {
        File files = context.getFilesDir();
        this.runtimeDir = new File(files, "claude_runtime");
        this.prootBin = new File(runtimeDir, "proot");
        this.rootfsDir = new File(runtimeDir, "rootfs");
        this.claudeBin = new File(runtimeDir, "claude");
        this.homeDir = new File(runtimeDir, "home");
        this.tmpDir = new File(runtimeDir, "tmp");
        this.readyMarker = new File(runtimeDir, ".ready");
        this.workspaceDir = workspaceDir;
    }

    File getHomeDir() {
        return homeDir;
    }

    // Guest-visible paths inside the proot sandbox.
    static final String GUEST_WORKSPACE = "/workspace";
    static final String GUEST_HOME = "/root";
    static final String GUEST_CLAUDE = "/opt/claude";

    /** True once a bundle of the given version has been fully extracted and chmod'd. */
    boolean isReady(String requiredVersion) {
        if (!prootBin.exists() || !claudeBin.exists() || !rootfsDir.isDirectory()) return false;
        if (!readyMarker.exists()) return false;
        if (requiredVersion == null || requiredVersion.isEmpty()) return true;
        try {
            String have = new String(readAll(new FileInputStream(readyMarker)), StandardCharsets.UTF_8).trim();
            return requiredVersion.equals(have);
        } catch (Exception e) {
            return false;
        }
    }

    /** True once {@code claude setup-token} has stored subscription credentials under HOME. */
    boolean isAuthenticated() {
        File creds = new File(homeDir, ".claude/.credentials.json");
        File legacy = new File(homeDir, ".claude.json");
        return (creds.isFile() && creds.length() > 2) || (legacy.isFile() && legacy.length() > 2);
    }

    void logout() {
        deleteRecursive(new File(homeDir, ".claude"));
        deleteRecursive(new File(homeDir, ".claude.json"));
    }

    /**
     * Downloads, verifies and extracts the runtime bundle. Safe to call when
     * already ready (returns immediately). Throws with a readable message on
     * any failure; a failed attempt leaves no partial ready marker.
     */
    synchronized void ensureReady(String url, String sha256Hex, String version, ProgressSink sink) throws Exception {
        if (isReady(version)) return;
        if (url == null || url.trim().isEmpty()) {
            throw new Exception("URL среды Claude не задан в version.json (claudeRuntimeUrl).");
        }

        // A stale/incompatible install must go before a fresh extract.
        deleteRecursive(runtimeDir);
        runtimeDir.mkdirs();
        homeDir.mkdirs();
        tmpDir.mkdirs();

        File archive = new File(runtimeDir, "bundle.tar.gz");
        if (sink != null) sink.onProgress("Скачивание среды Claude...");
        String gotSha = downloadWithSha256(url.trim(), archive, sink);

        if (sha256Hex != null && !sha256Hex.trim().isEmpty()) {
            if (!gotSha.equalsIgnoreCase(sha256Hex.trim())) {
                archive.delete();
                throw new Exception("SHA-256 среды не совпал (ожидался " + sha256Hex.trim()
                    + ", получен " + gotSha + "). Установка отклонена.");
            }
        }

        if (sink != null) sink.onProgress("Распаковка среды...");
        extractTarGz(archive, runtimeDir);
        archive.delete();

        normalizeLayout();

        if (!prootBin.exists() || !claudeBin.exists() || !rootfsDir.isDirectory()) {
            throw new Exception("Среда распакована неполно: отсутствует proot, claude или rootfs.");
        }

        // Executables in app storage need the exec bit explicitly on some ROMs.
        prootBin.setExecutable(true, false);
        claudeBin.setExecutable(true, false);
        makeTreeExecutable(rootfsDir);

        writeText(readyMarker, version != null ? version : "");
        if (sink != null) sink.onProgress("Среда Claude готова.");
    }

    /**
     * If the bundle placed proot/claude under a nested top-level folder (a common
     * tarball habit), lift them to the expected locations.
     */
    private void normalizeLayout() {
        if (prootBin.exists() && claudeBin.exists() && rootfsDir.isDirectory()) return;
        File[] children = runtimeDir.listFiles();
        if (children == null) return;
        for (File c : children) {
            if (!c.isDirectory()) continue;
            File np = new File(c, "proot");
            File ncl = new File(c, "claude");
            File nrf = new File(c, "rootfs");
            if (np.exists() && ncl.exists() && nrf.isDirectory()) {
                np.renameTo(prootBin);
                ncl.renameTo(claudeBin);
                nrf.renameTo(rootfsDir);
                return;
            }
        }
    }

    /**
     * Builds a configured (not started) ProcessBuilder that runs the Claude CLI
     * under proot. {@code guestCwd} is a path inside the sandbox (e.g.
     * {@code /workspace/myproj}); pass null for the workspace root.
     */
    ProcessBuilder newClaudeProcess(List<String> claudeArgs, String guestCwd) {
        List<String> cmd = new ArrayList<>();
        cmd.add(prootBin.getAbsolutePath());
        cmd.add("--kill-on-exit");
        cmd.add("-r");
        cmd.add(rootfsDir.getAbsolutePath());
        bind(cmd, "/dev");
        bind(cmd, "/proc");
        bind(cmd, "/sys");
        bindTo(cmd, tmpDir.getAbsolutePath(), "/tmp");
        bindTo(cmd, homeDir.getAbsolutePath(), GUEST_HOME);
        bindTo(cmd, workspaceDir.getAbsolutePath(), GUEST_WORKSPACE);
        bindTo(cmd, claudeBin.getAbsolutePath(), GUEST_CLAUDE);
        cmd.add("-w");
        cmd.add(guestCwd != null && !guestCwd.isEmpty() ? guestCwd : GUEST_WORKSPACE);
        cmd.add(GUEST_CLAUDE);
        cmd.addAll(claudeArgs);

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(runtimeDir);
        pb.redirectErrorStream(false);

        java.util.Map<String, String> env = pb.environment();
        env.put("HOME", GUEST_HOME);
        env.put("USER", "root");
        env.put("LOGNAME", "root");
        env.put("TERM", "dumb");
        env.put("LANG", "C.UTF-8");
        env.put("LC_ALL", "C.UTF-8");
        env.put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        env.put("TMPDIR", "/tmp");
        env.put("PROOT_TMP_DIR", tmpDir.getAbsolutePath());
        // proot's seccomp acceleration is unreliable across Android kernels; the
        // slower ptrace-only path is far more compatible.
        env.put("PROOT_NO_SECCOMP", "1");
        // Reduce chatter on a phone. (CI=1 is NOT set here: it would break the
        // interactive setup-token login; the generation path sets it explicitly.)
        env.put("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
        return pb;
    }

    private static void bind(List<String> cmd, String path) {
        cmd.add("-b");
        cmd.add(path);
    }

    private static void bindTo(List<String> cmd, String host, String guest) {
        cmd.add("-b");
        cmd.add(host + ":" + guest);
    }

    // -------------------------------------------------------------------------
    // Download + SHA-256
    // -------------------------------------------------------------------------
    private String downloadWithSha256(String urlStr, File dest, ProgressSink sink) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(30000);
        conn.setReadTimeout(120000);
        conn.setRequestProperty("User-Agent", "AGY-Roleplay-Android/ClaudeRuntime");
        conn.setRequestProperty("Accept", "application/octet-stream, */*");
        int code = conn.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new Exception("Не удалось скачать среду: HTTP " + code);
        }
        long total = conn.getContentLengthLong();
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
                    int pct = (int) (done * 100 / total);
                    if (pct != lastPct && pct % 5 == 0) {
                        lastPct = pct;
                        sink.onProgress("Скачивание среды Claude: " + pct + "% ("
                            + (done >> 20) + "/" + (total >> 20) + " МБ)");
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
    // Minimal tar.gz extractor (ustar + GNU long names + pax path, symlinks)
    // -------------------------------------------------------------------------
    private void extractTarGz(File archive, File outDir) throws Exception {
        InputStream raw = new BufferedInputStream(new FileInputStream(archive), 1 << 16);
        InputStream in = new GZIPInputStream(raw, 1 << 16);
        try {
            byte[] header = new byte[512];
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

                File outFile = new File(outDir, name);
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
                    Path link = Paths.get(outFile.getAbsolutePath());
                    try {
                        Files.deleteIfExists(link);
                        Files.createSymbolicLink(link, Paths.get(linkName));
                    } catch (Exception symEx) {
                        // Some filesystems disallow symlinks: fall back to a copy later via busybox.
                    }
                } else if (type == '0' || type == '\0' || type == '7') { // regular file
                    File parent = outFile.getParentFile();
                    if (parent != null && !parent.exists()) parent.mkdirs();
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
                // Cheap and safe: the rootfs is all our own trusted binaries/libs.
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

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
        in.close();
        return bos.toByteArray();
    }

    private static void writeText(File f, String text) throws Exception {
        FileOutputStream fos = new FileOutputStream(f);
        fos.write(text.getBytes(StandardCharsets.UTF_8));
        fos.close();
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File c : kids) deleteRecursive(c);
        }
        f.delete();
    }
}
