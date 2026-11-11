// Package aiservertest has fake AI vendors for tests of aiserver and of the apps that mount it. Each fake is an
// httptest server whose BaseURLs go into aiserver.Config.BaseURLs. The exported fields are the fake's state: hold
// the embedded mutex while reading or changing them.
package aiservertest

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/SKevo18/vue-ai-component/go/aiserver"
)

// TB is the part of testing.TB the fakes use, so that a fixture program can run them too.
type TB interface {
	Helper()
	Cleanup(fn func())
	Fatal(args ...any)
}

// Vendors plays every host the subscription sign-ins talk to: auth.openai.com (device code, token) and the Codex
// backend, claude.ai and api.anthropic.com, Google's OAuth endpoints and Cloud Code Assist. The device code is
// ABCD-1234, the Claude code "claude-code", the Google code "4/google-code".
type Vendors struct {
	URL string

	sync.Mutex
	// Approved confirms the Codex device code.
	Approved bool
	// Polls counts the Codex device polls.
	Polls int
	// Challenge is the PKCE challenge of the current Claude or Google sign-in; the test copies it from the
	// authorize URL.
	Challenge string
	// Access and Refresh are the currently valid tokens.
	Access, Refresh string
	// Dead makes every refresh fail with a dead-token error.
	Dead bool
	// Grants lists the grant types seen.
	Grants []string
	// LastReq and LastBody are the last chat request.
	LastReq  *http.Request
	LastBody []byte
	// ClaudeMin, when set, makes /v1/messages reject other claude-cli versions like Anthropic's model gate.
	ClaudeMin string
	// Attempts counts the /v1/messages requests.
	Attempts int
	// Originator, when set, is the originator header Codex requests must carry; else any non-empty one passes.
	Originator string
	// Revoked lists the tokens revoked at Google.
	Revoked []string

	onboarded bool
}

// NewVendors starts a Vendors server, closed when the test ends.
func NewVendors(t TB) *Vendors {
	f := &Vendors{}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	f.URL = srv.URL
	return f
}

// BaseURLs points every subscription vendor origin at the fake.
func (f *Vendors) BaseURLs() map[string]string {
	out := map[string]string{}
	for _, k := range []string{"codex.issuer", "codex.api", "claude.auth", "claude.api", "google.auth", "google.token", "google.api", "antigravity.api"} {
		out[k] = f.URL
	}
	return out
}

// codexJWT is an unsigned access token with the Codex account and profile claims.
func codexJWT(account, email string) string {
	return encode(map[string]string{"alg": "none"}) + "." + encode(map[string]any{
		"https://api.openai.com/auth":    map[string]string{"chatgpt_account_id": account},
		"https://api.openai.com/profile": map[string]string{"email": email},
	}) + ".sig"
}

func encode(v any) string {
	b, _ := json.Marshal(v)
	return base64.RawURLEncoding.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ServeHTTP implements http.Handler.
func (f *Vendors) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.Lock()
	defer f.Unlock()
	body, _ := io.ReadAll(r.Body)
	checkPKCE := func(verifier string) bool {
		sum := sha256.Sum256([]byte(verifier))
		return base64.RawURLEncoding.EncodeToString(sum[:]) == f.Challenge
	}
	issue := func(access string) map[string]any {
		f.Access, f.Refresh = access, access+"-rt"
		return map[string]any{"access_token": f.Access, "refresh_token": f.Refresh, "expires_in": 3600}
	}
	rotate := func(rt string) (map[string]any, bool) {
		if f.Dead || rt != f.Refresh {
			return nil, false
		}
		f.Access += "r"
		f.Refresh += "r"
		return map[string]any{"access_token": f.Access, "refresh_token": f.Refresh, "expires_in": 3600}, true
	}
	switch r.URL.Path {
	case "/api/accounts/deviceauth/usercode":
		var in map[string]string
		_ = json.Unmarshal(body, &in)
		if in["client_id"] != "app_EMoamEEZ73f0CkXaXp7hrann" {
			writeJSON(w, 400, map[string]string{"error": "invalid_client"})
			return
		}
		writeJSON(w, 200, map[string]string{"device_auth_id": "dev-1", "user_code": "ABCD-1234", "interval": "1"})
	case "/api/accounts/deviceauth/token":
		f.Polls++
		var in map[string]string
		_ = json.Unmarshal(body, &in)
		if in["device_auth_id"] != "dev-1" || in["user_code"] != "ABCD-1234" {
			writeJSON(w, 400, map[string]any{"error": map[string]string{"code": "bad_device"}})
			return
		}
		if !f.Approved {
			writeJSON(w, 403, map[string]any{"error": map[string]string{"code": "deviceauth_authorization_pending"}})
			return
		}
		writeJSON(w, 200, map[string]string{"authorization_code": "dev-code", "code_verifier": "dev-verifier"})
	case "/oauth/token":
		form, _ := url.ParseQuery(string(body))
		f.Grants = append(f.Grants, form.Get("grant_type"))
		if form.Get("client_id") != "app_EMoamEEZ73f0CkXaXp7hrann" {
			writeJSON(w, 400, map[string]string{"error": "invalid_client"})
			return
		}
		if form.Get("grant_type") == "refresh_token" {
			out, ok := rotate(form.Get("refresh_token"))
			if !ok {
				writeJSON(w, 401, map[string]any{"error": map[string]string{"code": "refresh_token_reused", "message": "reused"}})
				return
			}
			f.Access = codexJWT("acct-1", "")
			out["access_token"] = f.Access
			writeJSON(w, 200, out)
			return
		}
		if form.Get("code") != "dev-code" || form.Get("code_verifier") != "dev-verifier" || form.Get("redirect_uri") != f.URL+"/deviceauth/callback" {
			writeJSON(w, 400, map[string]string{"error": "invalid_grant"})
			return
		}
		writeJSON(w, 200, issue(codexJWT("acct-1", "Al@Example.com")))
	case "/codex/models", "/codex/responses":
		f.LastReq = r.Clone(r.Context())
		originator := r.Header.Get("originator")
		if r.Header.Get("Authorization") != "Bearer "+f.Access || r.Header.Get("chatgpt-account-id") != "acct-1" || originator == "" || (f.Originator != "" && originator != f.Originator) {
			writeJSON(w, 401, map[string]any{"error": map[string]string{"code": "token_invalid", "message": "bad token"}})
			return
		}
		if r.URL.Path == "/codex/models" {
			writeJSON(w, 200, map[string]any{"models": []map[string]string{{"slug": "gpt-codex", "display_name": "GPT Codex", "visibility": "list"}, {"slug": "gpt-hidden", "visibility": "hide"}}})
			return
		}
		f.LastBody = body
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"))
	case "/v1/oauth/token":
		var in map[string]string
		_ = json.Unmarshal(body, &in)
		f.Grants = append(f.Grants, in["grant_type"])
		if in["client_id"] != "9d1c250a-e61b-44d9-88ed-5944d1962f5e" {
			writeJSON(w, 400, map[string]string{"error": "invalid_client"})
			return
		}
		if in["grant_type"] == "refresh_token" {
			out, ok := rotate(in["refresh_token"])
			if !ok || r.Header.Get("anthropic-beta") != "oauth-2025-04-20" {
				writeJSON(w, 400, map[string]string{"error": "invalid_grant", "error_description": "Refresh token expired"})
				return
			}
			writeJSON(w, 200, out)
			return
		}
		if in["code"] != "claude-code" || !checkPKCE(in["code_verifier"]) || in["redirect_uri"] != "https://platform.claude.com/oauth/code/callback" || in["state"] == "" {
			writeJSON(w, 400, map[string]string{"error": "invalid_grant"})
			return
		}
		out := issue("sk-ant-oat-1")
		out["account"] = map[string]string{"uuid": "claude-acct", "email_address": "c@example.com"}
		writeJSON(w, 200, out)
	case "/v1/messages":
		f.LastReq, f.LastBody = r.Clone(r.Context()), body
		f.Attempts++
		if r.Header.Get("Authorization") != "Bearer "+f.Access {
			writeJSON(w, 401, map[string]any{"type": "error", "error": map[string]string{"type": "authentication_error", "message": "invalid token"}})
			return
		}
		if v, _, _ := strings.Cut(strings.TrimPrefix(r.Header.Get("User-Agent"), "claude-cli/"), " "); f.ClaudeMin != "" && v != f.ClaudeMin {
			writeJSON(w, 400, map[string]any{"type": "error", "error": map[string]any{
				"type":    "invalid_request_error",
				"message": "Claude Code " + v + " does not support this model; version " + f.ClaudeMin + " or newer is required. Run 'claude update', or update the Claude desktop app, then try again.",
				"details": map[string]string{"error_code": "claude_code_version_too_old"},
			}})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: message_start\ndata: {\"type\":\"message_start\"}\n\n"))
	case "/v1/models":
		writeJSON(w, 200, map[string]any{"data": []map[string]string{{"id": "claude-x", "display_name": "Claude X"}}})
	case "/token":
		form, _ := url.ParseQuery(string(body))
		f.Grants = append(f.Grants, form.Get("grant_type"))
		if form.Get("client_id") != AntigravityClient.ClientID || form.Get("client_secret") != AntigravityClient.ClientSecret {
			writeJSON(w, 401, map[string]string{"error": "invalid_client"})
			return
		}
		if form.Get("grant_type") == "refresh_token" {
			out, ok := rotate(form.Get("refresh_token"))
			if !ok {
				writeJSON(w, 400, map[string]string{"error": "invalid_grant"})
				return
			}
			// Google keeps the refresh token
			delete(out, "refresh_token")
			f.Refresh = strings.TrimSuffix(f.Refresh, "r")
			writeJSON(w, 200, out)
			return
		}
		if form.Get("code") != "4/google-code" || !checkPKCE(form.Get("code_verifier")) || form.Get("redirect_uri") != "https://antigravity.google/oauth-callback" {
			writeJSON(w, 400, map[string]string{"error": "invalid_grant"})
			return
		}
		writeJSON(w, 200, issue("ya29.g"))
	case "/revoke":
		form, _ := url.ParseQuery(string(body))
		f.Revoked = append(f.Revoked, form.Get("token"))
	case "/oauth2/v1/userinfo":
		writeJSON(w, 200, map[string]string{"id": "g-1", "email": "g@example.com"})
	case "/v1internal:loadCodeAssist":
		if r.Header.Get("User-Agent") == "" || r.Header.Get("Authorization") != "Bearer "+f.Access {
			writeJSON(w, 401, map[string]any{"error": map[string]string{"status": "UNAUTHENTICATED"}})
			return
		}
		if !f.onboarded {
			writeJSON(w, 200, map[string]any{"allowedTiers": []map[string]string{{"id": "free-tier"}}})
			return
		}
		writeJSON(w, 200, map[string]any{"currentTier": map[string]string{"id": "free-tier"}, "cloudaicompanionProject": "proj-1"})
	case "/v1internal:onboardUser":
		writeJSON(w, 200, map[string]any{"name": "operations/op-1", "done": false})
	case "/v1internal/operations/op-1":
		f.onboarded = true
		writeJSON(w, 200, map[string]any{"name": "operations/op-1", "done": true})
	case "/v1internal:fetchAvailableModels":
		writeJSON(w, 200, map[string]any{"models": map[string]any{"gemini-3-pro": map[string]any{"displayName": "Gemini 3 Pro"}, "chat_20706": map[string]any{}, "secret": map[string]any{"isInternal": true}}})
	case "/v1internal:streamGenerateContent":
		f.LastReq, f.LastBody = r.Clone(r.Context()), body
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ahoj\"}]}}]},\"traceId\":\"t\"}\r\n\r\n"))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// Keys plays the OpenAI, Anthropic and Gemini key APIs and accepts the key "good". A chat request whose body
// contains "fail" answers 429.
type Keys struct {
	URL string

	sync.Mutex
	// Last and Body are the last request.
	Last *http.Request
	Body []byte
}

// NewKeys starts a Keys server, closed when the test ends.
func NewKeys(t TB) *Keys {
	f := &Keys{}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	f.URL = srv.URL
	return f
}

// BaseURLs points the key vendor origins at the fake.
func (f *Keys) BaseURLs() map[string]string {
	return map[string]string{"openai": f.URL, "anthropic": f.URL, "gemini": f.URL}
}

// ServeHTTP implements http.Handler.
func (f *Keys) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.Lock()
	defer f.Unlock()
	f.Last = r.Clone(r.Context())
	f.Body, _ = io.ReadAll(r.Body)
	key := r.Header.Get("x-api-key") + r.Header.Get("x-goog-api-key") + strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if key != "good" {
		status := http.StatusUnauthorized
		if r.Header.Get("x-goog-api-key") != "" {
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]any{"error": map[string]string{"type": "authentication_error", "message": "invalid key"}})
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/v1/models" && r.Header.Get("anthropic-version") != "":
		writeJSON(w, 200, map[string]any{"data": []map[string]string{{"id": "claude-new", "display_name": "Claude New"}, {"id": "claude-old", "display_name": "Claude Old"}}})
	case r.Method == http.MethodGet && r.URL.Path == "/v1/models":
		writeJSON(w, 200, map[string]any{"data": []map[string]any{
			{"id": "gpt-4o", "created": 100},
			{"id": "gpt-5", "created": 200},
			{"id": "o3", "created": 150},
			{"id": "text-embedding-3-small", "created": 300},
			{"id": "gpt-image-1", "created": 300},
			{"id": "dall-e-3", "created": 10},
		}})
	case r.URL.Path == "/v1beta/models":
		writeJSON(w, 200, map[string]any{"models": []map[string]any{
			{"name": "models/gemini-2.5-flash", "displayName": "Gemini 2.5 Flash", "supportedGenerationMethods": []string{"generateContent", "countTokens"}},
			{"name": "models/gemini-3-pro", "displayName": "Gemini 3 Pro", "supportedGenerationMethods": []string{"generateContent"}},
			{"name": "models/text-embedding-004", "supportedGenerationMethods": []string{"embedContent"}},
		}})
	case strings.Contains(string(f.Body), `"fail"`):
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": map[string]string{"type": "rate_limit_error", "message": "slow down"}})
	default:
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: {\"delta\":\"foo\"}\n\n"))
		w.(http.Flusher).Flush()
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}
}

// Issuer plays auth.openai.com and api.openai.com for Sign in with ChatGPT: the token exchange with PKCE and
// rotating refresh tokens (client id oaiapp_test), JWKS, revocation, the model catalog and a Responses stream.
type Issuer struct {
	URL string
	key *rsa.PrivateKey

	sync.Mutex
	// Nonce is the nonce the next id token carries; the test copies it from the authorize URL.
	Nonce string
	// Scope is the scope the next token response grants.
	Scope string
	// Code is the one valid authorization code; Challenge the PKCE challenge it was issued for.
	Code, Challenge string
	// Access and Refresh are the currently valid tokens.
	Access, Refresh string
	// Revoked lists the revoked tokens, Grants the grant types seen.
	Revoked, Grants []string
	// LastResp is the last /v1/responses body, LastAuth the bearer of the last API call.
	LastResp []byte
	LastAuth string
	// PlanError, when set, makes /v1/responses fail with this error code.
	PlanError string
}

// AntigravityClient is the only OAuth client the Google fake accepts; pass it as aiserver.Config.Antigravity.
var AntigravityClient = aiserver.OAuthClient{ClientID: "fake-antigravity.apps.googleusercontent.com", ClientSecret: "fake-antigravity-secret"}

// FullScope is the scope a sign-in that allows plan use grants.
const FullScope = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke"

// NewIssuer starts an Issuer server, closed when the test ends.
func NewIssuer(t TB) *Issuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &Issuer{key: key, Scope: FullScope, Code: "code-1", Refresh: "rt-1", Access: "at-1"}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	f.URL = srv.URL
	return f
}

// BaseURLs points the Sign in with ChatGPT origins at the fake.
func (f *Issuer) BaseURLs() map[string]string {
	return map[string]string{"chatgpt.issuer": f.URL, "chatgpt.api": f.URL}
}

// ServeHTTP implements http.Handler.
func (f *Issuer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.Lock()
	defer f.Unlock()
	switch r.URL.Path {
	case "/.well-known/openid-configuration":
		writeJSON(w, 200, map[string]string{"revocation_endpoint": f.URL + "/api/accounts/oauth/revoke"})
	case "/.well-known/jwks.json":
		pub := f.key.PublicKey
		writeJSON(w, 200, map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "kid": "k1", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
		}}})
	case "/api/accounts/oauth/token":
		_ = r.ParseForm()
		f.Grants = append(f.Grants, r.Form.Get("grant_type"))
		fail := func(code string) { writeJSON(w, http.StatusBadRequest, map[string]string{"error": code}) }
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if r.Form.Get("code") != f.Code || base64.RawURLEncoding.EncodeToString(sum[:]) != f.Challenge || r.Form.Get("redirect_uri") != "http://127.0.0.1:1455/auth/callback" || r.Form.Get("client_id") == "dynamic_agent_client" {
				fail("invalid_grant")
				return
			}
			f.Code = ""
		case "refresh_token":
			if r.Form.Get("refresh_token") != f.Refresh || r.Form.Get("client_id") != "oaiapp_test" {
				fail("invalid_grant")
				return
			}
			f.Refresh += "r"
			f.Access += "r"
		default:
			fail("unsupported_grant_type")
			return
		}
		resp := map[string]any{"access_token": f.Access, "refresh_token": f.Refresh, "token_type": "Bearer", "expires_in": 3600, "scope": f.Scope}
		if r.Form.Get("grant_type") == "authorization_code" {
			resp["id_token"] = f.idToken(r.Form.Get("client_id"))
		}
		writeJSON(w, 200, resp)
	case "/api/accounts/oauth/revoke":
		_ = r.ParseForm()
		f.Revoked = append(f.Revoked, r.Form.Get("token"))
	case "/v1/models":
		f.LastAuth = r.Header.Get("Authorization")
		if f.LastAuth != "Bearer "+f.Access {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"detail": "bad token"})
			return
		}
		writeJSON(w, 200, map[string]any{"models": []map[string]string{{"slug": "gpt-foo", "display_name": "GPT Foo", "visibility": "list"}, {"slug": "gpt-hidden", "display_name": "Hidden", "visibility": "hidden"}}})
	case "/v1/responses":
		f.LastAuth = r.Header.Get("Authorization")
		f.LastResp, _ = io.ReadAll(r.Body)
		if f.PlanError != "" {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": map[string]string{"code": f.PlanError, "message": "upstream text", "type": "invalid_request_error"}})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"))
		w.(http.Flusher).Flush()
		_, _ = w.Write([]byte("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n"))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *Issuer) idToken(aud string) string {
	head := encode(map[string]string{"alg": "RS256", "kid": "k1", "typ": "JWT"})
	claims := encode(map[string]any{"iss": f.URL, "aud": aud, "sub": "user-sub-1", "email": "x@example.com", "nonce": f.Nonce, "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix()})
	sum := sha256.Sum256([]byte(head + "." + claims))
	sig, _ := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, sum[:])
	return head + "." + claims + "." + base64.RawURLEncoding.EncodeToString(sig)
}
