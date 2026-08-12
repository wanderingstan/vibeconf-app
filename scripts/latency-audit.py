#!/usr/bin/env python3
"""Latency audit over vibeconferencing session logs (#responsiveness).

Reconstructs each bot response cycle from log landmarks:
  t_lastcap : last caption-raw text growth before silence     (optional)
  t_stop    : [silence] User(s) stopped speaking
  t_gate    : [resolve] Silence threshold met (elapsed >= thr)
  t_resolve : [resolve] wait_for_speech resolved reason=silence
  t_speak   : first [local-server] Bot speech: after resolve
  claude_ms : [perf] Claude responded in Xms (authoritative resolve->speak)
  t_synth   : [electron] TTS synthesized: <same-text-prefix>
  t_sent    : [electron] Sent play-tts to Meet view
Legs:
  A cap_tail   = t_stop - t_lastcap    (caption settle -> stop detected)
  B gate_wait  = t_gate - t_stop       (deliberate silence threshold + overshoot)
    overshoot  = elapsed - threshold   (parsed from the gate line itself)
  C resolve    = t_resolve - t_gate    (~0)
  D claude     = claude_ms             (LLM think time; not ours to fix)
  E synth      = t_synth - t_speak     (TTS synthesis)
  F send       = t_sent - t_synth      (unmute settle, fixed 300ms by design)
  TOTAL(ours)  = t_sent - t_stop - claude_ms  (everything we control)
  TOTAL        = t_sent - t_stop
"""
import re, sys, glob, os, statistics as st
from datetime import datetime, timedelta

TS = re.compile(r'^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s')

def parse_ts(line, day=0):
    m = TS.match(line)
    if not m: return None
    h, mi, s, ms = map(int, m.groups())
    return h*3600 + mi*60 + s + ms/1000 + day*86400

PAT = {
    'stop':    re.compile(r'\[silence\] User\(s\) stopped speaking'),
    'gate':    re.compile(r'\[resolve\] Silence threshold met \((\d+)ms ≥ (\d+)ms'),
    'resolve': re.compile(r'\[resolve\] wait_for_speech resolved — reason=(\w+), waited=(\d+)ms'),
    'perf':    re.compile(r'\[perf\] Claude responded in (\d+)ms'),
    'speak':   re.compile(r'\[local-server\] Bot speech: (.{0,40})'),
    'synth':   re.compile(r'\[electron\] TTS synthesized: (.{0,40}?)\s*→'),
    'sent':    re.compile(r'\[electron\] Sent play-tts to Meet view'),
    'capraw':  re.compile(r'\[caption-raw\] t\d+ LIVE'),
    'model':   re.compile(r'\[agent\] model=(\S+)'),
    # 📊 [context] input=72123 (fresh=2 cacheRead=72000 cacheWrite=121) output=45
    'ctx':     re.compile(r'\[context\] input=(\d+) \(fresh=(\d+) cacheRead=(\d+) cacheWrite=(\d+)\) output=(\d+)'),
    # 📦 [payload] round → 3 entries, 412 chars, reason=silence
    'payload': re.compile(r'\[payload\] round → (\d+) entries, (\d+) chars'),
}

def audit_file(path):
    cycles = []
    events = []  # (t, kind, payload)
    last_t = None; day = 0
    build = '?'  # from the session-log header: "<version> @ <git>"
    ver = git = None
    import os as _os
    try:
        if _os.path.getsize(path) > 200_000_000:  # runaway log — skip
            print(f"  [skip >200MB] {path}", file=sys.stderr)
            return []
        fh = open(path, errors='replace')
    except OSError:
        return []
    for ln in fh:
        if ln.startswith('[session-log] '):
            if ln.startswith('[session-log] version='): ver = ln.split('=', 1)[1].strip()
            elif ln.startswith('[session-log] git='): git = ln.split('=', 1)[1].strip()
            if ver or git: build = f"{ver or '?'} @ {git or '?'}"
            continue
        t = parse_ts(ln, day)
        if t is None: continue
        if last_t is not None and t < last_t - 43200:  # midnight rollover
            day += 1; t += 86400
        last_t = t
        for kind, pat in PAT.items():
            m = pat.search(ln)
            if m:
                events.append((t, kind, m.groups() if m.groups() else ()))
                break
    # Which model authored each reply — logged as a change-only marker (#agent
    # model=), so a cycle inherits whatever model was most recently announced
    # at-or-before its speak time, not necessarily one right next to it.
    model_events = [(t, g[0]) for (t, kind, g) in events if kind == 'model']
    def model_at(t):
        best = None
        for mt, m in model_events:
            if mt <= t: best = m
            else: break
        return best

    # walk resolves with reason=silence; build cycles
    for i, (t, kind, g) in enumerate(events):
        if kind != 'resolve' or g[0] != 'silence': continue
        cyc = {'t_resolve': t, 'file': os.path.basename(path), 'build': build}
        # backward: gate (within 0.2s), stop, last capraw before stop
        for j in range(i-1, max(-1, i-40), -1):
            tj, kj, gj = events[j]
            if kj == 'gate' and 'gate' not in cyc and t - tj < 0.5:
                cyc['t_gate'] = tj
                cyc['gate_elapsed'] = int(gj[0]); cyc['gate_thr'] = int(gj[1])
            elif kj == 'stop' and 't_stop' not in cyc and t - tj < 60:
                cyc['t_stop'] = tj
                for k in range(j-1, max(-1, j-40), -1):
                    tk, kk, _ = events[k]
                    if kk == 'capraw' and tj - tk < 30:
                        cyc['t_lastcap'] = tk; break
                    if kk in ('resolve', 'sent'): break
                break
            elif kj == 'resolve': break
        # forward: perf, first speak, then synth matching speak text, then sent
        speak_text = None
        for j in range(i+1, min(len(events), i+60)):
            tj, kj, gj = events[j]
            if tj - t > 120: break
            if kj == 'resolve': break
            if kj == 'perf' and 'claude_ms' not in cyc: cyc['claude_ms'] = int(gj[0])
            elif kj == 'ctx' and 'ctx_in' not in cyc: cyc['ctx_in'] = int(gj[0])
            elif kj == 'payload' and 'payload_chars' not in cyc:
                cyc['payload_entries'] = int(gj[0]); cyc['payload_chars'] = int(gj[1])
            elif kj == 'speak' and 't_speak' not in cyc:
                cyc['t_speak'] = tj; speak_text = gj[0][:25]
            elif kj == 'synth' and 't_speak' in cyc and 't_synth' not in cyc:
                if speak_text and not gj[0].startswith(speak_text[:20]): continue  # skip ack synth
                cyc['t_synth'] = tj
            elif kj == 'sent' and 't_synth' in cyc and 't_sent' not in cyc:
                cyc['t_sent'] = tj; break
        cyc['model'] = model_at(cyc.get('t_speak', t))
        if 't_stop' in cyc: cycles.append(cyc)
    return cycles

def stats(vals):
    vals = [v for v in vals if v is not None]
    if not vals: return None
    vals.sort()
    return {'n': len(vals), 'avg': st.mean(vals), 'med': st.median(vals),
            'min': vals[0], 'max': vals[-1],
            'p90': vals[min(len(vals)-1, int(len(vals)*0.9))]}

def ms(x): return None if x is None else x*1000

def main(patterns):
    files = []
    for p in patterns: files.extend(glob.glob(p))
    all_cycles = []
    per_file = {}
    for f in sorted(set(files)):
        c = audit_file(f)
        if c: per_file[f] = len(c); all_cycles.extend(c)
    legs = {
        'A cap_tail (last caption→stop detected)': [ms(c['t_stop']-c['t_lastcap']) for c in all_cycles if 't_lastcap' in c],
        'B gate_wait (stop→gate met)':             [ms(c['t_gate']-c['t_stop']) for c in all_cycles if 't_gate' in c],
        'B2 overshoot (elapsed−threshold)':        [c['gate_elapsed']-c['gate_thr'] for c in all_cycles if 'gate_elapsed' in c],
        'C gate→resolve':                          [ms(c['t_resolve']-c['t_gate']) for c in all_cycles if 't_gate' in c],
        'D claude (resolve→first speak)':          [c['claude_ms'] for c in all_cycles if 'claude_ms' in c],
        'E synth (speak→audio ready)':             [ms(c['t_synth']-c['t_speak']) for c in all_cycles if 't_synth' in c and 't_speak' in c],
        'F send (synth→play-tts sent)':            [ms(c['t_sent']-c['t_synth']) for c in all_cycles if 't_sent' in c and 't_synth' in c],
        'TOTAL stop→audio sent':                   [ms(c['t_sent']-c['t_stop']) for c in all_cycles if 't_sent' in c],
        'TOTAL ours (minus claude)':               [ms(c['t_sent']-c['t_stop'])-c['claude_ms'] for c in all_cycles if 't_sent' in c and 'claude_ms' in c],
    }
    print(f"files with cycles: {len(per_file)}, total response cycles: {len(all_cycles)}\n")
    hdr = f"{'leg':44s} {'n':>4s} {'avg':>7s} {'med':>7s} {'p90':>7s} {'min':>6s} {'max':>7s}"
    print(hdr); print('-'*len(hdr))
    for name, vals in legs.items():
        s = stats(vals)
        if not s: print(f"{name:44s} {'—':>4s}"); continue
        print(f"{name:44s} {s['n']:4d} {s['avg']:7.0f} {s['med']:7.0f} {s['p90']:7.0f} {s['min']:6.0f} {s['max']:7.0f}")

    # Per-build breakdown (session-log header: version + git hash) — this is
    # how a fix branch proves itself: accumulate calls on the branch, rerun,
    # compare its row against the baseline builds. Only the headline legs.
    builds = sorted({c['build'] for c in all_cycles})
    if len(builds) > 1:
        print(f"\n{'build':34s} {'leg':28s} {'n':>4s} {'avg':>7s} {'med':>7s} {'p90':>7s}")
        print('-' * 90)
        key_legs = {
            'B2 overshoot': lambda c: c['gate_elapsed']-c['gate_thr'] if 'gate_elapsed' in c else None,
            'E synth': lambda c: ms(c['t_synth']-c['t_speak']) if 't_synth' in c and 't_speak' in c else None,
            'TOTAL stop→audio': lambda c: ms(c['t_sent']-c['t_stop']) if 't_sent' in c else None,
        }
        for b in builds:
            sub = [c for c in all_cycles if c['build'] == b]
            for lname, fn in key_legs.items():
                s = stats([fn(c) for c in sub])
                if not s: continue
                print(f"{b:34s} {lname:28s} {s['n']:4d} {s['avg']:7.0f} {s['med']:7.0f} {s['p90']:7.0f}")

    # Claude think time vs context size (📊 [context] marker, per answering
    # turn). This is the direct test of the "context growth slows replies"
    # hypothesis: if D-claude climbs monotonically with the bucket, trimming
    # baseline context / compacting mid-call are the levers; if it's flat, the
    # cause is elsewhere (model, load, tool detours).
    ctx_cycles = [c for c in all_cycles if c.get('ctx_in') and c.get('claude_ms')]
    if ctx_cycles:
        print(f"\n{'context bucket':20s} {'D claude n':>10s} {'avg':>7s} {'med':>7s} {'p90':>7s}")
        print('-' * 56)
        buckets = sorted({c['ctx_in'] // 10_000 for c in ctx_cycles})
        for b in buckets:
            sub = [c['claude_ms'] for c in ctx_cycles if c['ctx_in'] // 10_000 == b]
            s = stats(sub)
            label = f"{b*10}-{(b+1)*10}K"
            print(f"{label:20s} {s['n']:10d} {s['avg']:7.0f} {s['med']:7.0f} {s['p90']:7.0f}")

    # Per-model breakdown (#agent model= marker, read straight from the driving
    # session's own transcript — see agent-transcript.js). Cycles from before
    # that marker existed carry model=None and are dropped here, not zeroed out.
    models = sorted({c['model'] for c in all_cycles if c.get('model')})
    if len(models) > 1:
        print(f"\n{'model':20s} {'leg':28s} {'n':>4s} {'avg':>7s} {'med':>7s} {'p90':>7s}")
        print('-' * 90)
        key_legs = {
            'B2 overshoot': lambda c: c['gate_elapsed']-c['gate_thr'] if 'gate_elapsed' in c else None,
            'E synth': lambda c: ms(c['t_synth']-c['t_speak']) if 't_synth' in c and 't_speak' in c else None,
            'D claude': lambda c: c.get('claude_ms'),
            'TOTAL stop→audio': lambda c: ms(c['t_sent']-c['t_stop']) if 't_sent' in c else None,
        }
        for mdl in models:
            sub = [c for c in all_cycles if c.get('model') == mdl]
            for lname, fn in key_legs.items():
                s = stats([fn(c) for c in sub])
                if not s: continue
                print(f"{mdl:20s} {lname:28s} {s['n']:4d} {s['avg']:7.0f} {s['med']:7.0f} {s['p90']:7.0f}")
    print()
    return all_cycles

if __name__ == '__main__':
    main(sys.argv[1:])
