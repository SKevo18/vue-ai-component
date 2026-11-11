package aiserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
)

func (h *Handler) models(w http.ResponseWriter, r *http.Request) error {
	user, err := h.cfg.User(r)
	if err != nil {
		return err
	}
	p, err := h.provider(r, user, true)
	if err != nil {
		return err
	}
	c, err := h.credential(r, user, p)
	if err != nil {
		return err
	}
	list, err := vendorOf(p).models(r.Context(), h, c)
	if ge, ok := errors.AsType[*grantError](err); ok {
		return errUpstream("The model list failed (" + ge.code + ": " + ge.message + ").")
	}
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, map[string]any{"models": list})
}

// chat proxies one chat request with the user's credential and streams the answer back. Upstream errors reach the
// browser with the vendor's status and body.
func (h *Handler) chat(w http.ResponseWriter, r *http.Request) error {
	user, err := h.cfg.User(r)
	if err != nil {
		return err
	}
	p, err := h.provider(r, user, true)
	if err != nil {
		return err
	}
	payload, err := readPayload(r)
	if err != nil {
		return err
	}
	c, err := h.credential(r, user, p)
	if err != nil {
		return err
	}
	v := vendorOf(p)
	resp, err := h.sendChat(r.Context(), v, c, payload)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		if er, ok := v.(errorRewriter); ok {
			body = er.rewriteError(body)
		}
		ct := resp.Header.Get("Content-Type")
		if ct == "" {
			ct = "application/json"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(body)
		return nil
	}
	if un, ok := v.(sseUnwrapper); ok {
		h.pipeLines(w, r, resp, un.unwrap)
		return nil
	}
	h.pipe(w, r, resp)
	return nil
}

// sendChat sends the vendor's chat request built from a copy of payload. A rejection the vendor can fix
// (rejectionRetrier) is sent once more. The response carries the final status and body.
func (h *Handler) sendChat(ctx context.Context, v vendor, c *Credential, payload map[string]json.RawMessage) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		req, err := v.chat(ctx, h, c, maps.Clone(payload))
		if err != nil {
			return nil, err
		}
		resp, err := h.client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			h.log.Error("ai upstream failed", "host", req.URL.Host, "err", err)
			return nil, errUpstream("The AI provider did not respond.")
		}
		rr, ok := v.(rejectionRetrier)
		if resp.StatusCode < 400 || attempt > 0 || !ok {
			return resp, nil
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		_ = resp.Body.Close()
		if !rr.retry(h, resp.StatusCode, body) {
			resp.Body = io.NopCloser(bytes.NewReader(body))
			return resp, nil
		}
	}
}

// readPayload reads the request body, at most maxChatBody bytes, as a JSON object.
func readPayload(r *http.Request) (map[string]json.RawMessage, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxChatBody+1))
	if err != nil {
		return nil, errBad("The request body could not be read.")
	}
	if len(body) > maxChatBody {
		return nil, &Error{Status: http.StatusRequestEntityTooLarge, Code: "payload_too_large", Message: "The request exceeds 8 MiB."}
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil || payload == nil {
		return nil, errBad("The body must be a JSON object.")
	}
	return payload, nil
}

func streamHeaders(w http.ResponseWriter, ct string) {
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
}

// pipe streams the upstream response back unchanged, flushing as it comes.
func (h *Handler) pipe(w http.ResponseWriter, r *http.Request, resp *http.Response) {
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	streamHeaders(w, ct)
	w.WriteHeader(resp.StatusCode)
	rc := http.NewResponseController(w)
	buf := make([]byte, 32<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			_ = rc.Flush()
		}
		if rerr != nil {
			if !errors.Is(rerr, io.EOF) && r.Context().Err() == nil {
				h.log.Warn("ai stream interrupted", "err", rerr)
			}
			return
		}
	}
}

// pipeLines streams an SSE response line by line, passing each data payload through rewrite and flushing at event
// boundaries.
func (h *Handler) pipeLines(w http.ResponseWriter, r *http.Request, resp *http.Response, rewrite func([]byte) []byte) {
	streamHeaders(w, "text/event-stream")
	w.WriteHeader(resp.StatusCode)
	rc := http.NewResponseController(w)
	rd := bufio.NewReaderSize(resp.Body, 64<<10)
	for {
		line, rerr := rd.ReadBytes('\n')
		if len(line) > 0 {
			trimmed := bytes.TrimRight(line, "\r\n")
			if data, ok := bytes.CutPrefix(trimmed, []byte("data:")); ok {
				line = append(append([]byte("data: "), rewrite(bytes.TrimSpace(data))...), '\n')
			}
			if _, werr := w.Write(line); werr != nil {
				return
			}
			if len(trimmed) == 0 {
				_ = rc.Flush()
			}
		}
		if rerr != nil {
			_ = rc.Flush()
			if !errors.Is(rerr, io.EOF) && r.Context().Err() == nil {
				h.log.Warn("ai stream interrupted", "err", rerr)
			}
			return
		}
	}
}
