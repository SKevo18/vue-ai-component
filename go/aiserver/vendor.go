package aiserver

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// vendor is one provider's API dialect.
type vendor interface {
	models(ctx context.Context, h *Handler, c *Credential) ([]modelInfo, error)
	// chat builds the upstream request from the browser's native request body.
	chat(ctx context.Context, h *Handler, c *Credential, payload map[string]json.RawMessage) (*http.Request, error)
}

// oauthVendor is a vendor the user signs in to.
type oauthVendor interface {
	vendor
	// start fills the vendor fields of the pending login and returns what the browser shows.
	start(r *http.Request, h *Handler, l *pendingLogin) (startView, error)
	// complete exchanges the pasted code, or polls a device login once and returns errPending until confirmed.
	complete(ctx context.Context, h *Handler, l *pendingLogin, code string) (*grant, error)
	refresh(ctx context.Context, h *Handler, c *Credential) (*grant, error)
}

// revoker ends the vendor session on sign-out, best effort.
type revoker interface {
	revoke(ctx context.Context, h *Handler, c *Credential)
}

// sseUnwrapper rewrites each SSE data payload of a vendor whose stream wraps the standard one.
type sseUnwrapper interface {
	unwrap(data []byte) []byte
}

// rejectionRetrier fixes the cause of some upstream rejections; retry reports whether to send the request again.
type rejectionRetrier interface {
	retry(h *Handler, status int, body []byte) bool
}

// errorRewriter rewrites an upstream chat error body before it reaches the browser.
type errorRewriter interface {
	rewriteError(body []byte) []byte
}

// grantError is an OAuth or API error answered by the vendor.
type grantError struct {
	status  int
	code    string
	message string
}

func (e *grantError) Error() string {
	return strconv.Itoa(e.status) + " " + e.code + ": " + e.message
}

// grant is a token response with the identity the vendor reported.
type grant struct {
	access, refresh, idToken string
	expiresIn                int
	accountID                string
	email                    string
	projectID                string
	clientID, hostID         string
}

type modelInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// vendorDo sends a vendor request and decodes a 2xx JSON body into out when out is not nil. Other statuses become
// a *grantError with the vendor's error code, transport failures a 502.
func (h *Handler) vendorDo(req *http.Request, out any) error {
	resp, err := h.client.Do(req)
	if err != nil {
		if req.Context().Err() != nil {
			return req.Context().Err()
		}
		h.log.Error("ai vendor request failed", "url", req.URL.Redacted(), "err", err)
		return errUpstream("The AI provider did not respond.")
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		h.log.Error("ai vendor response failed", "url", req.URL.Redacted(), "err", err)
		return errUpstream("The AI provider did not respond.")
	}
	if resp.StatusCode >= 300 {
		code, msg := vendorError(body)
		if code == "" {
			code = strconv.Itoa(resp.StatusCode)
		}
		return &grantError{status: resp.StatusCode, code: code, message: msg}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		h.log.Error("ai vendor unexpected response", "url", req.URL.Redacted(), "status", resp.StatusCode)
		return errUpstream("The AI provider returned an unexpected response.")
	}
	return nil
}

// vendorError reads the error code and message of the shapes the vendors use: OAuth {"error": "x",
// "error_description": "y"}, OpenAI and Anthropic {"error": {"code"|"type", "message"}}, Google {"error": {"status",
// "message"}}.
func vendorError(body []byte) (string, string) {
	var env struct {
		Error       json.RawMessage `json:"error"`
		Description string          `json:"error_description"`
		Message     string          `json:"message"`
	}
	if json.Unmarshal(body, &env) != nil {
		return "", strings.TrimSpace(string(body[:min(len(body), 300)]))
	}
	var code string
	if json.Unmarshal(env.Error, &code) == nil {
		return code, env.Description
	}
	var obj struct {
		Code    json.RawMessage `json:"code"`
		Type    string          `json:"type"`
		Status  string          `json:"status"`
		Message string          `json:"message"`
	}
	if json.Unmarshal(env.Error, &obj) == nil {
		var s string
		if json.Unmarshal(obj.Code, &s) == nil && s != "" {
			return s, obj.Message
		}
		for _, c := range []string{obj.Status, obj.Type} {
			if c != "" {
				return c, obj.Message
			}
		}
		return "", obj.Message
	}
	return "", env.Message
}

func newJSONRequest(ctx context.Context, method, endpoint string, body any) (*http.Request, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, rd)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	return req, nil
}

func newFormRequest(ctx context.Context, endpoint string, form url.Values) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	return req, nil
}

func newChatRequest(ctx context.Context, endpoint string, payload map[string]json.RawMessage) (*http.Request, error) {
	req, err := newJSONRequest(ctx, http.MethodPost, endpoint, payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream, application/json")
	return req, nil
}

// pkce returns a fresh verifier and its S256 challenge.
func pkce() (string, string) {
	verifier := randomToken()
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

// jwtClaims decodes a JWT payload without verifying it: the token came straight from the vendor's token endpoint
// over TLS and only display fields are read from it.
func jwtClaims(token string) map[string]json.RawMessage {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	var out map[string]json.RawMessage
	if json.Unmarshal(raw, &out) != nil {
		return nil
	}
	return out
}

// pastedCode reads what the user pasted from a vendor's code page: "code#state", a bare code, or the whole callback
// address with code and state in the query.
func pastedCode(input string) (code, state string, err error) {
	input = strings.TrimSpace(input)
	if strings.HasPrefix(input, "http://") || strings.HasPrefix(input, "https://") {
		if u, perr := url.Parse(input); perr == nil {
			code, state = u.Query().Get("code"), u.Query().Get("state")
		}
	} else {
		code, state, _ = strings.Cut(input, "#")
	}
	if code == "" || strings.ContainsAny(code, " \t\r\n") {
		return "", "", errInvalid("code", "Paste the code shown after signing in.")
	}
	return code, state, nil
}

func randomToken() string {
	return base64.RawURLEncoding.EncodeToString(randomBytes(32))
}

func uuidV4() string {
	b := randomBytes(16)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// randomBytes reads n bytes from crypto/rand, which never fails on supported platforms.
func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

// parseCatalog reads OpenAI's model catalog {"models": [{"slug", "display_name", "visibility"}]} (ChatGPT and Codex),
// and the public API shape {"data": [{"id"}]} so that a gateway in front of the API still works.
func parseCatalog(body []byte) ([]modelInfo, bool) {
	var list struct {
		Models []struct {
			Slug        string `json:"slug"`
			DisplayName string `json:"display_name"`
			Visibility  string `json:"visibility"`
		} `json:"models"`
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, false
	}
	out := make([]modelInfo, 0, len(list.Models)+len(list.Data))
	for _, m := range list.Models {
		if m.Slug == "" || (m.Visibility != "" && m.Visibility != "list") {
			continue
		}
		out = append(out, modelInfo{ID: m.Slug, Name: cmp.Or(m.DisplayName, m.Slug)})
	}
	for _, m := range list.Data {
		if m.ID != "" {
			out = append(out, modelInfo{ID: m.ID, Name: m.ID})
		}
	}
	return out, true
}

// catalogModels sends a model catalog request and parses the answer.
func catalogModels(h *Handler, req *http.Request) ([]modelInfo, error) {
	var raw json.RawMessage
	if err := h.vendorDo(req, &raw); err != nil {
		return nil, err
	}
	list, ok := parseCatalog(raw)
	if !ok {
		return nil, &grantError{status: http.StatusBadGateway, code: "models", message: "unexpected model list"}
	}
	return list, nil
}
