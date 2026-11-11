package aiserver

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Antigravity sign-in: Google Antigravity's installed-app OAuth client, whose id and secret the host supplies
// (Config.Antigravity). Its registered redirect https://antigravity.google/oauth-callback shows the authorization code
// for the user to paste back, the flow the Antigravity CLI uses over SSH. The tokens work against Cloud Code Assist
// (daily-cloudcode-pa), which wraps the Gemini generateContent request in an envelope and serves Gemini and Claude
// models to the user's Google AI plan or free tier.
const (
	agRedirect       = "https://antigravity.google/oauth-callback"
	agScopes         = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs"
	agUserAgent      = "antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)"
	agDefaultAPI     = "https://daily-cloudcode-pa.googleapis.com"
	googleAuthURL    = "https://accounts.google.com"
	googleTokenURL   = "https://oauth2.googleapis.com"
	googleAPIURL     = "https://www.googleapis.com"
	agFreeTier       = "free-tier"
	agOnboardTimeout = 30 * time.Second
)

type antigravityVendor struct{}

func (antigravityVendor) start(_ *http.Request, h *Handler, l *pendingLogin) (startView, error) {
	verifier, challenge := pkce()
	l.verifier, l.state = verifier, randomToken()
	q := url.Values{}
	q.Set("client_id", h.cfg.Antigravity.ClientID)
	q.Set("response_type", "code")
	q.Set("redirect_uri", agRedirect)
	q.Set("scope", agScopes)
	q.Set("state", l.state)
	q.Set("access_type", "offline")
	q.Set("prompt", "consent")
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	return startView{Flow: "code", AuthorizeURL: h.base("google.auth", googleAuthURL) + "/o/oauth2/v2/auth?" + q.Encode()}, nil
}

// complete exchanges the code, reads the account email and finds, or provisions on the free tier, the Cloud Code
// Assist project every request names.
func (antigravityVendor) complete(ctx context.Context, h *Handler, l *pendingLogin, input string) (*grant, error) {
	code, state, err := pastedCode(input)
	if err != nil {
		return nil, err
	}
	if state != "" && state != l.state {
		return nil, errForeignState
	}
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", h.cfg.Antigravity.ClientID)
	form.Set("client_secret", h.cfg.Antigravity.ClientSecret)
	form.Set("code", code)
	form.Set("code_verifier", l.verifier)
	form.Set("redirect_uri", agRedirect)
	g, err := googleToken(ctx, h, form)
	if err != nil {
		return nil, err
	}
	if g.refresh == "" {
		return nil, &grantError{status: http.StatusBadGateway, code: "no_refresh_token", message: "Google returned no refresh token"}
	}
	req, err := newJSONRequest(ctx, http.MethodGet, h.base("google.api", googleAPIURL)+"/oauth2/v1/userinfo?alt=json", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+g.access)
	var info struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	}
	if err := h.vendorDo(req, &info); err != nil {
		return nil, err
	}
	g.accountID, g.email = info.ID, info.Email
	if g.projectID, err = agProject(ctx, h, g.access); err != nil {
		return nil, err
	}
	return g, nil
}

func (antigravityVendor) refresh(ctx context.Context, h *Handler, c *Credential) (*grant, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("client_id", h.cfg.Antigravity.ClientID)
	form.Set("client_secret", h.cfg.Antigravity.ClientSecret)
	form.Set("refresh_token", c.Refresh)
	return googleToken(ctx, h, form)
}

func (antigravityVendor) revoke(ctx context.Context, h *Handler, c *Credential) {
	form := url.Values{}
	form.Set("token", c.Refresh)
	req, err := newFormRequest(ctx, h.base("google.token", googleTokenURL)+"/revoke", form)
	if err != nil {
		return
	}
	if err := h.vendorDo(req, nil); err != nil {
		h.log.Warn("antigravity revocation failed", "err", err)
	}
}

func googleToken(ctx context.Context, h *Handler, form url.Values) (*grant, error) {
	req, err := newFormRequest(ctx, h.base("google.token", googleTokenURL)+"/token", form)
	if err != nil {
		return nil, err
	}
	var tok struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := h.vendorDo(req, &tok); err != nil {
		return nil, err
	}
	if tok.AccessToken == "" {
		return nil, &grantError{status: http.StatusBadGateway, code: "token", message: "no access token in the response"}
	}
	return &grant{access: tok.AccessToken, refresh: tok.RefreshToken, expiresIn: tok.ExpiresIn}, nil
}

type agLoadResponse struct {
	CurrentTier *struct {
		ID string `json:"id"`
	} `json:"currentTier"`
	AllowedTiers []struct {
		ID string `json:"id"`
	} `json:"allowedTiers"`
	IneligibleTiers []struct {
		TierID        string `json:"tierId"`
		ReasonMessage string `json:"reasonMessage"`
	} `json:"ineligibleTiers"`
	Project string `json:"cloudaicompanionProject"`
}

func agRequest(ctx context.Context, h *Handler, method, path, token string, body, out any) error {
	req, err := newJSONRequest(ctx, method, h.base("antigravity.api", agDefaultAPI)+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", agUserAgent)
	return h.vendorDo(req, out)
}

// agProject asks loadCodeAssist for the account's project. An account without a tier is onboarded on the free tier
// first, a long-running operation polled for at most agOnboardTimeout.
func agProject(ctx context.Context, h *Handler, token string) (string, error) {
	meta := map[string]any{"metadata": map[string]string{"ideType": "ANTIGRAVITY"}}
	var load agLoadResponse
	if err := agRequest(ctx, h, http.MethodPost, "/v1internal:loadCodeAssist", token, meta, &load); err != nil {
		return "", err
	}
	if load.CurrentTier == nil {
		free := false
		for _, t := range load.AllowedTiers {
			free = free || t.ID == agFreeTier
		}
		for _, t := range load.IneligibleTiers {
			if !free && t.TierID == agFreeTier && t.ReasonMessage != "" {
				return "", &Error{Status: http.StatusForbidden, Code: "oauth_ineligible", Message: t.ReasonMessage}
			}
		}
		var op struct {
			Name string `json:"name"`
			Done bool   `json:"done"`
		}
		onboard := map[string]any{"tierId": agFreeTier, "metadata": map[string]string{"ideType": "ANTIGRAVITY"}}
		if err := agRequest(ctx, h, http.MethodPost, "/v1internal:onboardUser", token, onboard, &op); err != nil {
			return "", err
		}
		deadline := time.Now().Add(agOnboardTimeout)
		for !op.Done {
			if op.Name == "" || time.Now().After(deadline) {
				return "", &grantError{status: http.StatusGatewayTimeout, code: "onboarding", message: "Google did not finish setting up the account"}
			}
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(time.Second):
			}
			if err := agRequest(ctx, h, http.MethodGet, "/v1internal/"+op.Name, token, nil, &op); err != nil {
				return "", err
			}
		}
		if err := agRequest(ctx, h, http.MethodPost, "/v1internal:loadCodeAssist", token, meta, &load); err != nil {
			return "", err
		}
	}
	if load.Project == "" {
		return "", &grantError{status: http.StatusBadGateway, code: "no_project", message: "Google returned no Cloud Code Assist project"}
	}
	return load.Project, nil
}

func (antigravityVendor) models(ctx context.Context, h *Handler, c *Credential) ([]modelInfo, error) {
	var out struct {
		Models map[string]struct {
			DisplayName string `json:"displayName"`
			IsInternal  bool   `json:"isInternal"`
		} `json:"models"`
	}
	if err := agRequest(ctx, h, http.MethodPost, "/v1internal:fetchAvailableModels", c.Access, map[string]any{}, &out); err != nil {
		return nil, err
	}
	list := make([]modelInfo, 0, len(out.Models))
	for id, m := range out.Models {
		// chat_* and tab_* are the editor's completion models, not chat models
		if m.IsInternal || strings.HasPrefix(id, "chat_") || strings.HasPrefix(id, "tab_") {
			continue
		}
		list = append(list, modelInfo{ID: id, Name: cmp.Or(m.DisplayName, id)})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return list, nil
}

// chat wraps the browser's generateContent body, with its model, in the Cloud Code Assist envelope.
func (antigravityVendor) chat(ctx context.Context, h *Handler, c *Credential, payload map[string]json.RawMessage) (*http.Request, error) {
	var model string
	if json.Unmarshal(payload["model"], &model) != nil || model == "" {
		return nil, errInvalid("model", "Choose a model.")
	}
	delete(payload, "model")
	if raw, ok := payload["systemInstruction"]; ok {
		var si map[string]json.RawMessage
		if json.Unmarshal(raw, &si) == nil {
			si["role"] = json.RawMessage(`"user"`)
			payload["systemInstruction"], _ = json.Marshal(si)
		}
	}
	n, err := rand.Int(rand.Reader, big.NewInt(9_000_000_000_000_000_000))
	if err != nil {
		return nil, err
	}
	payload["sessionId"], _ = json.Marshal("-" + n.String())
	envelope := map[string]any{
		"project":     c.ProjectID,
		"model":       model,
		"request":     payload,
		"requestId":   fmt.Sprintf("agent/%s/%d/%s/2", uuidV4(), time.Now().UnixMilli(), uuidV4()),
		"userAgent":   "antigravity",
		"requestType": "agent",
	}
	req, err := newJSONRequest(ctx, http.MethodPost, h.base("antigravity.api", agDefaultAPI)+"/v1internal:streamGenerateContent?alt=sse", envelope)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Access)
	req.Header.Set("User-Agent", agUserAgent)
	req.Header.Set("Accept", "text/event-stream")
	return req, nil
}

// unwrap turns a Cloud Code Assist chunk {"response": {...}} into the plain generateContent chunk.
func (antigravityVendor) unwrap(data []byte) []byte {
	var env struct {
		Response json.RawMessage `json:"response"`
	}
	if json.Unmarshal(data, &env) == nil && len(bytes.TrimSpace(env.Response)) > 0 {
		return env.Response
	}
	return data
}
