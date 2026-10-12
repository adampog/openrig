#!/usr/bin/env bash
exec python3 - "$@" <<'PY_RIG_UP'
#!/usr/bin/env python3
"""Recover fleet walls, then close only the provably dead leftovers of earlier walls.

Recovery never closes a workspace: it opens a recovery wall and preserves what exists, because
a label does not prove ownership of every tab. Restarts therefore leave the pre-restart walls
behind, and herdr has no reaping of its own (`herdr workspace` has list/close, nothing more).
The prune step below closes those leftovers, and only those, once the fleet is confirmed up.

  rig-up                 recover walls, then prune provably dead ones
  rig-up --no-prune      recover walls only (the behaviour before the prune step)
  rig-up --prune-plan    read-only: print what the prune would close or keep, and why; never
                         starts, opens, moves or closes anything

A workspace is closed only when ALL of these hold (see plan_prune):
  - it existed before this run began (nothing opened by this run, or by anyone since, is touched);
  - its label is a rig that is up now, and every labelled pane is one of that rig's seats (a
    workspace holding anything else, such as a plain "~" shell, is not OpenRig's to close); an
    unlabelled spare shell is allowed only if it shows nothing but a prompt;
  - every pane is an idle bare shell: no tmux client, no foreground job, no agent at work;
  - another workspace for the same rig has a pane attached to a live tmux session, so the rig
    keeps a live wall;
  - both of two reads a few seconds apart agree, and one last read just before each close.
agent_status is never used: a just-started agent reads "unknown" for a moment.
"""
import json, os, re, socket, subprocess, sys, time, shutil

SHELLS = {'bash', 'zsh', 'fish', 'sh', 'dash', 'nu', 'ksh', 'tcsh', 'csh'}
SETTLE_SECONDS = float(os.environ.get('RIG_UP_PRUNE_SETTLE', '3'))

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


# --- prune of provably dead workspaces ---------------------------------------------------------

def pane_kind(proc, live):
    """Classify one pane from `herdr pane process-info` (the `process_info` object) and the live
    tmux session names. Only 'idle-shell' is dead; anything unclear is treated as not dead."""
    try:
        fg = proc['foreground_processes']; shell_pid = proc['shell_pid']
    except Exception: return 'unknown'
    if not isinstance(fg, list) or not fg: return 'unknown'
    for p in fg:
        argv = p.get('argv') or []
        if os.path.basename(argv[0] if argv else '') == 'tmux':
            args = argv[1:]
            target = next((args[i + 1] for i, a in enumerate(args[:-1]) if a == '-t'), None)
            return 'attached-live' if target in live else 'tmux-other'
    if all(p.get('name') in SHELLS and p.get('pid') == shell_pid for p in fg): return 'idle-shell'
    return 'busy'

def bare_prompt(text):
    """True when a pane's recent output is empty or just one shell prompt: nothing was ever run."""
    lines = [l.strip() for l in (text or '').splitlines() if l.strip()]
    return len(lines) == 0 or (len(lines) == 1 and len(lines[0]) <= 80 and re.search(r'[$#%>]$', lines[0]) is not None)

def plan_prune(workspaces, panes, procs, live, seats, preexisting, screens=None):
    """Decide which workspaces to close. Pure: no I/O.

    workspaces  [{workspace_id, label, ...}] from `herdr workspace list`
    panes       {workspace_id: [{pane_id, label, ...}]} from `herdr pane list --workspace`
    procs       {pane_id: process_info} from `herdr pane process-info --pane`
    live        set of live tmux session names
    seats       {rig name: set of seat logical ids}, only for rigs that are up now
    preexisting set of workspace ids that existed before this run began
    screens     {pane_id: recent output text}, read only for panes with no label
    Returns (close, keep): close is [(workspace_id, why)], keep is [(workspace_id, why)].
    """
    close, keep = [], []
    kinds = {}
    for w in workspaces:
        wid = w['workspace_id']
        kinds[wid] = [pane_kind(procs.get(p['pane_id']), live) for p in panes.get(wid, [])]
    def has_live_wall(label, excluding):
        return any(kinds[o['workspace_id']] and 'attached-live' in kinds[o['workspace_id']]
                   for o in workspaces if o.get('label') == label and o['workspace_id'] != excluding)
    for w in workspaces:
        wid, label = w['workspace_id'], w.get('label')
        ps, ks = panes.get(wid, []), kinds[wid]
        if wid not in preexisting: keep.append((wid, 'opened after this run began')); continue
        if label not in seats: keep.append((wid, 'label is not a rig that is up (not provably OpenRig\'s)')); continue
        if not ps: keep.append((wid, 'no panes listed; cannot prove it is dead')); continue
        labelled = [p for p in ps if p.get('label')]
        if not labelled or any(p['label'] not in seats[label] for p in labelled):
            keep.append((wid, 'has no seat pane, or a pane that is not one of the rig\'s seats')); continue
        # herdr adds an unlabelled spare shell to a wall. It may close with the wall only if it is
        # an idle shell showing nothing but a prompt, i.e. nothing was ever typed into it.
        if any(not bare_prompt((screens or {}).get(p['pane_id'])) for p in ps if not p.get('label')):
            keep.append((wid, 'an unlabelled pane shows content')); continue
        if 'attached-live' in ks: keep.append((wid, 'a pane is attached to a live tmux session')); continue
        if any(p.get('agent_status') in ('working', 'blocked') for p in ps): keep.append((wid, 'a pane reports an agent at work')); continue
        if any(k != 'idle-shell' for k in ks): keep.append((wid, 'a pane is not an idle bare shell')); continue
        if not has_live_wall(label, wid): keep.append((wid, 'no other live wall for this rig; never closes its only wall')); continue
        close.append((wid, 'every pane is an idle bare shell; the rig has a live wall elsewhere'))
    return close, keep

def herdr_workspaces():
    return json.loads(run('herdr', 'workspace', 'list'))['result']['workspaces']

def observe(workspaces):
    """Panes and pane processes for the given workspaces, read live."""
    panes, procs, screens = {}, {}, {}
    for w in workspaces:
        wid = w['workspace_id']
        panes[wid] = json.loads(run('herdr', 'pane', 'list', '--workspace', wid))['result']['panes']
        for p in panes[wid]:
            procs[p['pane_id']] = json.loads(run('herdr', 'pane', 'process-info', '--pane', p['pane_id']))['result']['process_info']
            if not p.get('label'): screens[p['pane_id']] = run('herdr', 'pane', 'read', p['pane_id'], '--source', 'recent')
    return panes, procs, screens

def live_sessions():
    return {line.rsplit(' ', 1)[0] for line in run('tmux', 'list-sessions', '-F', '#{session_name} #{session_attached}').splitlines() if line}

def rig_seats(walls):
    out = {}
    for r in walls:
        ns = nodes(r['name'])
        ids = {n.get('logicalId') for n in ns}
        if not ids or None in ids: raise ValueError('seat ids unavailable for ' + r['name'])
        out[r['name']] = ids
    return out

def evaluate(walls, preexisting):
    spaces = herdr_workspaces()
    panes, procs, screens = observe(spaces)
    return plan_prune(spaces, panes, procs, live_sessions(), rig_seats(walls), preexisting, screens)

def prune(walls, preexisting, apply):
    """Close provably dead workspaces. Two agreeing reads a few seconds apart, then one more read
    of just that workspace right before its close. With apply=False nothing is closed."""
    first_close, first_keep = evaluate(walls, preexisting)
    for wid, why in first_keep: say('prune: keep ' + wid + ': ' + why)
    if not first_close: say('prune: nothing provably dead'); return
    time.sleep(SETTLE_SECONDS)
    second_close, _ = evaluate(walls, preexisting)
    agreed = {wid for wid, _ in second_close} & {wid for wid, _ in first_close}
    for wid, why in first_close:
        if wid not in agreed: say('prune: keep ' + wid + ': it changed between reads'); continue
        if not apply: say('prune: would close ' + wid + ': ' + why); continue
        final_close, _ = evaluate(walls, preexisting)
        if wid not in {w for w, _ in final_close}: say('prune: keep ' + wid + ': it changed just before closing'); continue
        run('herdr', 'workspace', 'close', wid)
        say('prune: closed dead workspace ' + wid + ': ' + why)

def say(message):
    print('==> ' + message, flush=True)

def failed(message):
    failures.append(message); print('warn: ' + message, file=sys.stderr, flush=True)

def main(argv):
    no_prune, prune_plan = '--no-prune' in argv, '--prune-plan' in argv
    if prune_plan:
        try:
            walls = [r for r in fleet() if r.get('status') in ('running', 'partial')]
            prune(walls, {w['workspace_id'] for w in herdr_workspaces()}, apply=False)
            return 0
        except Exception as e: failed('prune plan unavailable: ' + type(e).__name__); return 1
    # Workspaces that exist before this run does anything: the only ones the prune may close.
    try: preexisting = {w['workspace_id'] for w in herdr_workspaces()}
    except Exception: preexisting = None
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
    # Prune before reordering: ordering skips a rig with several workspaces (it never chooses
    # between duplicates), so closing the dead leftovers first lets every rig be ordered.
    if not failures and not no_prune:
        try:
            if preexisting is None: raise ValueError('no workspace inventory before recovery')
            prune(walls, preexisting, apply=True)
        except Exception as e: failed('prune skipped: ' + type(e).__name__)
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

if __name__ == '__main__': sys.exit(main(sys.argv[1:]))

PY_RIG_UP
