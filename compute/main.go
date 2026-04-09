package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

const topN = 10

// ---------------------------------------------------------------------------
// Plugin I/O
// ---------------------------------------------------------------------------

type pluginInput struct {
	ServerConnection struct {
		Dir       string `json:"Dir"`
		PluginDir string `json:"PluginDir"`
	} `json:"server_connection"`
}

func progress(p float64) {
	b, _ := json.Marshal(map[string]float64{"progress": p})
	fmt.Println(string(b))
}

func output(msg string) {
	b, _ := json.Marshal(map[string]string{"output": msg})
	fmt.Println(string(b))
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

var hairProximity = map[[2]string]float64{
	{"Brunette", "Auburn"}: 0.6,
	{"Auburn", "Brunette"}: 0.6,
	{"Brunette", "Black"}:  0.4,
	{"Black", "Brunette"}:  0.4,
	{"Blonde", "Auburn"}:   0.5,
	{"Auburn", "Blonde"}:   0.5,
}

func hairScore(a, b string) float64 {
	if a == "" || b == "" {
		return 0
	}
	if a == b {
		return 1
	}
	return hairProximity[[2]string{a, b}]
}

func gaussian(a, b, sigma float64) float64 {
	if a == 0 || b == 0 {
		return 0
	}
	d := a - b
	return math.Exp(-0.5 * d * d / (sigma * sigma))
}

type measurements struct {
	bust, waist, hip float64
}

func parseMeasurements(s string) (measurements, bool) {
	parts := strings.SplitN(s, "-", 3)
	if len(parts) != 3 {
		return measurements{}, false
	}
	// bust may have cup letter e.g. "34B" — strip non-digits
	bustStr := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, parts[0])
	var m measurements
	_, err1 := fmt.Sscanf(bustStr, "%f", &m.bust)
	_, err2 := fmt.Sscanf(parts[1], "%f", &m.waist)
	_, err3 := fmt.Sscanf(parts[2], "%f", &m.hip)
	if err1 != nil || err2 != nil || err3 != nil {
		return measurements{}, false
	}
	return m, true
}

// ---------------------------------------------------------------------------
// Performer record
// ---------------------------------------------------------------------------

type performer struct {
	id           int
	name         string
	ethnicity    string
	hairColor    string
	eyeColor     string
	height       float64
	measurements string
	fakeTits     string
}

type match struct {
	ID    int     `json:"id"`
	Name  string  `json:"name"`
	Score float64 `json:"score"`
}

// ---------------------------------------------------------------------------
// Looks similarity
// ---------------------------------------------------------------------------

func computeLooks(db *sql.DB, performers []performer) map[string][]match {
	parsed := make(map[int]measurements, len(performers))
	for _, p := range performers {
		if m, ok := parseMeasurements(p.measurements); ok {
			parsed[p.id] = m
		}
	}

	result := make(map[string][]match, len(performers))
	n := len(performers)

	for i, target := range performers {
		if i%500 == 0 {
			progress(float64(i) / float64(n) * 0.5) // looks = first 50%
		}

		if target.ethnicity == "" || target.measurements == "" {
			result[fmt.Sprint(target.id)] = nil
			continue
		}

		tm, hasTM := parsed[target.id]
		scores := make([]match, 0, n)

		for _, c := range performers {
			if c.id == target.id || c.ethnicity != target.ethnicity || c.measurements == "" {
				continue
			}
			cm, hasCM := parsed[c.id]

			score := 0.18*hairScore(c.hairColor, target.hairColor) +
				0.10*boolScore(c.eyeColor == target.eyeColor) +
				0.10*boolScore(c.fakeTits == target.fakeTits) +
				0.18*gaussian(c.height, target.height, 6) +
				0.15*condGaussian(hasTM && hasCM, cm.bust, tm.bust, 3) +
				0.15*condGaussian(hasTM && hasCM, cm.waist, tm.waist, 3) +
				0.14*condGaussian(hasTM && hasCM, cm.hip, tm.hip, 3)

			scores = append(scores, match{c.id, c.name, round3(score)})
		}

		sort.Slice(scores, func(a, b int) bool { return scores[a].Score > scores[b].Score })
		if len(scores) > topN {
			scores = scores[:topN]
		}
		result[fmt.Sprint(target.id)] = scores
	}
	return result
}

func boolScore(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

func condGaussian(ok bool, a, b, sigma float64) float64 {
	if !ok {
		return 0
	}
	return gaussian(a, b, sigma)
}

func round3(f float64) float64 {
	return math.Round(f*1000) / 1000
}

// ---------------------------------------------------------------------------
// Scene tag Jaccard similarity
// ---------------------------------------------------------------------------

func computeScenes(db *sql.DB, performers []performer) map[string][]match {
	// Load all (performer_id, tag_id) pairs for female performers
	rows, err := db.Query(`
		SELECT ps.performer_id, st.tag_id
		FROM performers_scenes ps
		JOIN scenes_tags st ON ps.scene_id = st.scene_id
		JOIN performers p ON ps.performer_id = p.id
		WHERE p.gender = 'FEMALE'
	`)
	if err != nil {
		fmt.Fprintf(os.Stderr, "scene query error: %v\n", err)
		return nil
	}
	defer rows.Close()

	tagSets := make(map[int]map[int]struct{})
	for rows.Next() {
		var pid, tid int
		rows.Scan(&pid, &tid)
		if tagSets[pid] == nil {
			tagSets[pid] = make(map[int]struct{})
		}
		tagSets[pid][tid] = struct{}{}
	}

	nameMap := make(map[int]string, len(performers))
	for _, p := range performers {
		nameMap[p.id] = p.name
	}

	pids := make([]int, 0, len(tagSets))
	for pid := range tagSets {
		pids = append(pids, pid)
	}

	n := len(pids)
	result := make(map[string][]match, n)

	for i, pid := range pids {
		if i%500 == 0 {
			progress(0.5 + float64(i)/float64(n)*0.5) // scenes = second 50%
		}

		targetTags := tagSets[pid]
		tCount := len(targetTags)
		scores := make([]match, 0, n)

		for _, other := range pids {
			if other == pid {
				continue
			}
			otherTags := tagSets[other]
			shared := 0
			for tid := range targetTags {
				if _, ok := otherTags[tid]; ok {
					shared++
				}
			}
			union := tCount + len(otherTags) - shared
			jaccard := 0.0
			if union > 0 {
				jaccard = float64(shared) / float64(union)
			}
			scores = append(scores, match{other, nameMap[other], round3(jaccard)})
		}

		sort.Slice(scores, func(a, b int) bool { return scores[a].Score > scores[b].Score })
		if len(scores) > topN {
			scores = scores[:topN]
		}
		result[fmt.Sprint(pid)] = scores
	}
	return result
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	var input pluginInput
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		// fallback for direct invocation
		input.ServerConnection.Dir = "/root/.stash"
		input.ServerConnection.PluginDir = filepath.Dir(os.Args[0])
	}

	dbPath := filepath.Join(input.ServerConnection.Dir, "stash-go.sqlite")
	dataDir := filepath.Join(input.ServerConnection.PluginDir, "data")
	outPath := filepath.Join(dataDir, "similarity.json")

	if err := os.MkdirAll(dataDir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "mkdir error: %v\n", err)
		os.Exit(1)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "db open error: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	fmt.Println("[similar-performers] loading performers...")

	rows, err := db.Query(`
		SELECT id, name, ethnicity, hair_color, eye_color,
		       COALESCE(height, 0), COALESCE(measurements, ''), COALESCE(fake_tits, '')
		FROM performers
		WHERE gender = 'FEMALE'
	`)
	if err != nil {
		fmt.Fprintf(os.Stderr, "performer query error: %v\n", err)
		os.Exit(1)
	}

	var performers []performer
	for rows.Next() {
		var p performer
		rows.Scan(&p.id, &p.name, &p.ethnicity, &p.hairColor, &p.eyeColor,
			&p.height, &p.measurements, &p.fakeTits)
		performers = append(performers, p)
	}
	rows.Close()

	fmt.Printf("[similar-performers] loaded %d performers\n", len(performers))
	fmt.Println("[similar-performers] computing looks similarity...")

	looks := computeLooks(db, performers)

	fmt.Println("[similar-performers] computing scene similarity...")

	scenes := computeScenes(db, performers)

	fmt.Println("[similar-performers] writing output...")

	f, err := os.Create(outPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "create output error: %v\n", err)
		os.Exit(1)
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(map[string]any{"looks": looks, "scenes": scenes}); err != nil {
		fmt.Fprintf(os.Stderr, "json encode error: %v\n", err)
		os.Exit(1)
	}

	output(fmt.Sprintf("wrote %s", outPath))
}
