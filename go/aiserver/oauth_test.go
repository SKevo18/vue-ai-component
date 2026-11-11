package aiserver_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/SKevo18/vue-ai-component/go/aiserver"
	"github.com/SKevo18/vue-ai-component/go/aiserver/aiservertest"
)

type startView struct {
	Flow            string `json:"flow"`
	LoginID         string `json:"login_id"`
	AuthorizeURL    string `json:"authorize_url"`
	VerificationURL string `json:"verification_url"`
	UserCode        string `json:"user_code"`
	Interval        int    `json:"interval"`
	ExpiresIn       int    `json:"expires_in"`
}

func (e *env) begin(user, provider string) startView {
	e.t.Helper()
	rec := e.call(user, http.MethodPost, "/oauth/"+provider+"/start", "")
	e.expect(rec, http.StatusOK, "login_id", provider+" start")
	var s startView
	_ = json.Unmarshal(rec.Body.Bytes(), &s)
	return s
}

func completeBody(loginID, code string) string {
	b, _ := json.Marshal(map[string]string{"login_id": loginID, "code": code})
	return string(b)
}

// authorize returns the query of a start's authorize URL and hands its PKCE challenge to the fake.
func authorize(t *testing.T, f *aiservertest.Vendors, s startView) url.Values {
	t.Helper()
	u, err := url.Parse(s.AuthorizeURL)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	f.Lock()
	f.Challenge = q.Get("code_challenge")
	f.Unlock()
	return q
}

var subscriptions = []string{aiserver.Codex, aiserver.Claude, aiserver.Antigravity}

func TestSubscriptionSignIns(t *testing.T) {
	f := aiservertest.NewVendors(t)
	f.Originator = "testapp"
	e := newEnv(t, false, subscriptions, f.BaseURLs())
	call := func(method, path, body string) *httptest.ResponseRecorder { return e.call("alice", method, path, body) }

	e.expect(e.call("", http.MethodGet, "/status", ""), http.StatusUnauthorized, "unauthorized", "anonymous")
	e.expect(call(http.MethodPost, "/oauth/nope/start", ""), http.StatusNotFound, "not_found", "unknown provider")
	e.expect(call(http.MethodPost, "/oauth/openai/start", ""), http.StatusNotFound, "not_found", "provider not enabled")
	e.expect(call(http.MethodGet, "/nope", ""), http.StatusNotFound, "not_found", "unknown route")
	e.expect(call(http.MethodGet, "/status", ""), http.StatusOK, `"codex":{"kind":"oauth","enabled":true,"connected":false}`, "initial status")
	e.expect(call(http.MethodGet, "/codex/models", ""), http.StatusForbidden, "not_connected", "not connected")

	// codex: early polls are pending, polls faster than the interval do not reach the issuer
	s := e.begin("alice", aiserver.Codex)
	if s.Flow != "device" || s.UserCode != "ABCD-1234" || s.VerificationURL != f.URL+"/codex/device" || s.Interval != 1 || s.ExpiresIn <= 0 {
		t.Fatalf("codex start: %+v", s)
	}
	e.expect(e.call("bob", http.MethodPost, "/oauth/codex/complete", completeBody(s.LoginID, "")), http.StatusBadRequest, "oauth_login", "another user's login")
	e.expect(call(http.MethodPost, "/oauth/claude/complete", completeBody(s.LoginID, "")), http.StatusBadRequest, "oauth_login", "another provider's login")
	e.expect(call(http.MethodPost, "/oauth/codex/complete", completeBody(s.LoginID, "")), http.StatusAccepted, `"pending":true`, "pending")
	e.expect(call(http.MethodPost, "/oauth/codex/complete", completeBody(s.LoginID, "")), http.StatusAccepted, `"pending":true`, "throttled")
	f.Lock()
	polls := f.Polls
	f.Approved = true
	f.Unlock()
	if polls != 1 {
		t.Fatalf("polls within the interval must not reach the issuer: %d", polls)
	}
	time.Sleep(1100 * time.Millisecond)
	e.expect(call(http.MethodPost, "/oauth/codex/complete", completeBody(s.LoginID, "")), http.StatusOK, `"codex":{"kind":"oauth","enabled":true,"connected":true,"email":"al@example.com","account_id":"acct-1","expires_at":`, "codex connected")
	e.expect(call(http.MethodPost, "/oauth/codex/complete", completeBody(s.LoginID, "")), http.StatusBadRequest, "oauth_login", "login is single use")
	e.expect(call(http.MethodGet, "/codex/models", ""), http.StatusOK, `{"models":[{"id":"gpt-codex","name":"GPT Codex"}]}`, "codex models")
	e.expect(e.call("bob", http.MethodGet, "/codex/models", ""), http.StatusForbidden, "not_connected", "bob has no connection")
	e.expect(call(http.MethodPost, "/codex/chat", `{"model":"gpt-codex","input":[],"temperature":0.3,"max_output_tokens":5}`), http.StatusOK, "response.output_text.delta", "codex chat")
	f.Lock()
	var sent map[string]any
	_ = json.Unmarshal(f.LastBody, &sent)
	if sent["store"] != false || sent["stream"] != true || sent["instructions"] != "" || sent["temperature"] != nil || sent["max_output_tokens"] != nil || f.LastReq.URL.Path != "/codex/responses" {
		t.Fatalf("codex request shape: %s", f.LastBody)
	}
	f.Unlock()

	// refresh: an expiring token is renewed with the rotating refresh token, a dead one drops the connection
	e.store.expire("alice", aiserver.Codex)
	e.expect(call(http.MethodGet, "/codex/models", ""), http.StatusOK, "gpt-codex", "codex after refresh")
	f.Lock()
	if g := f.Grants[len(f.Grants)-1]; g != "refresh_token" {
		t.Fatalf("expected a refresh, got %v", f.Grants)
	}
	f.Unlock()
	e.expect(call(http.MethodGet, "/status", ""), http.StatusOK, `"email":"al@example.com"`, "refresh keeps the identity")
	e.store.expire("alice", aiserver.Codex)
	f.Lock()
	f.Dead = true
	f.Unlock()
	e.expect(call(http.MethodGet, "/codex/models", ""), http.StatusForbidden, "oauth_expired", "dead refresh")
	f.Lock()
	f.Dead = false
	f.Unlock()
	e.expect(call(http.MethodGet, "/status", ""), http.StatusOK, `"codex":{"kind":"oauth","enabled":true,"connected":false}`, "dead refresh disconnects")

	s = e.begin("alice", aiserver.Claude)
	q := authorize(t, f, s)
	u, _ := url.Parse(s.AuthorizeURL)
	if s.Flow != "code" || u.Path != "/oauth/authorize" || q.Get("client_id") != "9d1c250a-e61b-44d9-88ed-5944d1962f5e" || q.Get("redirect_uri") != "https://platform.claude.com/oauth/code/callback" ||
		q.Get("code") != "true" || q.Get("code_challenge_method") != "S256" || q.Get("state") == "" || !strings.Contains(q.Get("scope"), "user:inference") {
		t.Fatalf("claude authorize url: %s", s.AuthorizeURL)
	}
	e.expect(call(http.MethodPost, "/oauth/claude/complete", completeBody(s.LoginID, " ")), http.StatusUnprocessableEntity, "validation", "empty code")
	e.expect(call(http.MethodPost, "/oauth/claude/complete", completeBody(s.LoginID, "wrong#"+q.Get("state"))), http.StatusBadRequest, "oauth_exchange", "rejected code, the empty paste kept the attempt")
	s = e.begin("alice", aiserver.Claude)
	authorize(t, f, s)
	e.expect(call(http.MethodPost, "/oauth/claude/complete", completeBody(s.LoginID, "claude-code#other-state")), http.StatusBadRequest, "oauth_login", "foreign state")
	s = e.begin("alice", aiserver.Claude)
	q = authorize(t, f, s)
	e.expect(call(http.MethodPost, "/oauth/claude/complete", completeBody(s.LoginID, "claude-code#"+q.Get("state"))), http.StatusOK, `"email":"c@example.com"`, "claude connected")
	e.expect(call(http.MethodPost, "/claude/chat", `{"model":"claude-x","max_tokens":999999,"system":"Be brief.","messages":[{"role":"user","content":[{"type":"text","text":"Ahoj svet, ako sa mas?"}]}]}`), http.StatusOK, "message_start", "claude chat")
	var claudeBody struct {
		MaxTokens int `json:"max_tokens"`
		System    []struct {
			Text string `json:"text"`
		} `json:"system"`
	}
	f.Lock()
	_ = json.Unmarshal(f.LastBody, &claudeBody)
	if f.LastReq.URL.RawQuery != "beta=true" || !strings.Contains(f.LastReq.Header.Get("anthropic-beta"), "oauth-2025-04-20") || f.LastReq.Header.Get("x-app") != "cli" ||
		!strings.HasPrefix(f.LastReq.Header.Get("User-Agent"), "claude-cli/") || claudeBody.MaxTokens != 64000 || len(claudeBody.System) != 3 ||
		!strings.HasPrefix(claudeBody.System[0].Text, "x-anthropic-billing-header: cc_version=") || strings.Contains(claudeBody.System[0].Text, "cch=00000") ||
		!strings.Contains(claudeBody.System[1].Text, "official CLI for Claude") || claudeBody.System[2].Text != "Be brief." {
		t.Fatalf("claude request shape: %s %v", f.LastBody, f.LastReq.Header)
	}
	f.Unlock()
	e.store.expire("alice", aiserver.Claude)
	e.expect(call(http.MethodGet, "/claude/models", ""), http.StatusOK, `"id":"claude-x"`, "claude refresh and models")
	f.Lock()
	f.Access = "revoked"
	f.Unlock()
	e.expect(call(http.MethodPost, "/claude/chat", `{"model":"claude-x","messages":[]}`), http.StatusUnauthorized, "authentication_error", "upstream error passes through")
	// a model gated on a newer Claude Code version: the required version is adopted and the request sent once more,
	// after a refresh replaced the revoked access token
	f.Lock()
	f.ClaudeMin, f.Attempts = "2.9.300", 0
	f.Unlock()
	e.store.expire("alice", aiserver.Claude)
	e.expect(call(http.MethodPost, "/claude/chat", `{"model":"claude-x","messages":[{"role":"user","content":"Zork"}]}`), http.StatusOK, "message_start", "version adopted")
	f.Lock()
	if f.Attempts != 2 || !strings.Contains(string(f.LastBody), "cc_version=2.9.300.") || !strings.Contains(string(f.LastBody), "cc_entrypoint=cli;") {
		t.Fatalf("version retry: %d attempts, body %s", f.Attempts, f.LastBody)
	}
	f.Unlock()
	e.expect(call(http.MethodPost, "/claude/chat", `{"model":"claude-x","messages":[]}`), http.StatusOK, "message_start", "adopted version kept")
	f.Lock()
	if f.Attempts != 3 {
		t.Fatalf("adopted version not kept: %d attempts", f.Attempts)
	}
	f.ClaudeMin = "2.9.300-other"
	f.Unlock()
	e.expect(call(http.MethodPost, "/claude/chat", `{"model":"claude-x","messages":[]}`), http.StatusBadRequest, "claude_code_version_too_old", "unparseable minimum")
	f.Lock()
	if f.Attempts != 4 {
		t.Fatalf("retried without a usable version: %d attempts", f.Attempts)
	}
	f.ClaudeMin = ""
	f.Unlock()

	s = e.begin("alice", aiserver.Antigravity)
	q = authorize(t, f, s)
	u, _ = url.Parse(s.AuthorizeURL)
	if u.Path != "/o/oauth2/v2/auth" || q.Get("redirect_uri") != "https://antigravity.google/oauth-callback" || q.Get("access_type") != "offline" || q.Get("prompt") != "consent" || q.Get("code_challenge") == "" {
		t.Fatalf("google authorize url: %s", s.AuthorizeURL)
	}
	e.expect(call(http.MethodPost, "/oauth/antigravity/complete", completeBody(s.LoginID, "4/google-code")), http.StatusOK, `"email":"g@example.com"`, "antigravity connected")
	if c, _ := e.store.get("alice", aiserver.Antigravity); c.ProjectID != "proj-1" || c.Refresh != "ya29.g-rt" {
		t.Fatalf("antigravity credential: %+v", c)
	}
	e.expect(call(http.MethodGet, "/antigravity/models", ""), http.StatusOK, `{"models":[{"id":"gemini-3-pro","name":"Gemini 3 Pro"}]}`, "antigravity models")
	rec := call(http.MethodPost, "/antigravity/chat", `{"model":"gemini-3-pro","contents":[],"systemInstruction":{"parts":[{"text":"sys"}]}}`)
	e.expect(rec, http.StatusOK, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ahoj\"}]}}]}\n", "antigravity stream unwrapped")
	var envelope struct {
		Project     string `json:"project"`
		Model       string `json:"model"`
		RequestType string `json:"requestType"`
		Request     struct {
			Model             *string `json:"model"`
			SessionID         string  `json:"sessionId"`
			SystemInstruction struct {
				Role string `json:"role"`
			} `json:"systemInstruction"`
		} `json:"request"`
	}
	f.Lock()
	_ = json.Unmarshal(f.LastBody, &envelope)
	f.Unlock()
	if envelope.Project != "proj-1" || envelope.Model != "gemini-3-pro" || envelope.RequestType != "agent" || envelope.Request.Model != nil || envelope.Request.SystemInstruction.Role != "user" || envelope.Request.SessionID == "" {
		t.Fatalf("antigravity envelope: %+v", envelope)
	}
	e.expect(call(http.MethodPost, "/antigravity/chat", `{"contents":[]}`), http.StatusUnprocessableEntity, "model", "antigravity without model")
	// Google keeps the refresh token on refresh, the stored one stays usable
	e.store.expire("alice", aiserver.Antigravity)
	e.expect(call(http.MethodGet, "/antigravity/models", ""), http.StatusOK, "gemini-3-pro", "antigravity refresh")
	e.store.expire("alice", aiserver.Antigravity)
	e.expect(call(http.MethodGet, "/antigravity/models", ""), http.StatusOK, "gemini-3-pro", "second antigravity refresh")

	e.expect(call(http.MethodDelete, "/oauth/antigravity", ""), http.StatusNoContent, "", "disconnect")
	f.Lock()
	if len(f.Revoked) != 1 || f.Revoked[0] != "ya29.g-rt" {
		t.Fatalf("revocation: %v", f.Revoked)
	}
	f.Unlock()
	e.expect(call(http.MethodGet, "/status", ""), http.StatusOK, `"antigravity":{"kind":"oauth","enabled":true,"connected":false}`, "after disconnect")
	e.expect(call(http.MethodDelete, "/oauth/antigravity", ""), http.StatusNoContent, "", "disconnect twice")
}

// A store that seals with the browser's key: sign-ins work only with the key they were made with, a missing key
// fails before the attempt is used up, and Allowed gates use but never status or sign-out.
func TestKeyedStoreAndGating(t *testing.T) {
	f := aiservertest.NewVendors(t)
	e := newEnv(t, true, subscriptions, f.BaseURLs())
	e.key = "alice-key"
	e.allow()

	e.expect(e.call("alice", http.MethodPost, "/oauth/codex/start", ""), http.StatusForbidden, "oauth_disabled", "turned off")
	e.expect(e.call("alice", http.MethodGet, "/status", ""), http.StatusOK, `"codex":{"kind":"oauth","enabled":false,"connected":false}`, "status shows the gate")
	e.allow(aiserver.Codex, aiserver.Claude, aiserver.Antigravity)

	s := e.begin("alice", aiserver.Codex)
	f.Lock()
	f.Approved = true
	f.Unlock()
	e.expect(e.callKey("alice", "", http.MethodPost, "/oauth/codex/complete", completeBody(s.LoginID, "")), http.StatusUnauthorized, "oauth_key_missing", "complete without key")
	e.expect(e.call("alice", http.MethodPost, "/oauth/codex/complete", completeBody(s.LoginID, "")), http.StatusOK, `"key_match":true`, "the attempt survived the missing key")
	e.expect(e.callKey("alice", "other-key", http.MethodGet, "/status", ""), http.StatusOK, `"key_match":false`, "another browser's status")
	if rec := e.callKey("alice", "", http.MethodGet, "/status", ""); strings.Contains(rec.Body.String(), "key_match") {
		t.Fatalf("status without key: %s", rec.Body.String())
	}
	e.expect(e.callKey("alice", "other-key", http.MethodGet, "/codex/models", ""), http.StatusConflict, "oauth_key_mismatch", "another browser's key")
	e.expect(e.call("alice", http.MethodGet, "/codex/models", ""), http.StatusOK, "gpt-codex", "the browser that signed in")

	e.allow()
	e.expect(e.call("alice", http.MethodPost, "/codex/chat", `{"model":"gpt-codex","input":[]}`), http.StatusForbidden, "oauth_disabled", "chat turned off")
	e.expect(e.callKey("alice", "other-key", http.MethodDelete, "/oauth/codex", ""), http.StatusNoContent, "", "sign-out with the toggle off and another key")
	e.expect(e.call("alice", http.MethodGet, "/status", ""), http.StatusOK, `"codex":{"kind":"oauth","enabled":false,"connected":false}`, "signed out")
}

// Concurrent requests with an expiring token refresh it once: refresh tokens rotate, so a second refresh with the
// old one would kill the sign-in.
func TestConcurrentRefresh(t *testing.T) {
	f := aiservertest.NewVendors(t)
	e := newEnv(t, false, subscriptions, f.BaseURLs())
	s := e.begin("alice", aiserver.Claude)
	q := authorize(t, f, s)
	e.expect(e.call("alice", http.MethodPost, "/oauth/claude/complete", completeBody(s.LoginID, "claude-code#"+q.Get("state"))), http.StatusOK, "c@example.com", "claude connected")
	e.store.expire("alice", aiserver.Claude)
	done := make(chan int, 8)
	for range 8 {
		go func() { done <- e.call("alice", http.MethodGet, "/claude/models", "").Code }()
	}
	for range 8 {
		if code := <-done; code != http.StatusOK {
			t.Fatalf("concurrent models: %d", code)
		}
	}
	f.Lock()
	defer f.Unlock()
	refreshes := 0
	for _, g := range f.Grants {
		if g == "refresh_token" {
			refreshes++
		}
	}
	if refreshes != 1 {
		t.Fatalf("refreshes: %d (%v)", refreshes, f.Grants)
	}
}

// The package ships no Antigravity client: without one from the host the provider is not offered.
func TestAntigravityNeedsHostClient(t *testing.T) {
	h := aiserver.New(aiserver.Config{
		Prefix:    "/api/ai/",
		Providers: subscriptions,
		User:      func(*http.Request) (string, error) { return "alice", nil },
		Store:     newMemStore(false),
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ai/status", nil))
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "antigravity") || !strings.Contains(rec.Body.String(), "claude") {
		t.Fatalf("status without a client: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/ai/oauth/antigravity/start", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("start without a client: %d %s", rec.Code, rec.Body.String())
	}
}
