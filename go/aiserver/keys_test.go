package aiserver_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/SKevo18/vue-ai-component/go/aiserver"
	"github.com/SKevo18/vue-ai-component/go/aiserver/aiservertest"
)

func TestAPIKeys(t *testing.T) {
	f := aiservertest.NewKeys(t)
	e := newEnv(t, false, []string{aiserver.OpenAI, aiserver.Anthropic, aiserver.Gemini, aiserver.Codex}, f.BaseURLs())
	last := func() (*http.Request, []byte) {
		f.Lock()
		defer f.Unlock()
		return f.Last, f.Body
	}

	e.expect(e.call("alice", http.MethodGet, "/status", ""), http.StatusOK, `"openai":{"kind":"key","enabled":true,"connected":false}`, "initial status")
	e.expect(e.call("alice", http.MethodPut, "/keys/codex", `{"api_key":"good"}`), http.StatusNotFound, "", "a sign-in provider takes no key")
	e.expect(e.call("alice", http.MethodPost, "/oauth/openai/start", ""), http.StatusNotFound, "", "a key provider has no sign-in")
	e.expect(e.call("alice", http.MethodPost, "/openai/chat", `{"model":"gpt-5","input":"hi"}`), http.StatusForbidden, "not_connected", "chat without key")
	e.expect(e.call("alice", http.MethodPut, "/keys/openai", `{"api_key":"two words"}`), http.StatusUnprocessableEntity, "api_key", "malformed key")

	for _, p := range []string{"openai", "anthropic", "gemini"} {
		e.expect(e.call("alice", http.MethodPut, "/keys/"+p, `{"api_key":"bad"}`), http.StatusUnprocessableEntity, "invalid_key", p+" rejected key")
		e.expect(e.call("alice", http.MethodPut, "/keys/"+p, `{"api_key":" good "}`), http.StatusOK, `"`+p+`":{"kind":"key","enabled":true,"connected":true}`, p+" key stored")
	}
	if c, _ := e.store.get("alice", "openai"); c.APIKey != "good" {
		t.Fatalf("stored key: %+v", c)
	}
	e.expect(e.call("bob", http.MethodGet, "/openai/models", ""), http.StatusForbidden, "not_connected", "bob has no key")

	e.expect(e.call("alice", http.MethodGet, "/openai/models", ""), http.StatusOK, `{"models":[{"id":"gpt-5","name":"gpt-5"},{"id":"o3","name":"o3"},{"id":"gpt-4o","name":"gpt-4o"}]}`, "openai models")
	e.expect(e.call("alice", http.MethodGet, "/anthropic/models", ""), http.StatusOK, `{"models":[{"id":"claude-new","name":"Claude New"},{"id":"claude-old","name":"Claude Old"}]}`, "anthropic models")
	e.expect(e.call("alice", http.MethodGet, "/gemini/models", ""), http.StatusOK, `{"models":[{"id":"gemini-3-pro","name":"Gemini 3 Pro"},{"id":"gemini-2.5-flash","name":"Gemini 2.5 Flash"}]}`, "gemini models")

	rec := e.call("alice", http.MethodPost, "/openai/chat", `{"model":"gpt-5","input":"hi","stream":true}`)
	e.expect(rec, http.StatusOK, `data: {"delta":"foo"}`, "openai chat")
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/event-stream") || rec.Header().Get("X-Accel-Buffering") != "no" || !strings.Contains(rec.Body.String(), "[DONE]") {
		t.Fatalf("stream not passed through: %v %s", rec.Header(), rec.Body.String())
	}
	if req, body := last(); req.URL.Path != "/v1/responses" || req.Header.Get("Authorization") != "Bearer good" || !strings.Contains(string(body), `"model":"gpt-5"`) {
		t.Fatalf("openai request: %s %v %s", req.URL.Path, req.Header, body)
	}

	e.expect(e.call("alice", http.MethodPost, "/anthropic/chat", `{"model":"claude-new","messages":[]}`), http.StatusOK, "foo", "anthropic chat")
	if req, _ := last(); req.URL.Path != "/v1/messages" || req.Header.Get("x-api-key") != "good" || req.Header.Get("anthropic-version") != "2023-06-01" {
		t.Fatalf("anthropic request: %s %v", req.URL.Path, req.Header)
	}

	e.expect(e.call("alice", http.MethodPost, "/gemini/chat", `{"contents":[]}`), http.StatusUnprocessableEntity, "model", "gemini without model")
	e.expect(e.call("alice", http.MethodPost, "/gemini/chat", `{"model":"gemini-3-pro","contents":[]}`), http.StatusOK, "foo", "gemini chat")
	req, body := last()
	var sent map[string]any
	_ = json.Unmarshal(body, &sent)
	if req.URL.Path != "/v1beta/models/gemini-3-pro:streamGenerateContent" || req.URL.Query().Get("alt") != "sse" || req.Header.Get("x-goog-api-key") != "good" || sent["model"] != nil {
		t.Fatalf("gemini request: %s %v %s", req.URL, req.Header, body)
	}

	e.expect(e.call("alice", http.MethodPost, "/anthropic/chat", `{"model":"fail","messages":[]}`), http.StatusTooManyRequests, "rate_limit_error", "upstream error passes through")
	e.expect(e.call("alice", http.MethodPost, "/openai/chat", `[1,2]`), http.StatusBadRequest, "bad_request", "non-object body")
	e.expect(e.call("alice", http.MethodPost, "/openai/chat", `{"pad":"`+strings.Repeat("x", 2<<20)+`"}`), http.StatusOK, "foo", "attachment-sized body")
	e.expect(e.call("alice", http.MethodPost, "/openai/chat", `{"pad":"`+strings.Repeat("x", 8<<20)+`"}`), http.StatusRequestEntityTooLarge, "payload_too_large", "oversized body")

	e.expect(e.call("alice", http.MethodDelete, "/keys/openai", ""), http.StatusNoContent, "", "delete key")
	e.expect(e.call("alice", http.MethodGet, "/status", ""), http.StatusOK, `"openai":{"kind":"key","enabled":true,"connected":false}`, "after delete")
}
