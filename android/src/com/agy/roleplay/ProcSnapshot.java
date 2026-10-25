package com.agy.roleplay;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Plain-text snapshot of the processes this app started (proot and whatever
 * runs inside the sandbox), taken when one of them stops responding. For every
 * thread it shows the scheduler state, the kernel wait channel and the system
 * call it is blocked in; for every process its open files and TCP/UDP sockets.
 * That is enough to tell a stuck event loop from a child it waits on, a network
 * connect that never completes or a ptrace stop proot never resumed.
 */
final class ProcSnapshot {

    private ProcSnapshot() {
    }

    private static final int MAX_CHARS = 9000;
    private static final int MAX_THREADS = 40;
    private static final int MAX_FDS = 24;

    /** Child pids by parent pid; null when /proc cannot be listed. */
    private static Map<Integer, List<Integer>> childrenByParent() {
        File[] entries = new File("/proc").listFiles();
        if (entries == null) return null;
        Map<Integer, List<Integer>> children = new HashMap<>();
        for (File e : entries) {
            int pid = toInt(e.getName());
            if (pid <= 0) continue;
            int ppid = toInt(statusField(pid, "PPid"));
            if (ppid <= 0) continue;
            List<Integer> list = children.get(ppid);
            if (list == null) {
                list = new ArrayList<>();
                children.put(ppid, list);
            }
            list.add(pid);
        }
        return children;
    }

    /** Every descendant of {@code pid}, deepest first (sandboxed processes before their proot). */
    static List<Integer> descendants(int pid) {
        List<Integer> out = new ArrayList<>();
        Map<Integer, List<Integer>> children = childrenByParent();
        if (children != null) collect(pid, children, out);
        return out;
    }

    private static void collect(int pid, Map<Integer, List<Integer>> children, List<Integer> out) {
        List<Integer> kids = children.get(pid);
        if (kids == null) return;
        for (int kid : kids) {
            collect(kid, children, out);
            out.add(kid);
        }
    }

    /** Direct children of {@code pid} running an executable from under {@code dir}. */
    static List<Integer> childrenRunningFrom(int pid, String dir) {
        List<Integer> out = new ArrayList<>();
        Map<Integer, List<Integer>> children = childrenByParent();
        List<Integer> kids = children != null ? children.get(pid) : null;
        if (kids == null) return out;
        for (int kid : kids) {
            try {
                String exe = Files.readSymbolicLink(Paths.get("/proc/" + kid + "/exe")).toString();
                if (exe.startsWith(dir + "/")) out.add(kid);
            } catch (Exception ignored) {
                // gone, or not ours to inspect
            }
        }
        return out;
    }

    /** Describes every descendant of {@code rootPid} (normally the app's own pid). */
    static String ofDescendants(int rootPid, String hidePrefix) {
        Map<Integer, List<Integer>> children = childrenByParent();
        if (children == null) return "(нет доступа к /proc)";
        StringBuilder sb = new StringBuilder();
        List<Integer> top = children.get(rootPid);
        if (top == null || top.isEmpty()) return "(дочерних процессов нет)";
        Collections.sort(top);
        for (int pid : top) describe(pid, 0, children, sb, hidePrefix);
        if (sb.length() > MAX_CHARS) {
            return sb.substring(0, MAX_CHARS) + "\n… (обрезано)";
        }
        return sb.toString().trim();
    }

    private static void describe(int pid, int depth, Map<Integer, List<Integer>> children, StringBuilder sb, String hide) {
        if (sb.length() > MAX_CHARS) return;
        String indent = repeat("  ", depth);
        String name = statusField(pid, "Name");
        sb.append(indent).append("pid ").append(pid).append(' ').append(name)
            .append(" · ").append(statusField(pid, "State"))
            .append(" · потоков ").append(statusField(pid, "Threads"))
            .append(" · tracer ").append(statusField(pid, "TracerPid")).append('\n');
        String cmd = cmdline(pid, hide);
        if (!cmd.isEmpty()) sb.append(indent).append("  $ ").append(cmd).append('\n');

        File[] tasks = new File("/proc/" + pid + "/task").listFiles();
        if (tasks != null) {
            int[] tids = new int[tasks.length];
            for (int i = 0; i < tasks.length; i++) tids[i] = toInt(tasks[i].getName());
            Arrays.sort(tids);
            int shown = 0;
            for (int tid : tids) {
                if (tid <= 0) continue;
                if (shown++ >= MAX_THREADS) {
                    sb.append(indent).append("  · … ещё потоки\n");
                    break;
                }
                String base = "/proc/" + pid + "/task/" + tid + "/";
                String wchan = read(base + "wchan").trim();
                String call = describeSyscall(read(base + "syscall").trim());
                sb.append(indent).append("  · ").append(tid).append(" [").append(read(base + "comm").trim()).append("] ")
                    .append(threadState(read(base + "stat")))
                    .append(wchan.isEmpty() || "0".equals(wchan) ? "" : " · " + wchan)
                    .append(call.isEmpty() ? "" : " · " + call).append('\n');
            }
        }

        Set<String> sockets = new HashSet<>();
        File[] fds = new File("/proc/" + pid + "/fd").listFiles();
        if (fds != null && fds.length > 0) {
            int[] nums = new int[fds.length];
            for (int i = 0; i < fds.length; i++) nums[i] = toInt(fds[i].getName());
            Arrays.sort(nums);
            StringBuilder line = new StringBuilder();
            int shown = 0;
            for (int fd : nums) {
                if (fd < 0) continue;
                String target;
                try {
                    target = Files.readSymbolicLink(Paths.get("/proc/" + pid + "/fd/" + fd)).toString();
                } catch (Exception e) {
                    continue;
                }
                if (target.startsWith("socket:[")) sockets.add(target.substring(8, target.length() - 1));
                if (shown++ < MAX_FDS) {
                    if (line.length() > 0) line.append(", ");
                    line.append(fd).append('→').append(shorten(target, hide));
                }
            }
            if (shown > MAX_FDS) line.append(", … всего ").append(shown);
            if (line.length() > 0) sb.append(indent).append("  fd: ").append(line).append('\n');
        }
        if (!sockets.isEmpty()) {
            for (String proto : new String[]{"tcp", "tcp6", "udp", "udp6"}) {
                for (String s : sockets(pid, proto, sockets)) sb.append(indent).append("  ").append(s).append('\n');
            }
        }

        List<Integer> kids = children.get(pid);
        if (kids != null) {
            Collections.sort(kids);
            for (int kid : kids) describe(kid, depth + 1, children, sb, hide);
        }
    }

    /** Lines of /proc/PID/net/PROTO for the given socket inodes, addresses decoded. */
    private static List<String> sockets(int pid, String proto, Set<String> inodes) {
        List<String> out = new ArrayList<>();
        String table = read("/proc/" + pid + "/net/" + proto, 1 << 20);
        if (table.isEmpty()) return out;
        String[] lines = table.split("\n");
        for (int i = 1; i < lines.length; i++) {
            String[] f = lines[i].trim().split("\\s+");
            if (f.length < 10 || !inodes.contains(f[9])) continue;
            out.add(proto + " " + address(f[1]) + " → " + address(f[2]) + " · " + socketState(proto, f[3]));
        }
        return out;
    }

    private static String socketState(String proto, String hex) {
        if (proto.startsWith("udp")) return "07".equals(hex) ? "UDP" : "UDP " + hex;
        switch (hex) {
            case "01": return "ESTABLISHED";
            case "02": return "SYN_SENT (соединение не устанавливается)";
            case "03": return "SYN_RECV";
            case "04": return "FIN_WAIT1";
            case "05": return "FIN_WAIT2";
            case "06": return "TIME_WAIT";
            case "07": return "CLOSE";
            case "08": return "CLOSE_WAIT";
            case "09": return "LAST_ACK";
            case "0A": return "LISTEN";
            case "0B": return "CLOSING";
            default: return hex;
        }
    }

    /** "0100007F:0035" → 127.0.0.1:53; IPv6 → compact hex groups. */
    static String address(String field) {
        int colon = field.indexOf(':');
        if (colon < 0) return field;
        String hex = field.substring(0, colon);
        int port;
        try {
            port = Integer.parseInt(field.substring(colon + 1), 16);
        } catch (Exception e) {
            port = -1;
        }
        String host;
        try {
            if (hex.length() == 8) {
                long v = Long.parseLong(hex, 16);
                host = (v & 0xff) + "." + ((v >> 8) & 0xff) + "." + ((v >> 16) & 0xff) + "." + ((v >> 24) & 0xff);
            } else if (hex.length() == 32) {
                // Four little-endian 32-bit words.
                StringBuilder sb = new StringBuilder();
                for (int w = 0; w < 4; w++) {
                    String word = hex.substring(w * 8, w * 8 + 8);
                    String be = word.substring(6, 8) + word.substring(4, 6) + word.substring(2, 4) + word.substring(0, 2);
                    if (w > 0) sb.append(':');
                    sb.append(Integer.toHexString(Integer.parseInt(be.substring(0, 4), 16))).append(':')
                        .append(Integer.toHexString(Integer.parseInt(be.substring(4, 8), 16)));
                }
                host = "[" + sb + "]";
            } else {
                host = hex;
            }
        } catch (Exception e) {
            host = hex;
        }
        return host + ":" + port;
    }

    /** "/proc/PID/task/TID/stat" → "S (sleeping)" etc. */
    private static String threadState(String stat) {
        int close = stat.lastIndexOf(')');
        if (close < 0 || close + 2 >= stat.length()) return "?";
        char c = stat.charAt(close + 2);
        switch (c) {
            case 'R': return "R выполняется";
            case 'S': return "S ждёт";
            case 'D': return "D ждёт ввод-вывод";
            case 'T': return "T остановлен";
            case 't': return "t остановлен трассировкой";
            case 'Z': return "Z зомби";
            default: return String.valueOf(c);
        }
    }

    /** "/proc/.../syscall" → "futex(0x7f.., 0x80, 0x0)", "выполняется" or "". */
    static String describeSyscall(String raw) {
        if (raw.isEmpty()) return "";
        if (raw.startsWith("running")) return "в пользовательском коде";
        String[] f = raw.split("\\s+");
        int nr = toInt(f[0]);
        if (nr < 0) return "вне системного вызова";
        StringBuilder sb = new StringBuilder(syscallName(nr)).append('(');
        for (int i = 1; i <= 3 && i < f.length - 2; i++) {
            if (i > 1) sb.append(", ");
            sb.append(f[i]);
        }
        return sb.append(')').toString();
    }

    /** aarch64 system call numbers seen in hangs. */
    private static String syscallName(int nr) {
        switch (nr) {
            case 19: return "eventfd2";
            case 20: return "epoll_create1";
            case 21: return "epoll_ctl";
            case 22: return "epoll_pwait";
            case 23: return "dup";
            case 25: return "fcntl";
            case 29: return "ioctl";
            case 32: return "flock";
            case 56: return "openat";
            case 57: return "close";
            case 59: return "pipe2";
            case 61: return "getdents64";
            case 62: return "lseek";
            case 63: return "read";
            case 64: return "write";
            case 65: return "readv";
            case 66: return "writev";
            case 67: return "pread64";
            case 72: return "pselect6";
            case 73: return "ppoll";
            case 78: return "readlinkat";
            case 79: return "newfstatat";
            case 80: return "fstat";
            case 93: return "exit";
            case 94: return "exit_group";
            case 95: return "waitid";
            case 98: return "futex";
            case 101: return "nanosleep";
            case 115: return "clock_nanosleep";
            case 117: return "ptrace";
            case 124: return "sched_yield";
            case 129: return "kill";
            case 133: return "rt_sigsuspend";
            case 137: return "rt_sigtimedwait";
            case 160: return "uname";
            case 167: return "prctl";
            case 198: return "socket";
            case 200: return "bind";
            case 202: return "accept";
            case 203: return "connect";
            case 206: return "sendto";
            case 207: return "recvfrom";
            case 211: return "sendmsg";
            case 212: return "recvmsg";
            case 215: return "munmap";
            case 220: return "clone";
            case 221: return "execve";
            case 222: return "mmap";
            case 226: return "mprotect";
            case 233: return "madvise";
            case 242: return "accept4";
            case 260: return "wait4";
            case 278: return "getrandom";
            case 279: return "memfd_create";
            case 283: return "membarrier";
            case 286: return "preadv2";
            case 291: return "statx";
            case 424: return "pidfd_send_signal";
            case 434: return "pidfd_open";
            case 435: return "clone3";
            case 441: return "epoll_pwait2";
            default: return "syscall#" + nr;
        }
    }

    private static String cmdline(int pid, String hide) {
        String raw = read("/proc/" + pid + "/cmdline");
        if (raw.isEmpty()) return "";
        String cmd = raw.replace('\0', ' ').trim();
        // proot's own command line is mostly bind mounts; keep the guest command.
        int w = cmd.indexOf(" -w /root ");
        if (w >= 0) cmd = "proot … " + cmd.substring(w + 10);
        return shorten(cmd, hide);
    }

    private static String shorten(String s, String hide) {
        String out = hide != null && !hide.isEmpty() ? s.replace(hide, "…") : s;
        return out.length() > 200 ? out.substring(0, 200) + "…" : out;
    }

    private static String statusField(int pid, String key) {
        String status = read("/proc/" + pid + "/status");
        for (String line : status.split("\n")) {
            if (line.startsWith(key + ":")) return line.substring(key.length() + 1).trim();
        }
        return "";
    }

    private static String read(String path) {
        return read(path, 16384);
    }

    private static String read(String path, int max) {
        InputStream in = null;
        try {
            in = new FileInputStream(path);
            byte[] buf = new byte[max];
            int total = 0;
            int n;
            while (total < buf.length && (n = in.read(buf, total, buf.length - total)) > 0) total += n;
            return new String(buf, 0, total, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private static int toInt(String s) {
        if (s == null) return -1;
        try {
            return Integer.parseInt(s.trim());
        } catch (Exception e) {
            return -1;
        }
    }

    private static String repeat(String s, int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) sb.append(s);
        return sb.toString();
    }
}
