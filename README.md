# stash-similar-performers

A [Stash](https://github.com/stashapp/stash) plugin that recommends similar performers using two independent scoring methods. Results appear as two scrollable rows at the bottom of each performer's detail page.

![Similar Performers panel showing two rows of performer thumbnails with scores](https://raw.githubusercontent.com/darious/stash-similar-performers/master/docs/screenshot.png)

## How it works

**Similar by Look** — scores performers on physical attributes:
- Ethnicity (must match — used as a hard filter)
- Hair colour (exact match + proximity, e.g. Brunette ↔ Auburn)
- Eye colour
- Height (Gaussian proximity, σ = 6cm)
- Bust / waist / hip measurements (Gaussian proximity, σ = 3in each)
- Fake tits flag

**Similar by Scene Type** — Jaccard similarity on the full set of tags across all scenes a performer appears in. Finds performers who do similar kinds of content, regardless of who they appear with.

Scores are pre-computed once as a background task and stored as a JSON file. The performer page reads that file on first load and caches it for the session — no live queries, no slowdown.

## Requirements

- Stash (any recent version)
- The default Stash Docker image (`stashapp/stash`) — no extra dependencies needed

## Installation

1. Copy the plugin folder into your Stash plugins directory:

```
plugins/
  similar-performers/
    similar-performers.yml
    similar-performers-compute     ← pre-built linux/amd64 binary
    ui/
      similar.js
    data/                          ← created automatically on first run
```

2. In Stash go to **Settings → Plugins** and click **Refresh Plugins**.

3. Go to **Settings → Tasks** and run **Compute Similarities**.  
   This takes 1–2 minutes depending on library size and writes `data/similarity.json`.

4. Navigate to any performer page — the Similar Performers panel will appear below the detail section.

Re-run **Compute Similarities** whenever your library changes significantly.

## Scoring weights (looks)

| Attribute    | Weight |
|--------------|--------|
| Hair colour  | 18%    |
| Height       | 18%    |
| Bust         | 15%    |
| Waist        | 15%    |
| Hip          | 14%    |
| Eye colour   | 10%    |
| Fake tits    | 10%    |

## Building from source

Requires Go 1.21+.

```bash
cd compute
go mod tidy
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../similar-performers-compute .
```
