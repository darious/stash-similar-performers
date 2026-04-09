(function () {
  'use strict';

  const API_BASE = 'http://127.0.0.1:9666';
  const LIMIT    = 10;

  const { React, ReactDOM } = PluginApi;
  const { useState, useEffect } = React;

  // ---------------------------------------------------------------------------
  // Fetch helpers
  // ---------------------------------------------------------------------------

  async function fetchSimilar(performerId, mode) {
    const res = await fetch(`${API_BASE}/similar?id=${performerId}&mode=${mode}&limit=${LIMIT}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.results || [];
  }

  // ---------------------------------------------------------------------------
  // PerformerThumb — a small card showing name + score
  // ---------------------------------------------------------------------------

  function PerformerThumb({ result, mode }) {
    const scoreLabel = mode === 'looks' ? 'Look' : 'Scene';
    const scoreColor = mode === 'looks' ? '#e8a838' : '#5ba4cf';
    const pct        = Math.round(result.score * 100);

    const style = {
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      width:          '110px',
      flexShrink:     0,
      textDecoration: 'none',
      color:          'inherit',
    };

    const imgStyle = {
      width:        '90px',
      height:       '120px',
      objectFit:    'cover',
      borderRadius: '6px',
      background:   '#2a2a2a',
    };

    const nameStyle = {
      marginTop:  '6px',
      fontSize:   '11px',
      textAlign:  'center',
      lineHeight: '1.3',
      maxWidth:   '100px',
      overflow:   'hidden',
      display:    '-webkit-box',
      WebkitLineClamp: 2,
      WebkitBoxOrient: 'vertical',
    };

    const badgeStyle = {
      marginTop:    '4px',
      fontSize:     '10px',
      fontWeight:   'bold',
      color:        scoreColor,
    };

    return React.createElement('a',
      { href: `/performers/${result.id}`, style },
      React.createElement('img', {
        src:   `/performer/${result.id}/image`,
        alt:   result.name,
        style: imgStyle,
        onError: (e) => { e.target.style.background = '#3a3a3a'; e.target.src = ''; },
      }),
      React.createElement('span', { style: nameStyle }, result.name),
      React.createElement('span', { style: badgeStyle }, `${scoreLabel}: ${pct}%`)
    );
  }

  // ---------------------------------------------------------------------------
  // SimilarRow — horizontal scrolling row of thumbs
  // ---------------------------------------------------------------------------

  function SimilarRow({ performerId, mode, label }) {
    const [results, setResults] = useState(null);
    const [error,   setError]   = useState(null);

    useEffect(() => {
      setResults(null);
      setError(null);
      fetchSimilar(performerId, mode)
        .then(setResults)
        .catch((e) => setError(e.message));
    }, [performerId, mode]);

    const containerStyle = {
      marginTop:    '16px',
      paddingBottom: '8px',
    };

    const headingStyle = {
      fontSize:     '13px',
      fontWeight:   'bold',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      marginBottom: '10px',
      color:        '#aaa',
    };

    const rowStyle = {
      display:   'flex',
      gap:       '12px',
      overflowX: 'auto',
      paddingBottom: '6px',
    };

    const placeholderStyle = {
      fontSize: '12px',
      color:    '#666',
      padding:  '8px 0',
    };

    let content;
    if (error) {
      content = React.createElement('p', { style: placeholderStyle },
        `Could not load (is the backend running? ${error})`
      );
    } else if (results === null) {
      content = React.createElement('p', { style: placeholderStyle }, 'Loading…');
    } else if (results.length === 0) {
      content = React.createElement('p', { style: placeholderStyle }, 'No matches found.');
    } else {
      content = React.createElement('div', { style: rowStyle },
        ...results.map(r =>
          React.createElement(PerformerThumb, { key: r.id, result: r, mode })
        )
      );
    }

    return React.createElement('div', { style: containerStyle },
      React.createElement('div', { style: headingStyle }, label),
      content
    );
  }

  // ---------------------------------------------------------------------------
  // SimilarPerformersPanel — both rows together
  // ---------------------------------------------------------------------------

  function SimilarPerformersPanel({ performer }) {
    const panelStyle = {
      borderTop:  '1px solid #333',
      marginTop:  '20px',
      paddingTop: '16px',
    };

    const titleStyle = {
      fontSize:     '15px',
      fontWeight:   'bold',
      marginBottom: '4px',
    };

    return React.createElement('div', { style: panelStyle },
      React.createElement('div', { style: titleStyle }, 'Similar Performers'),
      React.createElement(SimilarRow, {
        performerId: performer.id,
        mode:        'looks',
        label:       'Similar by Look',
      }),
      React.createElement(SimilarRow, {
        performerId: performer.id,
        mode:        'scenes',
        label:       'Similar by Scene Type',
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Patch into the performer detail page
  // ---------------------------------------------------------------------------

  PluginApi.patch.after('PerformerDetailsPanel.DetailGroup', function (props, rendered) {
    if (!props || !props.performer) return rendered;

    return React.createElement(React.Fragment, null,
      rendered,
      React.createElement(SimilarPerformersPanel, { performer: props.performer })
    );
  });

})();
