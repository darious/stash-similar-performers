(function () {
  'use strict';

  const { React } = PluginApi;
  const { useState, useEffect } = React;

  const DATA_URL = '/plugin/similar-performers/data/similarity.json';

  // ---------------------------------------------------------------------------
  // Load the pre-computed similarity data (once per session)
  // ---------------------------------------------------------------------------

  let _data     = null;   // { looks: {id: [...]}, scenes: {id: [...]} }
  let _loading  = null;   // in-flight Promise, prevents duplicate fetches

  function loadData() {
    if (_data)    return Promise.resolve(_data);
    if (_loading) return _loading;

    _loading = fetch(DATA_URL)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching similarity data`);
        return r.json();
      })
      .then(d => {
        _data    = d;
        _loading = null;
        return d;
      })
      .catch(e => {
        _loading = null;
        throw e;
      });

    return _loading;
  }

  // ---------------------------------------------------------------------------
  // Hook: useSimliar(performerId, mode)
  // ---------------------------------------------------------------------------

  function useSimilar(performerId, mode) {
    const id = String(performerId);

    // Seed state from already-loaded data immediately (no loading flash on re-visit)
    const [results, setResults] = useState(() =>
      _data ? (_data[mode][id] || []) : null
    );
    const [error, setError] = useState(null);

    useEffect(() => {
      if (!performerId) return;
      if (_data) {
        setResults(_data[mode][id] || []);
        return;
      }

      let cancelled = false;
      loadData()
        .then(d => { if (!cancelled) setResults(d[mode][id] || []); })
        .catch(e => { if (!cancelled) setError(e.message); });
      return () => { cancelled = true; };
    }, [id, mode]);

    return { results, error };
  }

  // ---------------------------------------------------------------------------
  // PerformerThumb
  // ---------------------------------------------------------------------------

  function PerformerThumb({ result, mode }) {
    const pct        = Math.round(result.score * 100);
    const scoreColor = mode === 'looks' ? '#e8a838' : '#5ba4cf';

    return React.createElement('a',
      {
        href: `/performers/${result.id}`,
        style: {
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          width: '110px', flexShrink: 0, textDecoration: 'none', color: 'inherit',
        },
      },
      React.createElement('img', {
        src:   `/performer/${result.id}/image`,
        alt:   result.name,
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
      }, result.name),
      React.createElement('span', {
        style: { marginTop: '3px', fontSize: '10px', fontWeight: 'bold', color: scoreColor },
      }, `${pct}%`)
    );
  }

  // ---------------------------------------------------------------------------
  // SimilarRow
  // ---------------------------------------------------------------------------

  function SimilarRow({ performerId, mode, label }) {
    const { results, error } = useSimilar(performerId, mode);

    let content;
    if (error) {
      content = React.createElement('p', {
        style: { fontSize: '12px', color: '#888', margin: 0 },
      }, `No data yet \u2014 run "Compute Similarities" from Settings \u203a Tasks. (${error})`);
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
      }, results.map(r =>
        React.createElement(PerformerThumb, { key: r.id, result: r, mode })
      ));
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
      React.createElement(SimilarRow, {
        performerId: performer.id, mode: 'looks', label: 'Similar by Look',
      }),
      React.createElement(SimilarRow, {
        performerId: performer.id, mode: 'scenes', label: 'Similar by Scene Type',
      })
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
