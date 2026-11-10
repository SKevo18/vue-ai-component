package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type listIn struct {
	Q string `json:"q,omitempty" jsonschema:"case-insensitive substring of the burrow name"`
}

type listOut struct {
	Burrows []burrow `json:"burrows"`
}

type renameIn struct {
	ID   int    `json:"id" jsonschema:"burrow id"`
	Name string `json:"name" jsonschema:"new burrow name"`
}

type idIn struct {
	ID int `json:"id" jsonschema:"burrow id"`
}

type postcardIn struct {
	To   string `json:"to" jsonschema:"recipient, e.g. an otter's name"`
	Text string `json:"text" jsonschema:"postcard message"`
}

type tunnelIn struct {
	From int `json:"from" jsonschema:"burrow id where the tunnel starts"`
	To   int `json:"to" jsonschema:"burrow id where the tunnel ends"`
}

type slowIn struct {
	MS int `json:"ms" jsonschema:"how long to dig, in milliseconds"`
}

type progressIn struct {
	Steps int `json:"steps" jsonschema:"how many progress notifications to send"`
	MS    int `json:"ms" jsonschema:"pause between notifications, in milliseconds"`
}

func text(s string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: s}}}
}

func toolErr(s string) *mcp.CallToolResult {
	r := text(s)
	r.IsError = true
	return r
}

func noBurrow(id int) *mcp.CallToolResult { return toolErr(fmt.Sprintf("No burrow %d.", id)) }

func addTools(s *mcp.Server, reg *registry, tab, otter string) {
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true}

	mcp.AddTool(s, &mcp.Tool{Name: "list_burrows", Description: "List burrows, optionally filtered by name.", Annotations: readOnly},
		func(_ context.Context, _ *mcp.CallToolRequest, in listIn) (*mcp.CallToolResult, listOut, error) {
			bs := reg.list(in.Q)
			b, _ := json.Marshal(bs)
			return text(string(b)), listOut{Burrows: bs}, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "rename_burrow", Description: "Rename a burrow."},
		func(_ context.Context, _ *mcp.CallToolRequest, in renameIn) (*mcp.CallToolResult, any, error) {
			if !reg.rename(in.ID, in.Name) {
				return noBurrow(in.ID), nil, nil
			}
			return text(fmt.Sprintf("Renamed burrow %d to %s.", in.ID, in.Name)), nil, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "fill_burrow", Description: "Fill in a burrow, removing it from the registry.", Annotations: &mcp.ToolAnnotations{DestructiveHint: new(true)}},
		func(_ context.Context, _ *mcp.CallToolRequest, in idIn) (*mcp.CallToolResult, any, error) {
			if !reg.fill(in.ID) {
				return noBurrow(in.ID), nil, nil
			}
			return text(fmt.Sprintf("Filled burrow %d.", in.ID)), nil, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "send_postcard", Description: "Send a postcard from the burrow registry.", Annotations: &mcp.ToolAnnotations{OpenWorldHint: new(true)}, Meta: mcp.Meta{"approval": "confirm"}},
		func(_ context.Context, _ *mcp.CallToolRequest, in postcardIn) (*mcp.CallToolResult, any, error) {
			return text(fmt.Sprintf("Postcard to %s is on its way.", in.To)), nil, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "dig_tunnel", Description: "Dig a tunnel between two burrows.", Meta: mcp.Meta{"approval": "auto"}},
		func(_ context.Context, _ *mcp.CallToolRequest, in tunnelIn) (*mcp.CallToolResult, any, error) {
			reg.dig(in.From, in.To)
			return text(fmt.Sprintf("Dug a tunnel from %d to %d.", in.From, in.To)), nil, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "burrow_photo", Description: "Take a photo of a burrow.", Annotations: readOnly},
		func(_ context.Context, _ *mcp.CallToolRequest, in idIn) (*mcp.CallToolResult, any, error) {
			if _, ok := reg.get(in.ID); !ok {
				return noBurrow(in.ID), nil, nil
			}
			return &mcp.CallToolResult{Content: []mcp.Content{
				&mcp.TextContent{Text: fmt.Sprintf("Photo of burrow %d.", in.ID)},
				&mcp.ImageContent{MIMEType: "image/png", Data: photoPNG},
			}}, nil, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "burrow_link", Description: "Link to a burrow record resource.", Annotations: readOnly},
		func(_ context.Context, _ *mcp.CallToolRequest, in idIn) (*mcp.CallToolResult, any, error) {
			b, ok := reg.get(in.ID)
			if !ok {
				return noBurrow(in.ID), nil, nil
			}
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.ResourceLink{
				URI:      fmt.Sprintf("burrow://%d", in.ID),
				Name:     fmt.Sprintf("burrow-%d", in.ID),
				Title:    b.Name,
				MIMEType: "text/markdown",
			}}}, nil, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "whoami", Title: "Look at the burrow tab", Description: "Report the browser tab and otter headers of the caller.", Annotations: readOnly},
		func(_ context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
			b, _ := json.Marshal(map[string]string{"tab": tab, "otter": otter})
			return text(string(b)), nil, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "slow_dig", Description: "Dig slowly for a given number of milliseconds.", Annotations: readOnly},
		func(ctx context.Context, _ *mcp.CallToolRequest, in slowIn) (*mcp.CallToolResult, any, error) {
			select {
			case <-time.After(time.Duration(in.MS) * time.Millisecond):
			case <-ctx.Done():
				return nil, nil, ctx.Err()
			}
			return text(fmt.Sprintf("Dug for %d ms.", in.MS)), nil, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "progress_dig", Description: "Dig in steps and report progress after each one.", Annotations: readOnly},
		func(ctx context.Context, req *mcp.CallToolRequest, in progressIn) (*mcp.CallToolResult, any, error) {
			token := req.Params.GetProgressToken()
			for i := 1; i <= in.Steps; i++ {
				select {
				case <-time.After(time.Duration(in.MS) * time.Millisecond):
				case <-ctx.Done():
					return nil, nil, ctx.Err()
				}
				if token != nil {
					_ = req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{ProgressToken: token, Progress: float64(i), Total: float64(in.Steps), Message: fmt.Sprintf("dug %d of %d", i, in.Steps)})
				}
			}
			return text(fmt.Sprintf("Dug %d steps (token %v).", in.Steps, token != nil)), nil, nil
		})

	mcp.AddTool(s, &mcp.Tool{Name: "explode", Description: "Always fails with a Go error."},
		func(_ context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
			return nil, nil, errors.New("the burrow collapsed")
		})
}
