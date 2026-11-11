#!/usr/bin/env python3
"""Corre un comando como lider de una sesion nueva con una pty de control.

Uso: pty-run.py [--pid-file F] [--rc-file F] -- <cmd> [args...]

--pid-file recibe el PID del comando (no el de este envoltorio) y --rc-file su
exit code al terminar (128 + senal si lo mato una senal). Matar este
envoltorio cierra la pty: el kernel manda SIGHUP a la sesion del comando.
"""
import os
import pty
import select
import signal
import sys
import time


def write_atomic(path, text):
    tmp = f"{path}.tmp"
    with open(tmp, "w") as handle:
        handle.write(text)
    os.rename(tmp, path)


def main():
    args = sys.argv[1:]
    pid_file = rc_file = None
    while args and args[0] != "--":
        if args[0] == "--pid-file" and len(args) > 1:
            pid_file = args[1]
        elif args[0] == "--rc-file" and len(args) > 1:
            rc_file = args[1]
        else:
            sys.exit(f"pty-run: argumento no reconocido: {args[0]}")
        args = args[2:]
    command = args[1:]
    if not command:
        sys.exit("uso: pty-run.py [--pid-file F] [--rc-file F] -- <cmd> [args...]")

    pid, master = pty.fork()
    if pid == 0:
        # Un shell no interactivo lanza sus jobs en background con SIGINT y
        # SIGQUIT ignoradas, y bash no deja atrapar una senal que hereda
        # ignorada: el comando arranca con las disposiciones por defecto.
        for signum in (signal.SIGINT, signal.SIGQUIT):
            signal.signal(signum, signal.SIG_DFL)
        os.execvp(command[0], command)

    if pid_file:
        write_atomic(pid_file, f"{pid}\n")

    # Se drena la pty para que el comando nunca se bloquee escribiendo en ella.
    master_open = True
    while True:
        if master_open:
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    master_open = bool(os.read(master, 4096))
                except OSError:
                    master_open = False
        else:
            time.sleep(0.05)
        reaped, status = os.waitpid(pid, os.WNOHANG)
        if reaped:
            break

    if os.WIFSIGNALED(status):
        rc = 128 + os.WTERMSIG(status)
    else:
        rc = os.WEXITSTATUS(status)
    if rc_file:
        write_atomic(rc_file, f"{rc}\n")
    sys.exit(rc)


if __name__ == "__main__":
    main()
