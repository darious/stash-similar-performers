(function () {
  'use strict';

  const { React } = PluginApi;
  const { useState, useEffect, useRef } = React;
  const { gql, useApolloClient } = PluginApi.libraries.Apollo;

  // ---------------------------------------------------------------------------
  // GraphQL query strings
  // ---------------------------------------------------------------------------

  const Q_ALL_PERFORMERS = gql`
    query SimilarLooks($page: Int!) {
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
          scene_count
        }
      }
    }
  `;

  const Q_PERFORMER_SCENES = gql`
    query SimilarSceneTags($id: ID!) {
      findScenes(
        scene_filter: { performers: { value: [$id], modifier: INCLUDES_ALL } }
        filter: { per_page: -1 }
      ) {
        scenes {
          tags { id }
          performers { id name image_path }
        }
      }
    }
  `;

  const Q_SCENES_BY_TAGS = gql`
    query SimilarByTags($tag_ids: [ID!]!) {
      findScenes(
        scene_filter: { tags: { value: $tag_ids, modifier: INCLUDES } }
        filter: { per_page: -1 }
      ) {
        scenes {
          id
          performers { id name image_path }
        }
      }
    }
  `;

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

  function lookScore(target, candidate) {
    if (!candidate.ethnicity || candidate.ethnicity !== target.ethnicity) return 0;
    const tm = parseMeasurements(target.measurements);
    const cm = parseMeasurements(candidate.measurements);
    const hairSim = candidate.hair_color === target.hair_color
      ? 1
      : (HAIR_PROXIMITY[`${candidate.hair_color}|${target.hair_color}`] || 0);
    return (
      0.18 * hairSim +
      0.10 * (candidate.eye_color === target.eye_color ? 1 : 0) +
      0.10 * (candidate.fake_tits  === target.fake_tits  ? 1 : 0) +
      0.18 * gaussian(candidate.height_cm, target.height_cm, 6) +
      0.15 * (tm && cm ? gaussian(cm.bust,  tm.bust,  3) : 0) +
      0.15 * (tm && cm ? gaussian(cm.waist, tm.waist, 3) : 0) +
      0.14 * (tm && cm ? gaussian(cm.hip,   tm.hip,   3) : 0)
    );
  }

  // ---------------------------------------------------------------------------
  // Session-level cache
  // ---------------------------------------------------------------------------

  const _cache = {};

  // ---------------------------------------------------------------------------
  // useSimilarByLooks — fetches all performers (paginated) and scores them
  // ---------------------------------------------------------------------------

  function useSimilarByLooks(target) {
    const client = useApolloClient();
    const [results, setResults] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
      if (!target) return;
      const cacheKey = `looks_${target.id}`;
      if (_cache[cacheKey]) { setResults(_cache[cacheKey]); return; }

      let cancelled = false;

      async function run() {
        try {
          let page = 1, all = [], total = null;
          do {
            const res = await client.query({ query: Q_ALL_PERFORMERS, variables: { page } });
            const { count, performers } = res.data.findPerformers;
            total = count;
            all = all.concat(performers);
            page++;
          } while (all.length < total);

          const scored = all
            .filter(p => p.id !== String(target.id) && p.measurements)
            .map(p => ({ ...p, score: lookScore(target, p) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);

          _cache[cacheKey] = scored;
          if (!cancelled) setResults(scored);
        } catch (e) {
          if (!cancelled) setError(e.message);
        }
      }
      run();
      return () => { cancelled = true; };
    }, [target && target.id]);

    return { results, error };
  }

  // ---------------------------------------------------------------------------
  // useSimilarByScenes
  // Step 1: get target's scenes → compute distinctive tags (5–60% frequency)
  // Step 2: find scenes with those tags → score candidates by
  //         unique matching scenes / log(1 + their total scene count)
  //         This penalises prolific performers who just appear everywhere.
  // ---------------------------------------------------------------------------

  function useSimilarByScenes(target) {
    const client = useApolloClient();
    const [results, setResults] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
      if (!target) return;
      const cacheKey = `scenes_${target.id}`;
      if (_cache[cacheKey]) { setResults(_cache[cacheKey]); return; }

      let cancelled = false;

      async function run() {
        try {
          // Step 1: get target performer's scenes with tags
          const res1 = await client.query({
            query: Q_PERFORMER_SCENES,
            variables: { id: String(target.id) },
          });
          const scenes = res1.data.findScenes.scenes;
          const totalScenes = scenes.length;
          if (!totalScenes) { setResults([]); return; }

          // Count how often each tag appears across target's scenes
          const tagCounts = {};
          for (const scene of scenes) {
            for (const tag of scene.tags) {
              tagCounts[tag.id] = (tagCounts[tag.id] || 0) + 1;
            }
          }

          // Keep tags that appear in 5–60% of target's scenes.
          // Too common (>60%) = generic (blowjob, doggy style, etc.)
          // Too rare (<5%)   = noise / one-off scenes
          const minFreq = Math.max(2, totalScenes * 0.05);
          const maxFreq = totalScenes * 0.60;

          const distinctiveTags = Object.entries(tagCounts)
            .filter(([, count]) => count >= minFreq && count <= maxFreq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 40)
            .map(([id]) => id);

          if (!distinctiveTags.length) { setResults([]); return; }

          // Step 2: find scenes containing those tags
          const res2 = await client.query({
            query: Q_SCENES_BY_TAGS,
            variables: { tag_ids: distinctiveTags },
          });

          const targetId = String(target.id);

          // For each candidate, collect the unique scene IDs they share
          // (avoid counting the same scene twice if it has multiple matching tags)
          const candidateScenes = {};  // { performerId: Set<sceneId> }
          const performerInfo  = {};

          for (const scene of res2.data.findScenes.scenes) {
            for (const p of scene.performers) {
              if (p.id === targetId) continue;
              if (!candidateScenes[p.id]) candidateScenes[p.id] = new Set();
              candidateScenes[p.id].add(scene.id);
              performerInfo[p.id] = p;
            }
          }

          // We need each candidate's total scene count for normalisation.
          // Pull from the already-cached allPerformers list where possible.
          const allPerformers = _cache.allPerformers || [];
          const sceneCountMap = {};
          for (const p of allPerformers) sceneCountMap[p.id] = p.scene_count || 1;

          const scored = Object.entries(candidateScenes)
            .map(([id, sceneSet]) => {
              const sharedScenes   = sceneSet.size;
              const totalCandidate = sceneCountMap[id] || 1;
              // Normalise: shared scenes as a fraction of candidate's career,
              // divided by log to dampen the advantage of very prolific performers
              const score = sharedScenes / Math.log(1 + totalCandidate);
              return { ...performerInfo[id], score };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);

          // Normalise scores to 0–1 range
          const maxScore = scored[0] ? scored[0].score : 1;
          const normalised = scored.map(p => ({ ...p, score: Math.round((p.score / maxScore) * 100) / 100 }));

          _cache[cacheKey] = normalised;
          if (!cancelled) setResults(normalised);
        } catch (e) {
          if (!cancelled) setError(e.message);
        }
      }
      run();
      return () => { cancelled = true; };
    }, [target && target.id]);

    return { results, error };
  }

  // ---------------------------------------------------------------------------
  // PerformerThumb
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
        },
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
        },
      }, performer.name),
      React.createElement('span', {
        style: { marginTop: '3px', fontSize: '10px', fontWeight: 'bold', color: scoreColor },
      }, `${pct}%`)
    );
  }

  // ---------------------------------------------------------------------------
  // SimilarRow
  // ---------------------------------------------------------------------------

  function SimilarLooksRow({ target }) {
    const { results, error } = useSimilarByLooks(target);
    return renderRow('Similar by Look', 'looks', results, error);
  }

  function SimilarScenesRow({ target }) {
    const { results, error } = useSimilarByScenes(target);
    return renderRow('Similar by Scene Type', 'scenes', results, error);
  }

  function renderRow(label, mode, results, error) {
    let content;
    if (error) {
      content = React.createElement('p', {
        style: { fontSize: '12px', color: '#888', margin: 0 },
      }, 'Error: ' + error);
    } else if (!results) {
      content = React.createElement('p', {
        style: { fontSize: '12px', color: '#888', margin: 0 },
      }, 'Loading\u2026');
    } else if (!results.length) {
      content = React.createElement('p', {
        style: { fontSize: '12px', color: '#888', margin: 0 },
      }, 'No matches found.');
    } else {
      content = React.createElement('div', {
        style: { display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '6px' },
      }, results.map(r => React.createElement(PerformerThumb, { key: r.id, performer: r, mode })));
    }

    return React.createElement('div', { style: { marginTop: '16px' } },
      React.createElement('div', {
        style: {
          fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase',
          letterSpacing: '0.06em', color: '#aaa', marginBottom: '10px',
        },
      }, label),
      content
    );
  }

  // ---------------------------------------------------------------------------
  // SimilarPerformersPanel
  // ---------------------------------------------------------------------------

  function SimilarPerformersPanel({ performer }) {
    return React.createElement('div', {
      style: { borderTop: '1px solid #333', marginTop: '20px', paddingTop: '16px' },
    },
      React.createElement('div', {
        style: { fontSize: '14px', fontWeight: 'bold', marginBottom: '4px' },
      }, 'Similar Performers'),
      React.createElement(SimilarLooksRow,  { target: performer }),
      React.createElement(SimilarScenesRow, { target: performer })
    );
  }

  // ---------------------------------------------------------------------------
  // Patch into performer detail page using patch.instead
  // ---------------------------------------------------------------------------

  PluginApi.patch.instead('PerformerDetailsPanel.DetailGroup', function (props, _, original) {
    const rendered = original(props);
    if (!props || !props.performer) return rendered;
    return React.createElement(React.Fragment, null,
      rendered,
      React.createElement(SimilarPerformersPanel, { performer: props.performer })
    );
  });

})();
