#!/usr/bin/env python3
"""GeekPro(Windows/OpenSSH) 驱动：密码从环境 GP_PASS 取，超时可调，原始输出直出。
用法: GP_PASS=... python3 tmp/gp.py [-t 120] 'cmd1; cmd2'
"""
import os, pty, sys, time, select

HOST = os.environ.get("GP_HOST", "100.100.140.75")
USER = os.environ.get("GP_USER", "jianz")
PASS = os.environ.get("GP_PASS") or ""

args = ["ssh", "-tt", "-o", "StrictHostKeyChecking=accept-new",
        "-o", "UserKnownHostsFile=/tmp/gp_known_hosts",
        "-o", "PreferredAuthentications=password,keyboard-interactive",
        "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1",
        f"{USER}@{HOST}"]
cmd = sys.argv[1:]
if cmd and cmd[0] == "-t":
    deadline = float(cmd[1]); cmd = cmd[2:]
else:
    deadline = float(os.environ.get("GP_TIMEOUT", "120"))
LOCAL, REMOTE = cmd[0], cmd[1] if len(cmd) > 1 else ""
args = ["scp", "-O", "-o", "StrictHostKeyChecking=accept-new",
        "-o", "UserKnownHostsFile=/tmp/gp_known_hosts",
        "-o", "PreferredAuthentications=password,keyboard-interactive",
        "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1",
        f"{LOCAL}", f"{USER}@{HOST}:{REMOTE}"]

pid, fd = pty.fork()
if pid == 0:
    os.execvpe(args[0], args, dict(os.environ))
out = bytearray()
sent = 0
end = time.time() + deadline
while time.time() < end:
    try:
        r, _, _ = select.select([fd], [], [], 0.5)
    except OSError:
        break
    if fd in r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        out.extend(data)
        tail = out[-300:].decode(errors="replace").lower()
        if "password" in tail and sent < 1:
            sent += 1
            time.sleep(0.25)
            os.write(fd, (PASS + "\n").encode())
        if "permission denied" in tail or "too many authentication" in tail:
            break
try:
    os.waitpid(pid, 0)
except OSError:
    pass
sys.stdout.write(bytes(out).decode(errors="replace"))
