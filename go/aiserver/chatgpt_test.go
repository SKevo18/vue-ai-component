package aiserver_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/SKevo18/vue-ai-component/go/aiserver"
	"github.com/SKevo18/vue-ai-component/go/aiserver/aiservertest"
)

func TestChatGPTFlow(t *testing.T) {
	issuer := aiservertest.NewIssuer(t)
	e := newEnv(t, true, []string{aiserver.ChatGPT}, issuer.BaseURLs())
	e.key = "alice-key"
	set := func(fn func()) {
		issuer.Lock()
		defer issuer.Unlock()
		fn()
	}
	start := func() (string, url.Values) {
		t.Helper()
		s := e.begin("alice", aiserver.ChatGPT)
		if s.Flow != "code" || !strings.HasPrefix(s.AuthorizeURL, issuer.URL+"/api/accounts/authorize?") {
			t.Fatalf("start: %+v", s)
		}
		u, _ := url.Parse(s.AuthorizeURL)
		q := u.Query()
		set(func() { issuer.Challenge, issuer.Nonce = q.Get("code_challenge"), q.Get("nonce") })
		return s.LoginID, q
	}
	callback := func(state, code, clientID string) string {
		cb := url.Values{}
		cb.Set("state", state)
		cb.Set("code", code)
		cb.Set("scope", aiservertest.FullScope)
		if clientID != "" {
			cb.Set("client_id", clientID)
		}
		return "http://127.0.0.1:1455/auth/callback?" + cb.Encode()
	}
	complete := func(user, key, loginID, pasted string) *httptest.ResponseRecorder {
		return e.callKey(user, key, http.MethodPost, "/oauth/chatgpt/complete", completeBody(loginID, pasted))
	}

	e.expect(e.call("alice", http.MethodGet, "/status", ""), http.StatusOK, `"chatgpt":{"kind":"oauth","enabled":true,"connected":false}`, "initial status")
	e.expect(e.call("alice", http.MethodPost, "/chatgpt/chat", `{"model":"gpt-foo","input":[]}`), http.StatusForbidden, "not_connected", "chat before connect")

	// the first sign-in registers dynamically with the app name and a stable host id
	_, q := start()
	for k, want := range map[string]string{"client_id": "dynamic_agent_client", "agent_name_hint": "Test App", "response_type": "code", "redirect_uri": "http://127.0.0.1:1455/auth/callback", "resource": "https://api.openai.com/v1", "code_challenge_method": "S256", "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"} {
		if q.Get(k) != want {
			t.Fatalf("authorize %s = %q, want %q", k, q.Get(k), want)
		}
	}
	hostID := q.Get("ext_agent_host_id")
	if !strings.HasPrefix(hostID, "urn:uuid:") || len(hostID) != len("urn:uuid:")+36 || q.Get("state") == "" || q.Get("nonce") == "" {
		t.Fatalf("authorize params: %v", q)
	}
	if _, again := start(); again.Get("ext_agent_host_id") != hostID || again.Get("state") == q.Get("state") {
		t.Fatalf("a second start keeps the host id and rotates the state: %v", again)
	}

	// rejected callbacks: another attempt's state, another user, no issued client id, denied consent, not loopback
	id, _ := start()
	e.expect(complete("alice", e.key, id, callback("nope", "code-1", "oaiapp_test")), http.StatusBadRequest, "oauth_login", "foreign state")
	id, q = start()
	e.expect(complete("bob", e.key, id, callback(q.Get("state"), "code-1", "oaiapp_test")), http.StatusBadRequest, "oauth_login", "another user's attempt")
	e.expect(complete("alice", e.key, id, callback(q.Get("state"), "code-1", "")), http.StatusBadRequest, "oauth_registration", "missing client id")
	id, q = start()
	e.expect(complete("alice", e.key, id, "http://127.0.0.1:1455/auth/callback?error=access_denied&state="+q.Get("state")), http.StatusBadRequest, "oauth_denied", "denied")
	id, _ = start()
	e.expect(complete("alice", e.key, id, "http://localhost:1455/auth/callback?code=x&state=y"), http.StatusUnprocessableEntity, `"code"`, "non-loopback address")

	// plan scope not granted: the identity is fine but the sign-in is refused
	set(func() { issuer.Scope = "email openid profile" })
	id, q = start()
	e.expect(complete("alice", e.key, id, callback(q.Get("state"), "code-1", "oaiapp_test")), http.StatusForbidden, "oauth_plan_not_enabled", "missing plan scope")
	set(func() { issuer.Scope, issuer.Code = aiservertest.FullScope, "code-2" })

	id, q = start()
	set(func() { issuer.Nonce = "other-nonce" })
	e.expect(complete("alice", e.key, id, callback(q.Get("state"), "code-2", "oaiapp_test")), http.StatusBadRequest, "oauth_id_token", "nonce mismatch")
	set(func() { issuer.Code = "code-3" })
	id, q = start()
	e.expect(complete("alice", "", id, callback(q.Get("state"), "code-3", "oaiapp_test")), http.StatusUnauthorized, "oauth_key_missing", "complete without key")
	e.expect(complete("alice", e.key, id, callback(q.Get("state"), "code-3", "oaiapp_test")), http.StatusOK, `"chatgpt":{"kind":"oauth","enabled":true,"connected":true,"email":"x@example.com","account_id":"user-sub-1"`, "connected")
	e.expect(complete("alice", e.key, id, callback(q.Get("state"), "code-3", "oaiapp_test")), http.StatusBadRequest, "oauth_login", "single use")
	if c, _ := e.store.get("alice", aiserver.ChatGPT); c.ClientID != "oaiapp_test" || c.HostID != hostID || !strings.HasPrefix(c.IDToken, "eyJ") || c.Access != "at-1" {
		t.Fatalf("stored credential: %+v", c)
	}
	e.expect(e.call("bob", http.MethodGet, "/status", ""), http.StatusOK, `"chatgpt":{"kind":"oauth","enabled":true,"connected":false}`, "bob does not see alice's sign-in")
	e.expect(e.callKey("alice", "other-key", http.MethodGet, "/chatgpt/models", ""), http.StatusConflict, "oauth_key_mismatch", "models with another key")

	e.expect(e.call("alice", http.MethodGet, "/chatgpt/models", ""), http.StatusOK, `{"models":[{"id":"gpt-foo","name":"GPT Foo"}]}`, "models")
	set(func() {
		if issuer.LastAuth != "Bearer at-1" {
			t.Fatalf("models bearer: %s", issuer.LastAuth)
		}
	})
	rec := e.call("alice", http.MethodPost, "/chatgpt/chat", `{"model":"gpt-foo","input":[{"role":"user","content":"hi"}],"store":true,"stream":false,"temperature":0.2,"top_p":0.9,"max_output_tokens":5,"previous_response_id":"r1"}`)
	e.expect(rec, http.StatusOK, `"delta":"hi"`, "responses")
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/event-stream") || !strings.Contains(rec.Body.String(), "response.completed") {
		t.Fatalf("responses stream: %v %s", rec.Header(), rec.Body.String())
	}
	set(func() {
		var sent map[string]any
		_ = json.Unmarshal(issuer.LastResp, &sent)
		if sent["store"] != false || sent["stream"] != true || sent["model"] != "gpt-foo" {
			t.Fatalf("store and stream must be forced: %s", issuer.LastResp)
		}
		for _, k := range []string{"temperature", "top_p", "max_output_tokens", "previous_response_id"} {
			if _, ok := sent[k]; ok {
				t.Fatalf("%s must be stripped: %s", k, issuer.LastResp)
			}
		}
		issuer.PlanError = "subscription_sharing_usage_limit_exceeded"
	})

	// plan errors keep the upstream status and get a readable message
	rec = e.call("alice", http.MethodPost, "/chatgpt/chat", `{"model":"gpt-foo","input":[]}`)
	e.expect(rec, http.StatusTooManyRequests, `"code":"subscription_sharing_usage_limit_exceeded"`, "plan error")
	e.expect(rec, http.StatusTooManyRequests, "chatgpt.com/settings/usage", "plan error text")
	set(func() { issuer.PlanError = "" })

	// refresh renews with the rotating refresh token and the issued client id
	e.store.expire("alice", aiserver.ChatGPT)
	e.expect(e.call("alice", http.MethodGet, "/chatgpt/models", ""), http.StatusOK, "gpt-foo", "models after expiry")
	e.expect(e.call("alice", http.MethodGet, "/chatgpt/models", ""), http.StatusOK, "gpt-foo", "fresh token")
	set(func() {
		if issuer.LastAuth != "Bearer at-1r" || len(issuer.Grants) == 0 || issuer.Grants[len(issuer.Grants)-1] != "refresh_token" {
			t.Fatalf("refresh: auth=%s grants=%v", issuer.LastAuth, issuer.Grants)
		}
	})
	if c, _ := e.store.get("alice", aiserver.ChatGPT); c.IDToken == "" || c.ClientID != "oaiapp_test" {
		t.Fatalf("a refresh without an id token keeps the stored one: %+v", c)
	}

	// a dead refresh token drops the sign-in and keeps the registration
	e.store.expire("alice", aiserver.ChatGPT)
	set(func() { issuer.Refresh = "revoked-elsewhere" })
	e.expect(e.call("alice", http.MethodGet, "/chatgpt/models", ""), http.StatusForbidden, "oauth_expired", "dead refresh")
	e.expect(e.call("alice", http.MethodGet, "/status", ""), http.StatusOK, `"chatgpt":{"kind":"oauth","enabled":true,"connected":false}`, "status after dead refresh")

	// a returning sign-in reuses the issued client id and drops the name hint
	id, q = start()
	if q.Get("client_id") != "oaiapp_test" || q.Has("agent_name_hint") || q.Get("ext_agent_host_id") != hostID {
		t.Fatalf("returning authorize params: %v", q)
	}
	set(func() { issuer.Code, issuer.Refresh, issuer.Access = "code-4", "rt-2", "at-2" })
	e.expect(complete("alice", e.key, id, callback(q.Get("state"), "code-4", "oaiapp_other")), http.StatusBadRequest, "oauth_client_mismatch", "client mismatch")
	id, q = start()
	e.expect(complete("alice", e.key, id, callback(q.Get("state"), "code-4", "")), http.StatusOK, `"connected":true`, "reconnect")
	_, q = start()
	if !strings.HasPrefix(q.Get("id_token_hint"), "eyJ") {
		t.Fatalf("a signed-in start sends the retained id token: %v", q)
	}

	// sign-out revokes the refresh token, the registration stays
	e.expect(e.call("alice", http.MethodDelete, "/oauth/chatgpt", ""), http.StatusNoContent, "", "disconnect")
	set(func() {
		if len(issuer.Revoked) != 1 || issuer.Revoked[0] != "rt-2" {
			t.Fatalf("revoked: %v", issuer.Revoked)
		}
	})
	e.expect(e.call("alice", http.MethodGet, "/chatgpt/models", ""), http.StatusForbidden, "not_connected", "models after disconnect")
	if _, q := start(); q.Get("client_id") != "oaiapp_test" || q.Get("ext_agent_host_id") != hostID {
		t.Fatalf("the registration must survive the sign-out: %v", q)
	}
	e.expect(e.call("alice", http.MethodDelete, "/oauth/chatgpt", ""), http.StatusNoContent, "", "disconnect twice")
}
