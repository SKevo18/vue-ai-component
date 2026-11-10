package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"sort"
	"strings"
	"sync"
)

type burrow struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Badgers int    `json:"badgers"`
}

type registry struct {
	mu      sync.Mutex
	burrows map[int]*burrow
	tunnels [][2]int
}

func newRegistry() *registry {
	return &registry{burrows: map[int]*burrow{
		1: {ID: 1, Name: "Mossy Hollow", Badgers: 3},
		2: {ID: 2, Name: "Clover Den", Badgers: 5},
		3: {ID: 3, Name: "Rooty Nook", Badgers: 1},
	}}
}

func (r *registry) list(q string) []burrow {
	r.mu.Lock()
	defer r.mu.Unlock()
	q = strings.ToLower(q)
	out := []burrow{}
	for _, b := range r.burrows {
		if strings.Contains(strings.ToLower(b.Name), q) {
			out = append(out, *b)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (r *registry) get(id int) (burrow, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.burrows[id]
	if !ok {
		return burrow{}, false
	}
	return *b, true
}

func (r *registry) rename(id int, name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.burrows[id]
	if ok {
		b.Name = name
	}
	return ok
}

func (r *registry) fill(id int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.burrows[id]
	delete(r.burrows, id)
	return ok
}

func (r *registry) dig(from, to int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tunnels = append(r.tunnels, [2]int{from, to})
}

func (r *registry) tunnelsOf(id int) []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []int
	for _, t := range r.tunnels {
		switch id {
		case t[0]:
			out = append(out, t[1])
		case t[1]:
			out = append(out, t[0])
		}
	}
	return out
}

var photoPNG = func() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 24, 16))
	brown := color.RGBA{R: 121, G: 85, B: 61, A: 255}
	green := color.RGBA{R: 76, G: 153, B: 0, A: 255}
	for y := range 16 {
		for x := range 24 {
			c := brown
			if y >= 6 && y < 10 {
				c = green
			}
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		panic(err)
	}
	return buf.Bytes()
}()
