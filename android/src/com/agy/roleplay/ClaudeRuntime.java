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
 * runs the binary through an unprivileged, statically linked {@code proot}
 * over a minimal Alpine (musl) rootfs, exactly like Termux/UserLAnd.
 *
 * Every component is downloaded once (user-triggered) straight from its
 * official upstream — Alpine Linux CDN and the npm registry — and verified
 * against a SHA-256 pinned below. The pins live in this signed APK rather than
 * in version.json because version.json fields are not covered by the OTA
 * signature, and these files are executable code. Nothing is re-hosted.
 *
 * Installed layout under filesDir/claude_runtime:
 *
 *   proot      static aarch64 proot (Alpine proot-static, loader embedded)
 *   rootfs/    Alpine minirootfs + libgcc/libstdc++
 *   claude     Claude Code CLI (npm @anthropic-ai/claude-code-linux-arm64-musl)
 *   home/      HOME inside the sandbox (/root): credentials, generated prompts
 *   tmp/       /tmp inside the sandbox and PROOT_TMP_DIR
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

    /** One downloadable component of the runtime. */
    private static final class Part {
        final String label;
        final String url;
        final String sha256;
        final long approxBytes;
        final Kind kind;
        final String member; // file to take from the archive (PROOT / CLAUDE parts)

        Part(String label, String url, String sha256, long approxBytes, Kind kind, String member) {
            this.label = label;
            this.url = url;
            this.sha256 = sha256;
            this.approxBytes = approxBytes;
            this.kind = kind;
            this.member = member;
        }
    }

    private enum Kind { PROOT, ROOTFS, CLAUDE }

    /** Bump whenever any pinned part changes: a different marker forces a reinstall. */
    static final String RUNTIME_VERSION = "claude-2.1.310+alpine-3.24.3+proot-5.4.0-r2";

    private static final String ALPINE = "https://dl-cdn.alpinelinux.org/alpine/v3.24";

    private static final Part[] PARTS = new Part[]{
        new Part("proot",
            ALPINE + "/community/aarch64/proot-static-5.4.0-r2.apk",
            "31d0e21ee87435ed819112cef84b8ce7d004c2835d8f61eeabe422e122b4b6cf",
            124909L, Kind.PROOT, "usr/bin/proot.static"),
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

    private final File runtimeDir;
    private final File prootBin;
    private final File rootfsDir;
    private final File claudeBin;
    private final File homeDir;
    private final File tmpDir;
    private final File readyMarker;

    ClaudeRuntime(Context context) {
        this(context.getFilesDir());
    }

    /** Test seam: lets a desktop JVM exercise download/verify/extract. */
    ClaudeRuntime(File filesDir) {
        this.runtimeDir = new File(filesDir, "claude_runtime");
        this.prootBin = new File(runtimeDir, "proot");
        this.rootfsDir = new File(runtimeDir, "rootfs");
        this.claudeBin = new File(runtimeDir, "claude");
        this.homeDir = new File(runtimeDir, "home");
        this.tmpDir = new File(runtimeDir, "tmp");
        this.readyMarker = new File(runtimeDir, ".ready");
    }

    File getHomeDir() {
        return homeDir;
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

    // Guest-visible paths inside the proot sandbox.
    static final String GUEST_HOME = "/root";
    static final String GUEST_CLAUDE = "/opt/claude";

    /** True once the pinned runtime has been fully extracted and chmod'd. */
    boolean isReady() {
        if (!prootBin.exists() || !claudeBin.exists() || !rootfsDir.isDirectory()) return false;
        if (!readyMarker.exists()) return false;
        try {
            String have = new String(readAll(new FileInputStream(readyMarker)), StandardCharsets.UTF_8).trim();
            return RUNTIME_VERSION.equals(have);
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

    /** Guest path of the BROWSER shim that hands URLs to the Android app. */
    static final String GUEST_BROWSER_SHIM = "/usr/local/bin/agy-open";

    /** Host file the shim appends URLs to (it lives in the sandbox /tmp). */
    File browserUrlFile() {
        return new File(tmpDir, "agy-open-url");
    }

    /**
     * Installs the BROWSER shim into the rootfs. Claude Code opens its sign-in
     * link by running $BROWSER <url>; inside the sandbox there is no browser, so
     * the shim records the URL for the app, which opens it in Android's browser.
     */
    void ensureBrowserShim() throws Exception {
        File shim = new File(rootfsDir, GUEST_BROWSER_SHIM.substring(1));
        File parent = shim.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        writeText(shim, "#!/bin/sh\n"
            + "# Hands URLs that Claude Code wants to open to the Android app.\n"
            + "printf '%s\\n' \"$1\" >> /tmp/agy-open-url\n"
            + "exit 0\n");
        shim.setExecutable(true, false);
        tmpDir.mkdirs();
    }

    /**
     * Writes a file into the sandbox HOME and returns its guest path, e.g. for
     * the generated system prompt passed with --system-prompt-file.
     */
    String writeHomeFile(String relName, String content) throws Exception {
        File f = new File(homeDir, relName);
        File parent = f.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        writeText(f, content != null ? content : "");
        return GUEST_HOME + "/" + relName;
    }

    /**
     * Downloads, verifies and extracts every pinned part. Safe to call when
     * already ready (returns immediately). Throws with a readable message on any
     * failure; a failed attempt leaves no ready marker. Signed-in credentials in
     * home/ survive a reinstall.
     */
    synchronized void ensureReady(ProgressSink sink) throws Exception {
        if (isReady()) return;

        runtimeDir.mkdirs();
        long free = runtimeDir.getUsableSpace();
        if (free > 0 && free < REQUIRED_FREE_BYTES) {
            throw new Exception("Недостаточно места: нужно около " + (REQUIRED_FREE_BYTES >> 20)
                + " МБ, свободно " + (free >> 20) + " МБ.");
        }

        // A stale/incompatible install must go before a fresh extract. HOME is
        // kept so an existing Claude sign-in survives the upgrade.
        readyMarker.delete();
        prootBin.delete();
        claudeBin.delete();
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
                File target = part.kind == Kind.PROOT ? prootBin : claudeBin;
                if (!picked.isFile() || !picked.renameTo(target)) {
                    deleteRecursive(stage);
                    archive.delete();
                    throw new Exception("В пакете «" + part.label + "» нет файла " + part.member + ".");
                }
                deleteRecursive(stage);
            }
            archive.delete();
        }

        if (!prootBin.exists() || !claudeBin.exists() || !new File(rootfsDir, "lib/ld-musl-aarch64.so.1").exists()) {
            throw new Exception("Среда распакована неполно: отсутствует proot, claude или rootfs.");
        }

        // Executables in app storage need the exec bit explicitly on some ROMs.
        prootBin.setExecutable(true, false);
        claudeBin.setExecutable(true, false);
        makeTreeExecutable(rootfsDir);
        writeGuestNetworkConfig();

        writeText(readyMarker, RUNTIME_VERSION);
        if (sink != null) sink.onProgress("Среда Claude готова.");
    }

    /** DNS and hosts for the guest: Android has no /etc/resolv.conf to inherit. */
    private void writeGuestNetworkConfig() throws Exception {
        File etc = new File(rootfsDir, "etc");
        etc.mkdirs();
        File resolv = new File(etc, "resolv.conf");
        resolv.delete(); // may be a dangling symlink in some rootfs builds
        writeText(resolv, "nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
        File hosts = new File(etc, "hosts");
        if (!hosts.exists() || hosts.length() == 0) {
            writeText(hosts, "127.0.0.1 localhost\n::1 localhost\n");
        }
    }

    /**
     * Builds a configured (not started) ProcessBuilder that runs the Claude CLI
     * under proot, with HOME (/root) as the working directory. Only the runtime's
     * own directories are visible inside the sandbox.
     */
    ProcessBuilder newClaudeProcess(List<String> claudeArgs) {
        List<String> cmd = new ArrayList<>();
        cmd.add(prootBin.getAbsolutePath());
        cmd.add("--kill-on-exit");
        cmd.add("--link2symlink");
        cmd.add("-r");
        cmd.add(rootfsDir.getAbsolutePath());
        bind(cmd, "/dev");
        bind(cmd, "/proc");
        bind(cmd, "/sys");
        bindTo(cmd, tmpDir.getAbsolutePath(), "/tmp");
        bindTo(cmd, homeDir.getAbsolutePath(), GUEST_HOME);
        bindTo(cmd, claudeBin.getAbsolutePath(), GUEST_CLAUDE);
        cmd.add("-w");
        cmd.add(GUEST_HOME);
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
        // The binary is pinned and verified by this app; it must not replace itself.
        env.put("DISABLE_AUTOUPDATER", "1");
        // Android's environment (ANDROID_*, BOOTCLASSPATH, LD_PRELOAD...) means
        // nothing inside the musl guest and LD_PRELOAD would break it.
        env.remove("LD_PRELOAD");
        env.remove("LD_LIBRARY_PATH");
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
        if (f.isDirectory() && !Files.isSymbolicLink(f.toPath())) {
            File[] kids = f.listFiles();
            if (kids != null) for (File c : kids) deleteRecursive(c);
        }
        f.delete();
    }
}
