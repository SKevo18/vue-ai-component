// Package aiserver is the server side of vue-ai-component's createServerBackend. It signs users in to AI vendors
// with the subscriptions they already have (ChatGPT through the Codex CLI and through Sign in with ChatGPT, Claude,
// Google Antigravity) or with API keys, keeps the credentials through a host Store, refreshes subscription tokens and
// proxies the browser's vendor-native chat requests, streaming the answers back.
//
// The vendors redirect only to addresses registered for their own clients, so a web app on its own domain never
// receives an OAuth callback. Each flow uses the least painful step its vendor offers instead: Codex has a device
// code (the user types a short code at OpenAI while the browser polls), Claude and Antigravity end on a vendor page
// that shows a code to paste back, and Sign in with ChatGPT ends on a loopback address the user pastes back.
//
// Routes, relative to Config.Prefix:
//
//	GET    status                     {"providers": {id: status}}
//	PUT    keys/{provider}            {"api_key"} verifies and stores a key, answers the status
//	DELETE keys/{provider}            204
//	POST   oauth/{provider}/start     {"flow": "device"|"code", "login_id", ...}
//	POST   oauth/{provider}/complete  {"login_id", "code"} answers the status, or 202 {"pending": true}
//	DELETE oauth/{provider}           204, revoking the vendor session where the vendor allows it
//	GET    {provider}/models          {"models": [{"id", "name"}]}
//	POST   {provider}/chat            the vendor's native request, the answer streamed back unchanged
package aiserver

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"time"
)

// Provider ids. Key providers take an API key, the others a subscription sign-in.
const (
	OpenAI      = "openai"
	Anthropic   = "anthropic"
	Gemini      = "gemini"
	Codex       = "codex"
	Claude      = "claude"
	Antigravity = "antigravity"
	ChatGPT     = "chatgpt"
)

const (
	maxBody         = 1 << 20  // vendor metadata responses and request bodies other than chat
	maxErrorBody    = 64 << 10 // upstream chat error bodies
	maxChatBody     = 8 << 20  // bounded images and PDF pages in chat requests
	upstreamTimeout = 5 * time.Minute
)

var keyVendors = map[string]vendor{OpenAI: openaiVendor{}, Anthropic: anthropicVendor{}, Gemini: geminiVendor{}}

var oauthVendors = map[string]oauthVendor{Codex: codexVendor{}, Claude: claudeVendor{}, Antigravity: antigravityVendor{}, ChatGPT: chatgptVendor{}}

// Config wires a Handler into its host.
type Config struct {
	// Prefix is the path the handler serves, with a trailing slash, for example "/api/ai/".
	Prefix string
	// Providers lists the enabled provider ids in status order. New panics on an unknown id and leaves out
	// antigravity when Antigravity has no client.
	Providers []string
	// User names the signed-in user of a request. Its error is written as is, typically a 401.
	User func(r *http.Request) (string, error)
	// Store keeps the credentials.
	Store Store
	// Allowed reports whether the user may sign in to and use an enabled provider. Nil allows all of them. Status,
	// sign-out and key removal ignore it, so a user can always see and remove a stored credential.
	Allowed func(r *http.Request, user, provider string) (bool, error)
	// BaseURLs overrides vendor origins by name: openai, anthropic, gemini, codex.issuer, codex.api, chatgpt.issuer,
	// chatgpt.api, claude.auth, claude.api, google.auth, google.token, google.api, antigravity.api.
	BaseURLs map[string]string
	// Originator names the app in the Codex originator header and, unless AgentName is set, in the Sign in with
	// ChatGPT registration. The Codex CLI itself sends codex_cli_rs.
	Originator string
	// AgentName is the app name OpenAI shows when the first Sign in with ChatGPT registers the app.
	AgentName string
	// Antigravity is the OAuth client of the Antigravity sign-in. The package ships none: without both values the
	// antigravity provider is not offered.
	Antigravity OAuthClient
	// Client sends the vendor requests. Nil uses a client with a five minute timeout.
	Client *http.Client
	// Log receives vendor failures. Nil discards them.
	Log *slog.Logger
	// WriteError renders an error of a request. Nil writes *Error as {"error": {"code", "message", "fields"}} and
	// any other error as a logged 500.
	WriteError func(w http.ResponseWriter, r *http.Request, err error)
}

// OAuthClient is a vendor OAuth client the host supplies.
type OAuthClient struct {
	ClientID, ClientSecret string
}

// Handler serves the routes of the package doc under Config.Prefix.
type Handler struct {
	cfg    Config
	mux    *http.ServeMux
	client *http.Client
	log    *slog.Logger
	logins *logins
	// claudeAdopted is the Claude Code version a rejection required, nil means claudeDefaultVersion.
	claudeAdopted atomic.Pointer[string]
	chatgpt       *chatgptState
}

// New returns a Handler for cfg. It panics when Prefix, User or Store is missing or a provider id is unknown.
func New(cfg Config) *Handler {
	if !strings.HasPrefix(cfg.Prefix, "/") || !strings.HasSuffix(cfg.Prefix, "/") || cfg.User == nil || cfg.Store == nil {
		panic("aiserver: Config needs a Prefix with slashes on both ends, User and Store")
	}
	for _, p := range cfg.Providers {
		if vendorOf(p) == nil {
			panic("aiserver: unknown provider " + p)
		}
	}
	if cfg.Antigravity.ClientID == "" || cfg.Antigravity.ClientSecret == "" {
		cfg.Providers = slices.DeleteFunc(slices.Clone(cfg.Providers), func(p string) bool { return p == Antigravity })
	}
	cfg.Originator = cmp.Or(cfg.Originator, "vue_ai_component")
	cfg.AgentName = cmp.Or(cfg.AgentName, cfg.Originator)
	h := &Handler{cfg: cfg, mux: http.NewServeMux(), client: cfg.Client, log: cfg.Log, logins: newLogins(), chatgpt: newChatGPTState()}
	if h.client == nil {
		h.client = &http.Client{Timeout: upstreamTimeout}
	}
	if h.log == nil {
		h.log = slog.New(slog.DiscardHandler)
	}
	if h.cfg.WriteError == nil {
		h.cfg.WriteError = h.writeError
	}
	handle := func(pattern string, fn func(w http.ResponseWriter, r *http.Request) error) {
		method, path, _ := strings.Cut(pattern, " ")
		h.mux.HandleFunc(method+" "+cfg.Prefix+path, func(w http.ResponseWriter, r *http.Request) {
			if err := fn(w, r); err != nil {
				h.cfg.WriteError(w, r, err)
			}
		})
	}
	handle("GET status", h.status)
	handle("PUT keys/{provider}", h.putKey)
	handle("DELETE keys/{provider}", h.deleteKey)
	handle("POST oauth/{provider}/start", h.oauthStart)
	handle("POST oauth/{provider}/complete", h.oauthComplete)
	handle("DELETE oauth/{provider}", h.oauthDisconnect)
	handle("GET {provider}/models", h.models)
	handle("POST {provider}/chat", h.chat)
	return h
}

// ServeHTTP implements http.Handler. Requests outside the route set answer a JSON 404.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if _, pattern := h.mux.Handler(r); pattern == "" {
		h.cfg.WriteError(w, r, errNotFound("Not found."))
		return
	}
	h.mux.ServeHTTP(w, r)
}

func vendorOf(p string) vendor {
	if v, ok := keyVendors[p]; ok {
		return v
	}
	if v, ok := oauthVendors[p]; ok {
		return v
	}
	return nil
}

// provider resolves the path's provider among the enabled ones; usable also asks Config.Allowed.
func (h *Handler) provider(r *http.Request, user string, usable bool) (string, error) {
	p := r.PathValue("provider")
	if !slices.Contains(h.cfg.Providers, p) {
		return "", errNotFound("Unknown provider.")
	}
	if usable && h.cfg.Allowed != nil {
		ok, err := h.cfg.Allowed(r, user, p)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", &Error{Status: http.StatusForbidden, Code: "oauth_disabled", Message: "This provider is turned off here."}
		}
	}
	return p, nil
}

func (h *Handler) base(name, def string) string {
	if v := h.cfg.BaseURLs[name]; v != "" {
		return strings.TrimRight(v, "/")
	}
	return def
}

// providerStatus is one provider's entry of GET status. key_match is the Store's Account.KeyMatch.
type providerStatus struct {
	Kind      string     `json:"kind"`
	Enabled   bool       `json:"enabled"`
	Connected bool       `json:"connected"`
	Email     string     `json:"email,omitempty"`
	AccountID string     `json:"account_id,omitempty"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	KeyMatch  *bool      `json:"key_match,omitempty"`
}

func (h *Handler) statusOf(r *http.Request, user string) (map[string]any, error) {
	accounts, err := h.cfg.Store.Accounts(r, user)
	if err != nil {
		return nil, err
	}
	out := make(map[string]providerStatus, len(h.cfg.Providers))
	for _, p := range h.cfg.Providers {
		s := providerStatus{Kind: "key", Enabled: true}
		if _, ok := oauthVendors[p]; ok {
			s.Kind = "oauth"
		}
		if h.cfg.Allowed != nil {
			if s.Enabled, err = h.cfg.Allowed(r, user, p); err != nil {
				return nil, err
			}
		}
		if a, ok := accounts[p]; ok && a.Connected {
			s.Connected, s.Email, s.AccountID, s.KeyMatch = true, a.Email, a.AccountID, a.KeyMatch
			if !a.ExpiresAt.IsZero() {
				t := a.ExpiresAt.UTC()
				s.ExpiresAt = &t
			}
		}
		out[p] = s
	}
	return map[string]any{"providers": out}, nil
}

func (h *Handler) status(w http.ResponseWriter, r *http.Request) error {
	user, err := h.cfg.User(r)
	if err != nil {
		return err
	}
	st, err := h.statusOf(r, user)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, st)
}

func writeJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	return json.NewEncoder(w).Encode(v)
}

func (h *Handler) writeError(w http.ResponseWriter, r *http.Request, err error) {
	var e *Error
	switch {
	case errors.As(err, &e):
	case errors.Is(err, context.Canceled) && r.Context().Err() != nil:
		return
	default:
		h.log.Error("ai request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		e = &Error{Status: http.StatusInternalServerError, Code: "internal", Message: "Something went wrong."}
	}
	type body struct {
		Code    string            `json:"code"`
		Message string            `json:"message"`
		Fields  map[string]string `json:"fields,omitempty"`
	}
	_ = writeJSON(w, e.Status, map[string]body{"error": {e.Code, e.Message, e.Fields}})
}
