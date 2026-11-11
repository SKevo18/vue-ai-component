package aiserver

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Claude sign-in: Claude Code's public OAuth client. Its manual redirect page (platform.claude.com/oauth/code/
// callback) shows "code#state" for the user to paste back. Anthropic accepts these tokens on the Messages API only
// from requests that look like its own runtime: the identity system block, the billing header with the body
// attestation (cch), the Claude Code betas, SDK headers and user agent.
const (
	claudeClientID       = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	claudeDefaultAuth    = "https://claude.ai"
	claudeDefaultAPI     = "https://api.anthropic.com"
	claudeRedirect       = "https://platform.claude.com/oauth/code/callback"
	claudeScopes         = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
	claudeDefaultVersion = "2.1.280"
	claudeSDKVersion     = "0.112.1"
	claudeBetas          = "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14"
	claudeIdentity       = "You are Claude Code, Anthropic's official CLI for Claude."
	claudeMaxTokens      = 64000
	claudeBillingStart   = "x-anthropic-billing-header:"
	claudeCCH            = "cch=00000"
	claudeCCHSeed        = 0x4d659218e32a3268
)

// claudeRequired reads the minimum version from a claude_code_version_too_old rejection: "Claude Code 2.1.220 does
// not support this model; version 2.1.280 or newer is required."
var claudeRequired = regexp.MustCompile(`version (\d+\.\d+\.\d+) or newer is required`)

// claudeStainless are the Anthropic SDK headers of the Claude Code runtime, with this server's platform.
var claudeStainless = map[string]string{
	"X-Stainless-Arch":            map[string]string{"amd64": "x64", "arm64": "arm64", "386": "x86"}[runtime.GOARCH],
	"X-Stainless-Lang":            "js",
	"X-Stainless-OS":              map[string]string{"linux": "Linux", "darwin": "MacOS", "windows": "Windows"}[runtime.GOOS],
	"X-Stainless-Package-Version": claudeSDKVersion,
	"X-Stainless-Retry-Count":     "0",
	"X-Stainless-Runtime":         "node",
	"X-Stainless-Runtime-Version": "v26.3.0",
	"X-Stainless-Timeout":         "600",
}

type claudeVendor struct{}

func (claudeVendor) start(_ *http.Request, h *Handler, l *pendingLogin) (startView, error) {
	verifier, challenge := pkce()
	l.verifier, l.state = verifier, randomToken()
	q := url.Values{}
	q.Set("code", "true")
	q.Set("client_id", claudeClientID)
	q.Set("response_type", "code")
	q.Set("redirect_uri", claudeRedirect)
	q.Set("scope", claudeScopes)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("state", l.state)
	return startView{Flow: "code", AuthorizeURL: h.base("claude.auth", claudeDefaultAuth) + "/oauth/authorize?" + q.Encode()}, nil
}

func (claudeVendor) complete(ctx context.Context, h *Handler, l *pendingLogin, input string) (*grant, error) {
	code, state, err := pastedCode(input)
	if err != nil {
		return nil, err
	}
	if state != "" && state != l.state {
		return nil, errForeignState
	}
	return claudeToken(ctx, h, map[string]string{
		"grant_type": "authorization_code", "client_id": claudeClientID, "code": code, "state": l.state,
		"redirect_uri": claudeRedirect, "code_verifier": l.verifier,
	}, false)
}

// errForeignState is a pasted code of another sign-in attempt.
var errForeignState = &Error{Status: http.StatusBadRequest, Code: "oauth_login", Message: "The code belongs to another sign-in attempt. Start again."}

func (claudeVendor) refresh(ctx context.Context, h *Handler, c *Credential) (*grant, error) {
	return claudeToken(ctx, h, map[string]string{"grant_type": "refresh_token", "client_id": claudeClientID, "refresh_token": c.Refresh}, true)
}

func claudeToken(ctx context.Context, h *Handler, body map[string]string, refresh bool) (*grant, error) {
	req, err := newJSONRequest(ctx, http.MethodPost, h.base("claude.api", claudeDefaultAPI)+"/v1/oauth/token", body)
	if err != nil {
		return nil, err
	}
	if refresh {
		req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	}
	var tok struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		Account      struct {
			UUID  string `json:"uuid"`
			Email string `json:"email_address"`
		} `json:"account"`
	}
	if err := h.vendorDo(req, &tok); err != nil {
		return nil, err
	}
	if tok.AccessToken == "" {
		return nil, &grantError{status: http.StatusBadGateway, code: "token", message: "no access token in the response"}
	}
	return &grant{access: tok.AccessToken, refresh: tok.RefreshToken, expiresIn: tok.ExpiresIn, accountID: tok.Account.UUID, email: tok.Account.Email}, nil
}

// claudeVersion is the Claude Code version the requests claim: the default, or a newer minimum adopted from a
// rejection (claudeVendor.retry).
func (h *Handler) claudeVersion() string {
	if v := h.claudeAdopted.Load(); v != nil {
		return *v
	}
	return claudeDefaultVersion
}

func claudeHeaders(req *http.Request, version, token string) {
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-version", anthropicVersion)
	req.Header.Set("anthropic-beta", claudeBetas)
	req.Header.Set("anthropic-dangerous-direct-browser-access", "true")
	req.Header.Set("User-Agent", "claude-cli/"+version+" (external, cli)")
	req.Header.Set("x-app", "cli")
	for k, v := range claudeStainless {
		req.Header.Set(k, v)
	}
}

func (claudeVendor) models(ctx context.Context, h *Handler, c *Credential) ([]modelInfo, error) {
	req, err := newJSONRequest(ctx, http.MethodGet, h.base("claude.api", claudeDefaultAPI)+"/v1/models?limit=100", nil)
	if err != nil {
		return nil, err
	}
	claudeHeaders(req, h.claudeVersion(), c.Access)
	return anthropicModels(h, req)
}

// chat prepends the billing and identity system blocks to the browser's Messages request, caps max_tokens at the
// runtime's ceiling and stamps the body attestation.
func (claudeVendor) chat(ctx context.Context, h *Handler, c *Credential, payload map[string]json.RawMessage) (*http.Request, error) {
	type block struct {
		Type         string            `json:"type"`
		Text         string            `json:"text"`
		CacheControl map[string]string `json:"cache_control,omitempty"`
	}
	textBlock := func(b block) json.RawMessage {
		raw, _ := json.Marshal(b)
		return raw
	}
	version := h.claudeVersion()
	system := []json.RawMessage{
		textBlock(block{Type: "text", Text: claudeBilling(firstUserText(payload["messages"]), version)}),
		textBlock(block{Type: "text", Text: claudeIdentity, CacheControl: map[string]string{"type": "ephemeral"}}),
	}
	if raw, ok := payload["system"]; ok {
		var s string
		var blocks []json.RawMessage
		switch {
		case json.Unmarshal(raw, &s) == nil:
			if s != "" {
				system = append(system, textBlock(block{Type: "text", Text: s}))
			}
		case json.Unmarshal(raw, &blocks) == nil:
			system = append(system, blocks...)
		default:
			return nil, errBad("The system prompt must be a string or a list of blocks.")
		}
	}
	sys, err := json.Marshal(system)
	if err != nil {
		return nil, err
	}
	payload["system"] = sys
	payload["stream"] = json.RawMessage("true")
	var maxTokens int
	if json.Unmarshal(payload["max_tokens"], &maxTokens) != nil || maxTokens <= 0 || maxTokens > claudeMaxTokens {
		payload["max_tokens"] = json.RawMessage(strconv.Itoa(claudeMaxTokens))
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	stampCCH(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.base("claude.api", claudeDefaultAPI)+"/v1/messages?beta=true", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	claudeHeaders(req, version, c.Access)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	return req, nil
}

// retry adopts the minimum version a claude_code_version_too_old rejection names (Anthropic gates new models by
// Claude Code version), so the request is sent once more claiming it. The version stays for the process: a stale
// default costs one rejected request, not a failure. A version adopted meanwhile by another request also retries.
func (claudeVendor) retry(h *Handler, status int, body []byte) bool {
	m := claudeRequired.FindSubmatch(body)
	if status != http.StatusBadRequest || !bytes.Contains(body, []byte("claude_code_version_too_old")) || m == nil {
		return false
	}
	required := string(m[1])
	for {
		current := h.claudeAdopted.Load()
		have := claudeDefaultVersion
		if current != nil {
			have = *current
		}
		if !newerVersion(required, have) {
			return true
		}
		if h.claudeAdopted.CompareAndSwap(current, &required) {
			h.log.Info("ai: adopted the Claude Code version a rejection requires", "version", required)
			return true
		}
	}
}

// newerVersion reports whether the dotted version a is above b.
func newerVersion(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := range max(len(pa), len(pb)) {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// claudeBilling is the runtime's billing header text: the version suffix fingerprints UTF-16 units 4, 7 and 20 of
// the first user message, and cch is a placeholder that stampCCH replaces.
func claudeBilling(firstUser, version string) string {
	units := utf16.Encode([]rune(firstUser))
	var k []uint16
	for _, i := range []int{4, 7, 20} {
		if i < len(units) {
			k = append(k, units[i])
		} else {
			k = append(k, '0')
		}
	}
	sum := sha256.Sum256([]byte("59cf53e54c78" + string(utf16.Decode(k)) + version))
	return fmt.Sprintf("%s cc_version=%s.%s; cc_entrypoint=cli; %s;", claudeBillingStart, version, hex.EncodeToString(sum[:])[:3], claudeCCH)
}

// stampCCH replaces the cch placeholder in the first system block with the low 20 bits of XXH64 over the body as
// serialized with the placeholder in place. encoding/json sorts map keys, so "messages" precedes "system" and user
// text cannot imitate the anchor.
func stampCCH(body []byte) {
	anchor := []byte(`"system":[{"type":"text","text":"` + claudeBillingStart)
	at := bytes.Index(body, anchor)
	if at < 0 {
		return
	}
	from := at + len(anchor)
	idx := bytes.Index(body[from:], []byte(claudeCCH))
	if idx < 0 || idx > 150 {
		return
	}
	cch := fmt.Sprintf("%05x", xxh64(body, claudeCCHSeed)&0xfffff)
	copy(body[from+idx+len("cch="):], cch)
}

// firstUserText is the text of the first user message: a string content or its first text block.
func firstUserText(raw json.RawMessage) string {
	var msgs []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &msgs) != nil {
		return ""
	}
	for _, m := range msgs {
		if m.Role != "user" {
			continue
		}
		var s string
		if json.Unmarshal(m.Content, &s) == nil {
			return s
		}
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		_ = json.Unmarshal(m.Content, &blocks)
		for _, b := range blocks {
			if b.Type == "text" {
				return b.Text
			}
		}
		return ""
	}
	return ""
}
