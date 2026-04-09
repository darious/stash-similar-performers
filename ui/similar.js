(function () {
  'use strict';

  const { React } = PluginApi;
  const { useState, useEffect } = React;
  const { gql, useApolloClient } = PluginApi.libraries.Apollo;

  // ---------------------------------------------------------------------------
  // GraphQL queries
  // ---------------------------------------------------------------------------

  // All female performers with physical attributes + scene count (for looks scoring)
  const Q_ALL_PERFORMERS = gql`
    query SimilarLooks($page: Int!) {
      findPerformers(
        filter: { per_page: 500, page: $page }
        performer_filter: { gender: { value: FEMALE, modifier: EQUALS } }
      ) {
        count
        performers {
          id name ethnicity hair_color eye_color
          height_cm measurements fake_tits image_path scene_count
        }
      }
    }
  `;

  // Target performer's scenes: tags (for building tag set) + performers (for phase-1 candidate discovery)
  const Q_TARGET_SCENES = gql`
    query TargetScenes($id: ID!) {
      findScenes(
        scene_filter: { performers: { value: [$id], modifier: INCLUDES_ALL } }
        filter: { per_page: -1 }
      ) {
        scenes {
          id
          tags { id }
          performers { id name image_path }
        }
      }
    }
  `;

  // Scenes containing any of the given tags — used to find candidate performers.
  // Returns tags too so Phase 1 can score by distinct tag coverage (not scene count).
  const Q_SCENES_BY_TAGS = gql`
    query ScenesByTags($tag_ids: [ID!]!) {
      findScenes(
        scene_filter: { tags: { value: $tag_ids, modifier: INCLUDES } }
        filter: { per_page: -1 }
      ) {
        scenes {
          id
          tags { id }
          performers { id name image_path }
        }
      }
    }
  `;

  // Candidate's scenes: tags only (lighter, for phase-2 Jaccard computation)
  const Q_CANDIDATE_TAGSET = gql`
    query CandidateTagSet($id: ID!) {
      findScenes(
        scene_filter: { performers: { value: [$id], modifier: INCLUDES_ALL } }
        filter: { per_page: -1 }
      ) {
        scenes { tags { id } }
      }
    }
  `;

  // ---------------------------------------------------------------------------
  // Session-level JS cache  { key -> results }
  // Lazy-initialising hooks use this so re-mounts skip the loading state entirely
  // ---------------------------------------------------------------------------

  const _cache = {};

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
    const bust = parseInt(parts[0]), waist = parseInt(parts[1]), hip = parseInt(parts[2]);
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
      ? 1 : (HAIR_PROXIMITY[`${candidate.hair_color}|${target.hair_color}`] || 0);
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
  // useSimilarByLooks
  // ---------------------------------------------------------------------------

  function useSimilarByLooks(target) {
    const client    = useApolloClient();
    const cacheKey  = `looks_${target && target.id}`;
    // Lazy init: if already cached this session, start with results immediately
    const [results, setResults] = useState(() => _cache[cacheKey] || null);
    const [error,   setError]   = useState(null);

    useEffect(() => {
      if (!target || _cache[cacheKey]) return;
      let cancelled = false;

      async function run() {
        try {
          let page = 1, all = [], total = null;
          do {
            const res = await client.query({
              query: Q_ALL_PERFORMERS,
              variables: { page },
              fetchPolicy: 'cache-first',
            });
            const { count, performers } = res.data.findPerformers;
            total = count;
            all   = all.concat(performers);
            page++;
          } while (all.length < total);

          _cache.allPerformers = all; // share with scene hook

          const scored = all
            .filter(p => p.id !== String(target.id) && p.measurements)
            .map(p => ({ ...p, score: lookScore(target, p) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);

          // Always cache regardless of navigation state
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
  // useSimilarByScenes — two-phase true Jaccard
  //
  // Phase 1: get target's scene tags → pick distinctive ones (5–60% frequency)
  //          → find performers who independently appear in scenes with those tags
  //          → top 50 candidates by weighted tag-scene count
  //
  // Phase 2: for each candidate fetch their full scene tag set (parallel, Apollo
  //          caches each individually) → compute true Jaccard vs target tag set
  // ---------------------------------------------------------------------------

  function useSimilarByScenes(target) {
    const client   = useApolloClient();
    const cacheKey = `scenes_${target && target.id}`;
    const [results, setResults] = useState(() => _cache[cacheKey] || null);
    const [error,   setError]   = useState(null);
    const [status,  setStatus]  = useState('');

    useEffect(() => {
      if (!target || _cache[cacheKey]) return;
      let cancelled = false;

      async function run() {
        try {
          // ── Phase 1a: build target's tag set ─────────────────────────────
          if (!cancelled) setStatus('Fetching scene tags\u2026');

          const res1 = await client.query({
            query: Q_TARGET_SCENES,
            variables: { id: String(target.id) },
            fetchPolicy: 'cache-first',
          });
          const targetScenes = res1.data.findScenes.scenes;
          const totalScenes  = targetScenes.length;
          if (!totalScenes) { setResults([]); return; }

          const targetTagSet = new Set();
          const tagCounts    = {};
          for (const scene of targetScenes) {
            for (const tag of scene.tags) {
              targetTagSet.add(tag.id);
              tagCounts[tag.id] = (tagCounts[tag.id] || 0) + 1;
            }
          }

          // Distinctive tags: appear in 5–60% of target's scenes.
          // Skips universal tags (blowjob, doggy etc.) that add no signal.
          // Use the 15 most characteristic (highest frequency within the band)
          // to keep Q_SCENES_BY_TAGS response manageable.
          const minFreq = Math.max(2, totalScenes * 0.05);
          const maxFreq = totalScenes * 0.60;
          const distinctiveTags = Object.entries(tagCounts)
            .filter(([, n]) => n >= minFreq && n <= maxFreq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([id]) => id);

          if (!distinctiveTags.length) { setResults([]); return; }

          const distinctiveTagSet = new Set(distinctiveTags);

          // ── Phase 1b: find performers who appear in scenes with those tags ─
          // Score by how many DISTINCT distinctive tags appear in their scenes —
          // not how many scenes they have. This avoids prolific performers dominating.
          if (!cancelled) setStatus('Finding similar performers\u2026');

          const res2 = await client.query({
            query: Q_SCENES_BY_TAGS,
            variables: { tag_ids: distinctiveTags },
            fetchPolicy: 'cache-first',
          });

          const targetId           = String(target.id);
          const performerTagCoverage = {};  // { performerId: Set<distinctiveTagId> }
          const performerMap         = {};

          for (const scene of res2.data.findScenes.scenes) {
            // Which of the distinctive tags does this scene have?
            const sceneDTags = scene.tags
              .map(t => t.id)
              .filter(id => distinctiveTagSet.has(id));

            for (const p of scene.performers) {
              if (p.id === targetId) continue;
              if (!performerTagCoverage[p.id]) performerTagCoverage[p.id] = new Set();
              for (const tagId of sceneDTags) performerTagCoverage[p.id].add(tagId);
              performerMap[p.id] = p;
            }
          }

          // Fill image_path from allPerformers cache if looks hook ran first
          const allPerformers = _cache.allPerformers || [];
          for (const p of allPerformers) {
            if (!performerMap[p.id]) performerMap[p.id] = p;
          }

          if (cancelled) return;

          // Top 100 candidates ranked by number of distinct distinctive tags covered.
          // A performer who covers 14/15 of target's characteristic tags ranks above
          // one with 500 scenes who only covers 5/15.
          const topCandidates = Object.entries(performerTagCoverage)
            .sort((a, b) => b[1].size - a[1].size)
            .slice(0, 100)
            .map(([id]) => id);

          if (!topCandidates.length) { setResults([]); return; }

          // ── Phase 2: fetch each candidate's full tag set in parallel ──────
          if (!cancelled) setStatus(`Scoring ${topCandidates.length} candidates\u2026`);

          const tagSetResults = await Promise.all(
            topCandidates.map(id =>
              client.query({
                query: Q_CANDIDATE_TAGSET,
                variables: { id },
                fetchPolicy: 'cache-first',
              }).then(res => {
                const tagSet = new Set();
                for (const scene of res.data.findScenes.scenes) {
                  for (const tag of scene.tags) tagSet.add(tag.id);
                }
                return { id, tagSet };
              })
            )
          );

          // ── True Jaccard ─────────────────────────────────────────────────
          const scored = tagSetResults.map(({ id, tagSet }) => {
            let shared = 0;
            for (const tagId of targetTagSet) {
              if (tagSet.has(tagId)) shared++;
            }
            const union   = targetTagSet.size + tagSet.size - shared;
            const jaccard = union > 0 ? shared / union : 0;
            return {
              ...(performerMap[id] || { id, name: id, image_path: '' }),
              score: Math.round(jaccard * 1000) / 1000,
            };
          });

          const top10 = scored.sort((a, b) => b.score - a.score).slice(0, 10);

          // Always write cache — even if the component unmounted while loading.
          // This ensures re-visits are instant regardless of when user navigated away.
          _cache[cacheKey] = top10;
          if (!cancelled) { setResults(top10); setStatus(''); }

        } catch (e) {
          if (!cancelled) setError(e.message);
        }
      }
      run();
      return () => { cancelled = true; };
    }, [target && target.id]);

    return { results, error, status };
  }

  // ---------------------------------------------------------------------------
  // PerformerThumb
  // ---------------------------------------------------------------------------

  function PerformerThumb({ performer, mode }) {
    const pct        = Math.round(performer.score * 100);
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
          marginTop: '6px', fontSize: '11px', textAlign: 'center', lineHeight: '1.3',
          maxWidth: '100px', overflow: 'hidden',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        },
      }, performer.name),
      React.createElement('span', {
        style: { marginTop: '3px', fontSize: '10px', fontWeight: 'bold', color: scoreColor },
      }, `${pct}%`)
    );
  }

  // ---------------------------------------------------------------------------
  // Row renderers
  // ---------------------------------------------------------------------------

  function small(text) {
    return React.createElement('p', {
      style: { fontSize: '12px', color: '#888', margin: 0 },
    }, text);
  }

  function SimilarLooksRow({ target }) {
    const { results, error } = useSimilarByLooks(target);
    const label = 'Similar by Look';
    if (error)    return rowWrap(label, small('Error: ' + error));
    if (!results) return rowWrap(label, small('Loading\u2026'));
    if (!results.length) return rowWrap(label, small('No matches found.'));
    return rowWrap(label,
      React.createElement('div', {
        style: { display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '6px' },
      }, results.map(r => React.createElement(PerformerThumb, { key: r.id, performer: r, mode: 'looks' })))
    );
  }

  function SimilarScenesRow({ target }) {
    const { results, error, status } = useSimilarByScenes(target);
    const label = 'Similar by Scene Type';
    if (error)    return rowWrap(label, small('Error: ' + error));
    if (!results) return rowWrap(label, small(status || 'Loading\u2026'));
    if (!results.length) return rowWrap(label, small('No matches found.'));
    return rowWrap(label,
      React.createElement('div', {
        style: { display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '6px' },
      }, results.map(r => React.createElement(PerformerThumb, { key: r.id, performer: r, mode: 'scenes' })))
    );
  }

  function rowWrap(label, content) {
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
  // Patch
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
