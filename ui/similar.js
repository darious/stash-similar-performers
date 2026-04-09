(function () {
  'use strict';

  const { React } = PluginApi;
  const { useState, useEffect, useRef } = React;

  // ---------------------------------------------------------------------------
  // GraphQL queries
  // ---------------------------------------------------------------------------

  // Fetch all female performers with physical attributes for look scoring
  const QUERY_ALL_PERFORMERS = `
    query SimilarPerformersLooks($page: Int!) {
      findPerformers(
        filter: { per_page: 500, page: $page }
        performer_filter: { gender: { value: FEMALE, modifier: EQUALS } }
      ) {
        count
        performers {
          id
          name
          ethnicity
          hair_color
          eye_color
          height_cm
          measurements
          fake_tits
          image_path
        }
      }
    }
  `;

  // Fetch scene tags for a specific performer
  const QUERY_PERFORMER_SCENE_TAGS = `
    query SimilarPerformerSceneTags($performer_id: ID!) {
      findScenes(
        scene_filter: { performers: { value: [$performer_id], modifier: INCLUDES_ALL } }
        filter: { per_page: -1 }
      ) {
        scenes {
          tags { id }
        }
      }
    }
  `;

  async function gqlQuery(query, variables) {
    const res = await PluginApi.GQL.client.query({ query: PluginApi.GQL.gql(query), variables });
    return res.data;
  }

  // ---------------------------------------------------------------------------
  // Scoring helpers
  // ---------------------------------------------------------------------------

  function gaussian(a, b, sigma) {
    if (a == null || b == null) return 0;
    const d = a - b;
    return Math.exp(-0.5 * d * d / (sigma * sigma));
  }

  function parseMeasurements(m) {
    if (!m) return null;
    const parts = m.split('-');
    if (parts.length !== 3) return null;
    const bust = parseInt(parts[0]);
    const waist = parseInt(parts[1]);
    const hip = parseInt(parts[2]);
    if (isNaN(bust) || isNaN(waist) || isNaN(hip)) return null;
    return { bust, waist, hip };
  }

  const HAIR_PROXIMITY = {
    'Brunette|Auburn': 0.6, 'Auburn|Brunette': 0.6,
    'Brunette|Black':  0.4, 'Black|Brunette':  0.4,
    'Blonde|Auburn':   0.5, 'Auburn|Blonde':   0.5,
  };

  function hairScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    return HAIR_PROXIMITY[`${a}|${b}`] || 0;
  }

  function lookScore(target, candidate) {
    if (candidate.ethnicity !== target.ethnicity) return 0;

    const tm = parseMeasurements(target.measurements);
    const cm = parseMeasurements(candidate.measurements);

    return (
      0.18 * hairScore(candidate.hair_color, target.hair_color) +
      0.10 * (candidate.eye_color === target.eye_color ? 1 : 0) +
      0.10 * (candidate.fake_tits  === target.fake_tits  ? 1 : 0) +
      0.18 * gaussian(candidate.height_cm, target.height_cm, 6) +
      0.15 * (tm && cm ? gaussian(cm.bust,  tm.bust,  3) : 0) +
      0.15 * (tm && cm ? gaussian(cm.waist, tm.waist, 3) : 0) +
      0.14 * (tm && cm ? gaussian(cm.hip,   tm.hip,   3) : 0)
    );
  }

  function jaccardScore(setA, setB) {
    if (!setA.size || !setB.size) return 0;
    let shared = 0;
    for (const id of setA) { if (setB.has(id)) shared++; }
    return shared / (setA.size + setB.size - shared);
  }

  // ---------------------------------------------------------------------------
  // Data fetching with simple session cache
  // ---------------------------------------------------------------------------

  const _cache = {};

  async function getAllPerformers() {
    if (_cache.allPerformers) return _cache.allPerformers;

    let page = 1, all = [], total = null;
    do {
      const data = await gqlQuery(QUERY_ALL_PERFORMERS, { page });
      const { count, performers } = data.findPerformers;
      total = count;
      all = all.concat(performers);
      page++;
    } while (all.length < total);

    _cache.allPerformers = all;
    return all;
  }

  async function getPerformerSceneTags(performerId) {
    const key = `tags_${performerId}`;
    if (_cache[key]) return _cache[key];

    const data = await gqlQuery(QUERY_PERFORMER_SCENE_TAGS, { performer_id: String(performerId) });
    const tagSet = new Set();
    for (const scene of data.findScenes.scenes) {
      for (const tag of scene.tags) tagSet.add(tag.id);
    }
    _cache[key] = tagSet;
    return tagSet;
  }

  // ---------------------------------------------------------------------------
  // Top N by look score (pure client-side, no extra queries needed)
  // ---------------------------------------------------------------------------

  async function getSimilarByLooks(target, limit = 10) {
    const all = await getAllPerformers();
    return all
      .filter(p => p.id !== target.id && p.measurements)
      .map(p => ({ ...p, score: lookScore(target, p) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Top N by scene tag Jaccard — fetches tags for top candidates only
  // ---------------------------------------------------------------------------

  async function getSimilarByScenes(target, limit = 10) {
    const targetTags = await getPerformerSceneTags(target.id);
    if (!targetTags.size) return [];

    const all = await getAllPerformers();

    // Fetch scene tags for all candidates in parallel (batches of 20)
    const candidates = all.filter(p => p.id !== target.id);
    const BATCH = 20;
    const tagSets = {};

    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(p => getPerformerSceneTags(p.id).then(tags => ({ id: p.id, tags })))
      );
      for (const r of results) tagSets[r.id] = r.tags;
    }

    return candidates
      .map(p => ({ ...p, score: jaccardScore(targetTags, tagSets[p.id] || new Set()) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // PerformerThumb component
  // ---------------------------------------------------------------------------

  function PerformerThumb({ performer, mode }) {
    const pct = Math.round(performer.score * 100);
    const scoreColor = mode === 'looks' ? '#e8a838' : '#5ba4cf';

    return React.createElement('a',
      {
        href: `/performers/${performer.id}`,
        style: {
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          width: '110px', flexShrink: 0, textDecoration: 'none', color: 'inherit',
        }
      },
      React.createElement('img', {
        src: performer.image_path,
        alt: performer.name,
        style: {
          width: '90px', height: '120px', objectFit: 'cover',
          borderRadius: '6px', background: '#2a2a2a',
        },
        onError: (e) => { e.target.style.visibility = 'hidden'; },
      }),
      React.createElement('span', {
        style: {
          marginTop: '6px', fontSize: '11px', textAlign: 'center',
          lineHeight: '1.3', maxWidth: '100px', overflow: 'hidden',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        }
      }, performer.name),
      React.createElement('span', {
        style: { marginTop: '3px', fontSize: '10px', fontWeight: 'bold', color: scoreColor }
      }, `${pct}%`)
    );
  }

  // ---------------------------------------------------------------------------
  // SimilarRow component
  // ---------------------------------------------------------------------------

  function SimilarRow({ target, mode, label }) {
    const [results, setResults] = useState(null);
    const [error,   setError]   = useState(null);
    const mounted = useRef(true);

    useEffect(() => {
      mounted.current = true;
      setResults(null);
      setError(null);

      const fn = mode === 'looks' ? getSimilarByLooks : getSimilarByScenes;
      fn(target).then(r => {
        if (mounted.current) setResults(r);
      }).catch(e => {
        if (mounted.current) setError(e.message);
      });

      return () => { mounted.current = false; };
    }, [target.id, mode]);

    const placeholder = (text) => React.createElement('p', {
      style: { fontSize: '12px', color: '#888', padding: '8px 0', margin: 0 }
    }, text);

    let content;
    if (error)          content = placeholder(`Error: ${error}`);
    else if (!results)  content = placeholder('Loading…');
    else if (!results.length) content = placeholder('No matches found.');
    else content = React.createElement('div', {
      style: { display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '6px' }
    }, ...results.map(r =>
      React.createElement(PerformerThumb, { key: r.id, performer: r, mode })
    ));

    return React.createElement('div', { style: { marginTop: '16px' } },
      React.createElement('div', {
        style: {
          fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase',
          letterSpacing: '0.06em', color: '#aaa', marginBottom: '10px',
        }
      }, label),
      content
    );
  }

  // ---------------------------------------------------------------------------
  // SimilarPerformersPanel — injected below performer details
  // ---------------------------------------------------------------------------

  function SimilarPerformersPanel({ performer }) {
    return React.createElement('div', {
      style: { borderTop: '1px solid #333', marginTop: '20px', paddingTop: '16px' }
    },
      React.createElement('div', {
        style: { fontSize: '14px', fontWeight: 'bold', marginBottom: '4px' }
      }, 'Similar Performers'),
      React.createElement(SimilarRow, { target: performer, mode: 'looks',  label: 'Similar by Look' }),
      React.createElement(SimilarRow, { target: performer, mode: 'scenes', label: 'Similar by Scene Type' })
    );
  }

  // ---------------------------------------------------------------------------
  // Patch into performer detail page
  // ---------------------------------------------------------------------------

  PluginApi.patch.after('PerformerDetailsPanel.DetailGroup', function (props, rendered) {
    if (!props || !props.performer) return rendered;
    return React.createElement(React.Fragment, null,
      rendered,
      React.createElement(SimilarPerformersPanel, { performer: props.performer })
    );
  });

})();
