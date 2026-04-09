#!/usr/bin/env python3
"""
Similar Performers - pre-compute similarity scores.

Run this as a Stash task. Reads the Stash SQLite database, computes
look-based and scene-tag-based (Jaccard) similarity for every performer,
and writes data/similarity.json which the UI plugin reads instantly.
"""

import json
import math
import os
import sqlite3
import sys

OUTPUT_FILE = 'similarity.json'
TOP_N       = 10


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def open_db(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


# ---------------------------------------------------------------------------
# Looks similarity
# ---------------------------------------------------------------------------

HAIR_PROXIMITY = {
    ('Brunette', 'Auburn'): 0.6, ('Auburn', 'Brunette'): 0.6,
    ('Brunette', 'Black'):  0.4, ('Black',  'Brunette'): 0.4,
    ('Blonde',   'Auburn'): 0.5, ('Auburn', 'Blonde'):   0.5,
}

def gaussian(a, b, sigma):
    if a is None or b is None:
        return 0.0
    d = a - b
    return math.exp(-0.5 * d * d / (sigma * sigma))

def parse_measurements(m):
    if not m:
        return None, None, None
    parts = m.split('-')
    if len(parts) != 3:
        return None, None, None
    try:
        bust  = int(''.join(c for c in parts[0] if c.isdigit()))
        waist = int(parts[1])
        hip   = int(parts[2])
        return bust, waist, hip
    except ValueError:
        return None, None, None

def hair_score(a, b):
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return HAIR_PROXIMITY.get((a, b), 0.0)

def compute_looks(conn):
    rows = conn.execute("""
        SELECT id, name, ethnicity, hair_color, eye_color,
               height, measurements, fake_tits
        FROM performers
        WHERE gender = 'FEMALE'
    """).fetchall()

    # Pre-parse measurements
    parsed = {r['id']: parse_measurements(r['measurements']) for r in rows}

    result = {}
    n = len(rows)

    for i, target in enumerate(rows):
        if i % 500 == 0:
            progress = i / n
            print(json.dumps({'progress': progress}), flush=True)

        if not target['ethnicity'] or not target['measurements']:
            result[str(target['id'])] = []
            continue

        t_bust, t_waist, t_hip = parsed[target['id']]
        scores = []

        for candidate in rows:
            if candidate['id'] == target['id']:
                continue
            if candidate['ethnicity'] != target['ethnicity']:
                continue
            if not candidate['measurements']:
                continue

            c_bust, c_waist, c_hip = parsed[candidate['id']]

            score = (
                0.18 * hair_score(candidate['hair_color'], target['hair_color']) +
                0.10 * (1.0 if candidate['eye_color'] == target['eye_color'] else 0.0) +
                0.10 * (1.0 if candidate['fake_tits']  == target['fake_tits']  else 0.0) +
                0.18 * gaussian(candidate['height'], target['height'], 6.0) +
                0.15 * gaussian(c_bust,  t_bust,  3.0) +
                0.15 * gaussian(c_waist, t_waist, 3.0) +
                0.14 * gaussian(c_hip,   t_hip,   3.0)
            )
            scores.append((candidate['id'], candidate['name'], round(score, 3)))

        scores.sort(key=lambda x: -x[2])
        result[str(target['id'])] = [
            {'id': s[0], 'name': s[1], 'score': s[2]}
            for s in scores[:TOP_N]
        ]

    return result


# ---------------------------------------------------------------------------
# Scene tag Jaccard similarity
# ---------------------------------------------------------------------------

def compute_scenes(conn):
    # Load all scene tags per female performer in one query
    rows = conn.execute("""
        SELECT ps.performer_id, st.tag_id
        FROM performers_scenes ps
        JOIN scenes_tags       st ON ps.scene_id = st.scene_id
        JOIN performers        p  ON ps.performer_id = p.id
        WHERE p.gender = 'FEMALE'
    """).fetchall()

    tag_sets = {}
    for row in rows:
        pid = row[0]
        if pid not in tag_sets:
            tag_sets[pid] = set()
        tag_sets[pid].add(row[1])

    name_map = {
        r['id']: r['name']
        for r in conn.execute("SELECT id, name FROM performers WHERE gender='FEMALE'")
    }

    pids = list(tag_sets.keys())
    n    = len(pids)
    result = {}

    for i, pid in enumerate(pids):
        if i % 500 == 0:
            progress = i / n
            print(json.dumps({'progress': progress}), flush=True)

        target_tags  = tag_sets[pid]
        target_count = len(target_tags)
        scores = []

        for other_id in pids:
            if other_id == pid:
                continue
            other_tags = tag_sets[other_id]
            shared  = len(target_tags & other_tags)
            union   = target_count + len(other_tags) - shared
            jaccard = shared / union if union else 0.0
            scores.append((other_id, jaccard))

        scores.sort(key=lambda x: -x[1])
        result[str(pid)] = [
            {'id': s[0], 'name': name_map.get(s[0], ''), 'score': round(s[1], 3)}
            for s in scores[:TOP_N]
        ]

    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    try:
        plugin_input = json.load(sys.stdin)
        config_dir   = plugin_input['server_connection']['Dir']
        plugin_dir   = plugin_input['server_connection']['PluginDir']
    except Exception:
        config_dir = '/root/.stash'
        plugin_dir = os.path.dirname(os.path.abspath(__file__))

    db_path  = os.path.join(config_dir, 'stash-go.sqlite')
    data_dir = os.path.join(plugin_dir, 'data')
    out_path = os.path.join(data_dir, OUTPUT_FILE)

    os.makedirs(data_dir, exist_ok=True)

    print('[similar-performers] opening database', flush=True)
    conn = open_db(db_path)

    print('[similar-performers] computing looks similarity...', flush=True)
    looks = compute_looks(conn)

    print('[similar-performers] computing scene similarity...', flush=True)
    scenes = compute_scenes(conn)

    print('[similar-performers] writing output...', flush=True)
    with open(out_path, 'w') as f:
        json.dump({'looks': looks, 'scenes': scenes}, f, separators=(',', ':'))

    print(json.dumps({'output': f'wrote {out_path}'}), flush=True)


if __name__ == '__main__':
    main()
