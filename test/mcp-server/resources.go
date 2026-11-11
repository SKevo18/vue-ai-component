package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type staticDoc struct {
	res  mcp.Resource
	text string
}

var staticDocs = []staticDoc{
	{
		mcp.Resource{URI: "skill://burrow-care/SKILL.md", Name: "burrow-care", Title: "Burrow care", Description: "How to inspect and repair badger burrows. Use when a burrow is damaged.", MIMEType: "text/markdown"},
		"---\nname: burrow-care\ndescription: How to inspect and repair badger burrows. Use when a burrow is damaged.\n---\n\n# Burrow care\n\n1. Read the burrow record with burrow://{id}.\n2. Check the tunnels for loose roots.\n3. Never fill a burrow that still has badgers in it.\n",
	},
	{
		mcp.Resource{URI: "skill://otters/visiting/SKILL.md", Name: "visiting", Description: "Etiquette for otters visiting badger burrows.", MIMEType: "text/markdown"},
		"---\nname: visiting\ndescription: Etiquette for otters visiting badger burrows.\n---\n\n# Visiting\n\nKnock twice on the root. Bring a pebble. Leave before dusk.\n",
	},
	{
		mcp.Resource{URI: "docs://registry-guide", Name: "registry-guide", Title: "Registry guide", MIMEType: "text/markdown"},
		"# Registry guide\n\nEvery burrow in Otterfield has a small integer id and a badger count.\n",
	},
	{
		mcp.Resource{URI: "docs://tunnel-rules", Name: "tunnel-rules", MIMEType: "text/markdown"},
		"# Tunnel rules\n\nTunnels connect two burrows. Dig them with dig_tunnel.\n",
	},
	{
		mcp.Resource{URI: "docs://postcards", Name: "postcards", MIMEType: "text/markdown"},
		"# Postcards\n\nPostcards leave Otterfield every morning via heron.\n",
	},
	{
		mcp.Resource{URI: "note://otterfield-minutes", Name: "otterfield-minutes", Title: "Otterfield minutes", MIMEType: "text/plain"},
		"Otterfield minutes\n\nThe council agreed that Clover Den may keep its fifth badger.\n",
	},
}

var bigText = func() string {
	var b strings.Builder
	for i := 1; b.Len() < 100000; i++ {
		line := fmt.Sprintf("otter line %05d ", i)
		b.WriteString(line + strings.Repeat(".", 63-len(line)) + "\n")
	}
	return b.String()[:100000]
}()

func addResources(s *mcp.Server, reg *registry) {
	for _, d := range staticDocs {
		r := d.res
		txt := d.text
		s.AddResource(&r, func(_ context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: req.Params.URI, MIMEType: r.MIMEType, Text: txt}}}, nil
		})
	}

	s.AddResourceTemplate(&mcp.ResourceTemplate{
		URITemplate: "burrow://{id}",
		Name:        "burrow",
		Title:       "Burrow",
		Description: "A burrow record as markdown: name, badger count and tunnels.",
		MIMEType:    "text/markdown",
	}, func(_ context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		uri := req.Params.URI
		id := strings.TrimPrefix(uri, "burrow://")
		if id == "big" {
			return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: uri, MIMEType: "text/markdown", Text: bigText}}}, nil
		}
		n, err := strconv.Atoi(id)
		if err != nil {
			return nil, mcp.ResourceNotFoundError(uri)
		}
		b, ok := reg.get(n)
		if !ok {
			return nil, mcp.ResourceNotFoundError(uri)
		}
		md := fmt.Sprintf("# %s\n\nBadgers: %d\n", b.Name, b.Badgers)
		if ts := reg.tunnelsOf(n); len(ts) > 0 {
			parts := make([]string, len(ts))
			for i, t := range ts {
				parts[i] = strconv.Itoa(t)
			}
			md += "Tunnels: " + strings.Join(parts, ", ") + "\n"
		}
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: uri, MIMEType: "text/markdown", Text: md}}}, nil
	})

	s.AddResourceTemplate(&mcp.ResourceTemplate{
		URITemplate: "photo://{name}",
		Name:        "photo",
		Description: "A burrow photo as PNG.",
		MIMEType:    "image/png",
	}, func(_ context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		uri := req.Params.URI
		if uri != "photo://den.png" {
			return nil, mcp.ResourceNotFoundError(uri)
		}
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: uri, MIMEType: "image/png", Blob: photoPNG}}}, nil
	})
}
