#!/usr/bin/env bash
exec python3 - "$@" <<'PY_RIG_UP'
#!/usr/bin/env python3
"""Recover fleet walls without closing existing workspaces or mistaking partial for stopped."""
import json, os, socket, subprocess, sys, time, shutil

failures = []

def run(*args, timeout=10):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=timeout).stdout

def rows(*args):
    data = json.loads(run(*args))
    if isinstance(data, dict) and data.get('truncated'): raise ValueError('truncated inventory')
    result = data.get('entries') if isinstance(data, dict) else data
    if not isinstance(result, list):
        raise ValueError('invalid list response')
    return result

def fleet():
    return [r for r in rows('rig', 'ps', '--json', '--full') if not r.get('isArchived')]

def nodes(name):
    return rows('rig', 'ps', '--nodes', '--rig', name, '--json', '--full')

def identity(n):
    return n.get('canonicalSessionName') or n.get('sessionName')

def ready(expected, observed):
    names = {identity(n) for n in expected}
    current = {identity(n): n for n in observed}
    return bool(names) and None not in names and all(
        name in current and current[name].get('sessionStatus') == 'running'
        and current[name].get('startupStatus') == 'ready' for name in names)

def attached(expected):
    names = {identity(n) for n in expected}
    actual = {}
    for line in run('tmux', 'list-sessions', '-F', '#{session_name} #{session_attached}').splitlines():
        name, count = line.rsplit(' ', 1); actual[name] = int(count)
    return bool(names) and None not in names and all(actual.get(n, 0) > 0 for n in names)

def say(message):
    print('==> ' + message, flush=True)

def failed(message):
    failures.append(message); print('warn: ' + message, file=sys.stderr, flush=True)

def main():
    # A failed read is unknown, not permission to start a fleet.
    started = False
    try: rigs = fleet()
    except Exception:
        try: state = run('rig', 'daemon', 'status').strip()
        except Exception: state = ''
        # These exact installed-CLI verdicts distinguish absent from unknown/unhealthy.
        if state not in ('Daemon stopped', 'Daemon PID is absent (stale state)'):
            failed('fleet state unverified; inspect rig daemon status before recovery'); return 1
        try:
            say('Daemon confirmed stopped; starting last-running rigs')
            run('rig', 'start', '--last', timeout=120); rigs = fleet(); started = True
        except Exception: failed('rig start --last failed'); return 1
    if not started and not any(r.get('status') in ('running', 'partial') for r in rigs):
        say('No running or partial rigs; starting last-running rigs')
        try: run('rig', 'start', '--last', timeout=120); rigs = fleet()
        except Exception: failed('rig start --last failed'); return 1
    kernel = next((r for r in rigs if r.get('name') == 'kernel'), None)
    if kernel and kernel.get('status') == 'stopped':
        try:
            expected = nodes('kernel')
            if not expected or any(not identity(n) for n in expected):
                raise ValueError('kernel expected seat identities unavailable')
            snapshots = run('rig', 'snapshot', 'list', kernel['rigId'])
            snap = next((line.split()[0] for line in snapshots.splitlines()
                         if len(line.split()) >= 3 and line.split()[2] == 'complete'), None)
            if not snap: raise ValueError('no complete kernel snapshot')
            run('rig', 'restore', snap, '--rig', kernel['rigId'], timeout=120)
            deadline = time.monotonic() + 120
            while not ready(expected, nodes('kernel')):
                if time.monotonic() >= deadline: raise TimeoutError('kernel readiness timed out')
                time.sleep(2)
            rigs = fleet()
        except Exception as e: failed('kernel recovery incomplete: ' + type(e).__name__)
    walls = [r for r in rigs if r.get('status') in ('running', 'partial')]
    if not walls: failed('no running or partial rigs to open'); return 1
    for r in sorted(walls, key=lambda r: r['name'] != 'kernel'):
        name = r['name']
        try:
            expected = nodes(name)
            if not expected or any(not identity(n) for n in expected):
                raise ValueError('expected seats unavailable')
            spaces = json.loads(run('herdr', 'workspace', 'list'))['result']['workspaces']
            matches = [w for w in spaces if w.get('label') == name]
            if matches and ready(expected, expected) and attached(expected):
                say(name + ': wall already live'); continue
            # Labels do not prove ownership of every tab. Preserve old workspaces.
            if matches: say(name + ': preserving existing workspace(s); opening recovery wall')
            run('rig', 'terminal', 'open', name, '--provider', 'herdr', timeout=120)
            if not ready(expected, nodes(name)) or not attached(expected):
                raise ValueError('wall opened but complete ready/attached seats not verified')
            say(name + ': wall verified')
        except Exception as e: failed(name + ': wall recovery incomplete: ' + type(e).__name__)
    # Reordering and spawning windows are intentionally left to the human when recovery
    # has failures; neither can turn a failed recovery into success.
    if not failures:
        try:
            path = os.path.expanduser('~/.config/herdr/herdr.sock')
            def call(method, params):
                with socket.socket(socket.AF_UNIX) as s:
                    s.settimeout(5); s.connect(path)
                    s.sendall((json.dumps({'id':'rig-up','method':method,'params':params})+'\n').encode())
                    buf = b''
                    while not buf.endswith(b'\n'):
                        chunk=s.recv(65536)
                        if not chunk: raise ValueError('incomplete Herder response')
                        buf+=chunk
                        if len(buf)>1024*1024: raise ValueError('oversized Herder response')
                    reply=json.loads(buf)
                    if reply.get('error'): raise ValueError('Herder operation failed')
                    return reply['result']
            spaces = call('workspace.list', {})['workspaces']
            for index, r in enumerate(sorted(walls,key=lambda r:r['name']!='kernel')):
                matches=[w for w in spaces if w.get('label')==r['name']]
                # Ambiguous duplicates are preserved and never chosen for movement.
                if len(matches)==1: call('workspace.move',{'workspace_id':matches[0]['workspace_id'],'insert_index':index})
        except Exception: failed('could not verify Herder wall ordering')
    if not failures:
        try:
            processes = subprocess.run(['pgrep', '-x', 'herdr', '-a'], text=True, capture_output=True, timeout=5)
            has_window = any(' server' not in line for line in processes.stdout.splitlines())
            if not has_window:
                if os.environ.get('WAYLAND_DISPLAY') and shutil.which('uwsm'):
                    subprocess.Popen(['uwsm','app','--','xdg-terminal-exec','herdr'],
                                     start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    say('Opening a Herder window')
                else: say('No Herder window attached; run: herdr')
        except Exception: failed('could not open Herder window')
    try: print(run('rig', 'ps'))
    except Exception: failed('final fleet read failed')
    return 1 if failures else 0

if __name__ == '__main__': sys.exit(main())

PY_RIG_UP
