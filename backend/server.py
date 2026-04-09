#!/usr/bin/env python3
"""
Similar Performers - local HTTP server
Serves similarity scores for performers based on:
  - looks: physical attributes (ethnicity, hair, eyes, height, measurements, fake_tits)
  - scenes: scene tag overlap (Jaccard similarity)
"""

import json
import math
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 9666
DB_PATH = None  # resolved from stash config at startup


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ---------------------------------------------------------------------------
# Scoring helpers
# ---------------------------------------------------------------------------

def gaussian(a, b, sigma=6.0):
    if a is None or b is None:
        return 0.0
    diff = a - b
    return math.exp(-0.5 * diff * diff / (sigma * sigma))


def parse_measurements(m):
    """Parse '34B-25-36' -> (34, 25, 36). Returns (None,None,None) on failure."""
    if not m:
        return None, None, None
    try:
        parts = m.split('-')
        if len(parts) != 3:
            return None, None, None
        bust_str = parts[0]
        bust_num = int(''.join(c for c in bust_str if c.isdigit()))
        waist = int(parts[1])
        hip = int(parts[2])
        return bust_num, waist, hip
    except (ValueError, IndexError):
        return None, None, None


HAIR_PROXIMITY = {
    ('Brunette', 'Auburn'): 0.6,
    ('Auburn', 'Brunette'): 0.6,
    ('Brunette', 'Black'):  0.4,
    ('Black',   'Brunette'): 0.4,
    ('Blonde',  'Auburn'):  0.5,
    ('Auburn',  'Blonde'):  0.5,
}


def hair_score(a, b):
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return HAIR_PROXIMITY.get((a, b), 0.0)


# ---------------------------------------------------------------------------
# Similarity queries
# ---------------------------------------------------------------------------

def similar_by_looks(performer_id, limit=10):
    db = get_db()

    target = db.execute(
        "SELECT ethnicity, hair_color, eye_color, height, measurements, fake_tits "
        "FROM performers WHERE id = ?", (performer_id,)
    ).fetchone()

    if not target:
        return []

    t_bust, t_waist, t_hip = parse_measurements(target['measurements'])

    rows = db.execute("""
        SELECT id, name, ethnicity, hair_color, eye_color, height, measurements,
               fake_tits, image_blob
        FROM performers
        WHERE id != ?
          AND gender = 'FEMALE'
          AND ethnicity = ?
          AND measurements IS NOT NULL AND measurements != ''
    """, (performer_id, target['ethnicity'])).fetchall()

    results = []
    for r in rows:
        r_bust, r_waist, r_hip = parse_measurements(r['measurements'])

        score = (
            0.18 * hair_score(r['hair_color'], target['hair_color']) +
            0.10 * (1.0 if r['eye_color']  == target['eye_color']  else 0.0) +
            0.10 * (1.0 if r['fake_tits']  == target['fake_tits']  else 0.0) +
            0.18 * gaussian(r['height'],  target['height'],  sigma=6.0) +
            0.15 * gaussian(r_bust,       t_bust,            sigma=3.0) +
            0.15 * gaussian(r_waist,      t_waist,           sigma=3.0) +
            0.14 * gaussian(r_hip,        t_hip,             sigma=3.0)
        )

        results.append({
            'id':           r['id'],
            'name':         r['name'],
            'hair_color':   r['hair_color'],
            'eye_color':    r['eye_color'],
            'height':       r['height'],
            'measurements': r['measurements'],
            'fake_tits':    r['fake_tits'],
            'score':        round(score, 4),
        })

    results.sort(key=lambda x: x['score'], reverse=True)
    return results[:limit]


def similar_by_scenes(performer_id, limit=10):
    db = get_db()

    # Get target's scene tag set
    target_tags = set(
        row[0] for row in db.execute("""
            SELECT DISTINCT st.tag_id
            FROM performers_scenes ps
            JOIN scenes_tags st ON ps.scene_id = st.scene_id
            WHERE ps.performer_id = ?
        """, (performer_id,)).fetchall()
    )

    if not target_tags:
        return []

    target_count = len(target_tags)

    # Get all other female performers' tag sets
    rows = db.execute("""
        SELECT ps.performer_id, COUNT(DISTINCT st.tag_id) as tag_count
        FROM performers_scenes ps
        JOIN scenes_tags st ON ps.scene_id = st.scene_id
        JOIN performers p ON ps.performer_id = p.id
        WHERE ps.performer_id != ? AND p.gender = 'FEMALE'
        GROUP BY ps.performer_id
    """, (performer_id,)).fetchall()

    # Get intersections
    intersections = db.execute("""
        SELECT ps.performer_id, COUNT(DISTINCT st.tag_id) as shared
        FROM performers_scenes ps
        JOIN scenes_tags st ON ps.scene_id = st.scene_id
        WHERE ps.performer_id != ?
          AND st.tag_id IN ({})
        GROUP BY ps.performer_id
    """.format(','.join('?' * target_count)),
        (performer_id, *target_tags)
    ).fetchall()

    intersection_map = {r['performer_id']: r['shared'] for r in intersections}
    tag_count_map    = {r['performer_id']: r['tag_count'] for r in rows}

    # Fetch performer names
    ids = list(tag_count_map.keys())
    performers = {
        r['id']: r for r in db.execute(
            "SELECT id, name, hair_color, ethnicity FROM performers WHERE id IN ({})".format(
                ','.join('?' * len(ids))
            ), ids
        ).fetchall()
    }

    results = []
    for pid, their_count in tag_count_map.items():
        shared = intersection_map.get(pid, 0)
        union  = target_count + their_count - shared
        jaccard = shared / union if union > 0 else 0.0

        p = performers.get(pid)
        if not p:
            continue

        results.append({
            'id':          pid,
            'name':        p['name'],
            'hair_color':  p['hair_color'],
            'ethnicity':   p['ethnicity'],
            'shared_tags': shared,
            'their_tags':  their_count,
            'score':       round(jaccard, 4),
        })

    results.sort(key=lambda x: x['score'], reverse=True)
    return results[:limit]


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        pass  # suppress default access log

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == '/health':
            self.send_json({'status': 'ok'})
            return

        if parsed.path == '/similar':
            try:
                performer_id = int(params.get('id', [None])[0])
            except (TypeError, ValueError):
                self.send_json({'error': 'missing or invalid id'}, 400)
                return

            mode  = params.get('mode',  ['looks'])[0]
            limit = int(params.get('limit', [10])[0])

            if mode == 'looks':
                results = similar_by_looks(performer_id, limit)
            elif mode == 'scenes':
                results = similar_by_scenes(performer_id, limit)
            else:
                self.send_json({'error': 'mode must be looks or scenes'}, 400)
                return

            self.send_json({'performer_id': performer_id, 'mode': mode, 'results': results})
            return

        self.send_json({'error': 'not found'}, 404)


# ---------------------------------------------------------------------------
# Entry point — reads stash plugin input from stdin
# ---------------------------------------------------------------------------

def main():
    global DB_PATH

    try:
        plugin_input = json.load(sys.stdin)
        config_dir   = plugin_input['server_connection']['Dir']
        DB_PATH      = f"{config_dir}/stash-go.sqlite"
    except Exception:
        # fallback for direct invocation during development
        DB_PATH = '/mnt/arasaka/stash-go.sqlite'

    print(f"[similar-performers] starting on port {PORT}, db={DB_PATH}", flush=True)

    server = HTTPServer(('127.0.0.1', PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
