package aiserver

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Codex sign-in: the Codex CLI's public OAuth client at auth.openai.com with its device-code flow. The user opens
// auth.openai.com/codex/device, signs in and types the short code while the browser asks the server to poll. The
// tokens work against the ChatGPT backend's Codex Responses endpoint, not api.openai.com.
const (
	codexClientID      = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexDefaultIssuer = "https://auth.openai.com"
	codexDefaultAPI    = "https://chatgpt.com/backend-api"
	codexClientVersion = "0.144.1"
	codexAuthClaim     = "https://api.openai.com/auth"
	codexProfile       = "https://api.openai.com/profile"
)

// responsesStripped are the Responses fields the Codex and Sign in with ChatGPT backends reject; store and stream
// are forced.
var responsesStripped = []string{"background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "previous_response_id", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user"}

type codexVendor struct{}

func (h *Handler) codexIssuer() string {
	return h.base("codex.issuer", codexDefaultIssuer)
}

func (codexVendor) start(r *http.Request, h *Handler, l *pendingLogin) (startView, error) {
	req, err := newJSONRequest(r.Context(), http.MethodPost, h.codexIssuer()+"/api/accounts/deviceauth/usercode", map[string]string{"client_id": codexClientID})
	if err != nil {
		return startView{}, err
	}
	var out struct {
		DeviceAuthID string          `json:"device_auth_id"`
		UserCode     string          `json:"user_code"`
		Interval     json.RawMessage `json:"interval"` // "5" or 5
		ExpiresAt    string          `json:"expires_at"`
	}
	if err := h.vendorDo(req, &out); err != nil {
		return startView{}, err
	}
	if out.DeviceAuthID == "" || out.UserCode == "" {
		return startView{}, &grantError{status: http.StatusBadGateway, code: "device_auth", message: "no device code in the response"}
	}
	secs, _ := strconv.Atoi(strings.Trim(string(out.Interval), `"`))
	if secs <= 0 {
		secs = 5
	}
	l.deviceAuthID, l.userCode, l.interval = out.DeviceAuthID, out.UserCode, time.Duration(secs)*time.Second
	if t, err := time.Parse(time.RFC3339Nano, out.ExpiresAt); err == nil && t.After(time.Now()) {
		l.expires = t
	} else {
		l.expires = time.Now().Add(15 * time.Minute)
	}
	return startView{Flow: "device", VerificationURL: h.codexIssuer() + "/codex/device", UserCode: out.UserCode, Interval: secs}, nil
}

// complete polls once (403 and 404 mean not confirmed yet), then exchanges the returned code with the verifier the
// issuer generated for the device sign-in.
func (codexVendor) complete(ctx context.Context, h *Handler, l *pendingLogin, _ string) (*grant, error) {
	req, err := newJSONRequest(ctx, http.MethodPost, h.codexIssuer()+"/api/accounts/deviceauth/token", map[string]string{"device_auth_id": l.deviceAuthID, "user_code": l.userCode})
	if err != nil {
		return nil, err
	}
	var polled struct {
		Code     string `json:"authorization_code"`
		Verifier string `json:"code_verifier"`
	}
	if err := h.vendorDo(req, &polled); err != nil {
		if ge, ok := errors.AsType[*grantError](err); ok && (ge.status == http.StatusForbidden || ge.status == http.StatusNotFound) {
			return nil, errPending
		}
		return nil, err
	}
	if polled.Code == "" || polled.Verifier == "" {
		return nil, &grantError{status: http.StatusBadGateway, code: "device_auth", message: "no authorization code in the response"}
	}
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", codexClientID)
	form.Set("code", polled.Code)
	form.Set("code_verifier", polled.Verifier)
	form.Set("redirect_uri", h.codexIssuer()+"/deviceauth/callback")
	return codexToken(ctx, h, form)
}

func (codexVendor) refresh(ctx context.Context, h *Handler, c *Credential) (*grant, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("client_id", codexClientID)
	form.Set("refresh_token", c.Refresh)
	return codexToken(ctx, h, form)
}

// codexToken calls the token endpoint. The ChatGPT workspace id and the email come from the token claims.
func codexToken(ctx context.Context, h *Handler, form url.Values) (*grant, error) {
	req, err := newFormRequest(ctx, h.codexIssuer()+"/oauth/token", form)
	if err != nil {
		return nil, err
	}
	var tok struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := h.vendorDo(req, &tok); err != nil {
		return nil, err
	}
	g := &grant{access: tok.AccessToken, refresh: tok.RefreshToken, expiresIn: tok.ExpiresIn}
	var auth struct {
		AccountID string `json:"chatgpt_account_id"`
	}
	var profile struct {
		Email string `json:"email"`
	}
	claims := jwtClaims(tok.AccessToken)
	_ = json.Unmarshal(claims[codexAuthClaim], &auth)
	_ = json.Unmarshal(claims[codexProfile], &profile)
	if profile.Email == "" {
		_ = json.Unmarshal(jwtClaims(tok.IDToken)["email"], &profile.Email)
	}
	g.accountID, g.email = auth.AccountID, strings.ToLower(profile.Email)
	if g.access == "" || (form.Get("grant_type") == "authorization_code" && g.accountID == "") {
		return nil, &grantError{status: http.StatusBadGateway, code: "token_claims", message: "the token has no ChatGPT account"}
	}
	return g, nil
}

func (h *Handler) codexHeaders(req *http.Request, c *Credential) {
	req.Header.Set("Authorization", "Bearer "+c.Access)
	req.Header.Set("chatgpt-account-id", c.AccountID)
	req.Header.Set("OpenAI-Beta", "responses=experimental")
	req.Header.Set("originator", h.cfg.Originator)
	req.Header.Set("version", codexClientVersion)
}

func (codexVendor) models(ctx context.Context, h *Handler, c *Credential) ([]modelInfo, error) {
	req, err := newJSONRequest(ctx, http.MethodGet, h.base("codex.api", codexDefaultAPI)+"/codex/models?client_version="+codexClientVersion, nil)
	if err != nil {
		return nil, err
	}
	h.codexHeaders(req, c)
	return catalogModels(h, req)
}

// chat forwards a Responses request in the shape the Codex backend requires: store false, stream true,
// instructions present, no sampling or output-limit overrides.
func (codexVendor) chat(ctx context.Context, h *Handler, c *Credential, payload map[string]json.RawMessage) (*http.Request, error) {
	for _, k := range responsesStripped {
		delete(payload, k)
	}
	payload["store"] = json.RawMessage("false")
	payload["stream"] = json.RawMessage("true")
	if _, ok := payload["instructions"]; !ok {
		payload["instructions"] = json.RawMessage(`""`)
	}
	req, err := newJSONRequest(ctx, http.MethodPost, h.base("codex.api", codexDefaultAPI)+"/codex/responses", payload)
	if err != nil {
		return nil, err
	}
	h.codexHeaders(req, c)
	req.Header.Set("Accept", "text/event-stream")
	return req, nil
}
