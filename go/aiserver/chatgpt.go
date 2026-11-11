package aiserver

import (
	"cmp"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

// Sign in with ChatGPT, the open-source flow (developers.openai.com/siwc/token-sharing-open-source): the server makes
// the PKCE pair and authorize URL, the user signs in at OpenAI and lands on the loopback callback, where nothing
// listens in a hosted app, and pastes that address back. The server exchanges the code, verifies the id token and
// proxies the Responses API with the user's own ChatGPT plan. The first sign-in registers the app dynamically; the
// issued client id and the host id are kept for later sign-ins.
const (
	chatgptDefaultIssuer = "https://auth.openai.com"
	chatgptDefaultAPI    = "https://api.openai.com"
	chatgptRedirectURI   = "http://127.0.0.1:1455/auth/callback"
	chatgptResource      = "https://api.openai.com/v1"
	chatgptScope         = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
	chatgptPlanScope     = "chatgpt.tokens.use.direct"
	chatgptDynamicClient = "dynamic_agent_client"
)

// chatgptErrorText are readable messages for the plan usage error family; the code stays for the client.
var chatgptErrorText = map[string]string{
	"subscription_sharing_user_not_eligible":      "Your ChatGPT plan cannot be used in this app.",
	"subscription_sharing_usage_limit_exceeded":   "Your ChatGPT plan usage limit is reached. Check chatgpt.com/settings/usage.",
	"subscription_sharing_usage_unavailable":      "ChatGPT could not check your plan usage. Try again later.",
	"subscription_sharing_unsupported_capability": "Your ChatGPT plan does not support this feature here.",
	"subscription_sharing_route_not_supported":    "This request type is not supported with a ChatGPT plan.",
	"subscription_sharing_invalid_user":           "ChatGPT rejected the signed-in account. Sign in again.",
	"subscription_sharing_user_unavailable":       "ChatGPT account information is unavailable right now. Try again later.",
	"chatpass_v2_scope_not_authorized":            "The ChatGPT sign-in does not allow this. Sign in again.",
	"chatpass_v2_invalid_authorization_context":   "The ChatGPT sign-in does not allow this. Sign in again.",
}

// chatgptState is the per-process state of the flow: the issuer's signing keys, its revocation endpoint and the host
// ids of users who started but never finished a first sign-in.
type chatgptState struct {
	jwks jwksCache

	mu         sync.Mutex
	revocation string
	hostIDs    map[string]string
}

func newChatGPTState() *chatgptState {
	return &chatgptState{hostIDs: map[string]string{}}
}

// hostID is the user's stable ext_agent_host_id before a sign-in stored one.
func (s *chatgptState) hostID(user string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.hostIDs[user]
	if !ok {
		id = "urn:uuid:" + uuidV4()
		s.hostIDs[user] = id
	}
	return id
}

type chatgptVendor struct{}

func (h *Handler) chatgptIssuer() string {
	return h.base("chatgpt.issuer", chatgptDefaultIssuer)
}

// start reuses the stored registration: the issued client id with the retained id token as a hint, or the dynamic
// client with the app's name on the first sign-in.
func (chatgptVendor) start(r *http.Request, h *Handler, l *pendingLogin) (startView, error) {
	accounts, err := h.cfg.Store.Accounts(r, l.user)
	if err != nil {
		return startView{}, err
	}
	reg := accounts[ChatGPT]
	l.clientID = cmp.Or(reg.ClientID, chatgptDynamicClient)
	l.hostID = reg.HostID
	if l.hostID == "" {
		l.hostID = h.chatgpt.hostID(l.user)
	}
	var challenge string
	l.verifier, challenge = pkce()
	l.state, l.nonce = randomToken(), randomToken()
	q := url.Values{}
	q.Set("client_id", l.clientID)
	q.Set("ext_agent_host_id", l.hostID)
	if l.clientID == chatgptDynamicClient {
		q.Set("agent_name_hint", h.cfg.AgentName)
	} else if reg.Connected {
		// the hint is a convenience: a credential this request cannot open just goes without it
		if c, err := h.cfg.Store.Load(r, l.user, ChatGPT); err == nil && c != nil && c.IDToken != "" {
			q.Set("id_token_hint", c.IDToken)
		}
	}
	q.Set("response_type", "code")
	q.Set("redirect_uri", chatgptRedirectURI)
	q.Set("scope", chatgptScope)
	q.Set("resource", chatgptResource)
	q.Set("state", l.state)
	q.Set("nonce", l.nonce)
	q.Set("code_challenge_method", "S256")
	q.Set("code_challenge", challenge)
	return startView{Flow: "code", AuthorizeURL: h.chatgptIssuer() + "/api/accounts/authorize?" + q.Encode()}, nil
}

// complete takes the pasted callback address, exchanges the code, verifies the id token and requires the plan scope.
func (chatgptVendor) complete(ctx context.Context, h *Handler, l *pendingLogin, input string) (*grant, error) {
	cb, err := url.Parse(input)
	if err != nil || cb.Path != "/auth/callback" || cb.Hostname() != "127.0.0.1" {
		return nil, errInvalid("code", "Paste the whole address that starts with "+chatgptRedirectURI+".")
	}
	q := cb.Query()
	if q.Get("state") != l.state {
		return nil, &Error{Status: http.StatusBadRequest, Code: "oauth_login", Message: "The address belongs to another sign-in attempt. Start again."}
	}
	if e := q.Get("error"); e != "" {
		return nil, &Error{Status: http.StatusBadRequest, Code: "oauth_denied", Message: "The ChatGPT sign-in was not completed (" + e + ")."}
	}
	code := q.Get("code")
	if code == "" {
		return nil, errInvalid("code", "The address has no code.")
	}
	clientID := l.clientID
	switch issued := q.Get("client_id"); {
	case clientID == chatgptDynamicClient && (issued == "" || issued == chatgptDynamicClient):
		return nil, &Error{Status: http.StatusBadRequest, Code: "oauth_registration", Message: "The address has no issued client id. Start again."}
	case clientID == chatgptDynamicClient:
		clientID = issued
	case issued != "" && issued != clientID:
		return nil, &Error{Status: http.StatusBadRequest, Code: "oauth_client_mismatch", Message: "The address belongs to another registration. Start again."}
	}
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("code_verifier", l.verifier)
	form.Set("redirect_uri", chatgptRedirectURI)
	form.Set("resource", chatgptResource)
	form.Set("client_id", clientID)
	tok, err := chatgptToken(ctx, h, form)
	if err != nil {
		return nil, err
	}
	claims, err := h.chatgpt.verifyIDToken(ctx, h.client, h.chatgptIssuer(), tok.IDToken, clientID, l.nonce)
	if err != nil {
		h.log.Warn("chatgpt id token rejected", "err", err)
		return nil, &Error{Status: http.StatusBadRequest, Code: "oauth_id_token", Message: "The ChatGPT identity could not be verified."}
	}
	if !slices.Contains(strings.Fields(tok.Scope), chatgptPlanScope) {
		return nil, &Error{Status: http.StatusForbidden, Code: "oauth_plan_not_enabled", Message: "ChatGPT plan use was not allowed for this app. Sign in again and allow it."}
	}
	return &grant{
		access: tok.AccessToken, refresh: tok.RefreshToken, idToken: tok.IDToken, expiresIn: tok.ExpiresIn,
		accountID: claims.Subject, email: claims.Email, clientID: clientID, hostID: l.hostID,
	}, nil
}

func (chatgptVendor) refresh(ctx context.Context, h *Handler, c *Credential) (*grant, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", c.Refresh)
	form.Set("client_id", c.ClientID)
	form.Set("resource", chatgptResource)
	tok, err := chatgptToken(ctx, h, form)
	if err != nil {
		return nil, err
	}
	return &grant{access: tok.AccessToken, refresh: tok.RefreshToken, idToken: tok.IDToken, expiresIn: tok.ExpiresIn}, nil
}

type chatgptTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
}

func chatgptToken(ctx context.Context, h *Handler, form url.Values) (*chatgptTokens, error) {
	req, err := newFormRequest(ctx, h.chatgptIssuer()+"/api/accounts/oauth/token", form)
	if err != nil {
		return nil, err
	}
	var tok chatgptTokens
	if err := h.vendorDo(req, &tok); err != nil {
		return nil, err
	}
	if tok.AccessToken == "" {
		return nil, &grantError{status: http.StatusBadGateway, code: "token", message: "no access token in the response"}
	}
	return &tok, nil
}

// revoke ends the renewable session at the issuer's revocation endpoint. Failures are only logged: the user can
// always disconnect the app in the ChatGPT settings.
func (chatgptVendor) revoke(ctx context.Context, h *Handler, c *Credential) {
	endpoint := h.chatgpt.revocationEndpoint(ctx, h.client, h.chatgptIssuer())
	if endpoint == "" {
		return
	}
	form := url.Values{}
	form.Set("token", c.Refresh)
	form.Set("token_type_hint", "refresh_token")
	form.Set("client_id", c.ClientID)
	req, err := newFormRequest(ctx, endpoint, form)
	if err != nil {
		return
	}
	if err := h.vendorDo(req, nil); err != nil {
		h.log.Warn("chatgpt revocation failed", "err", err)
	}
}

func (s *chatgptState) revocationEndpoint(ctx context.Context, client *http.Client, issuer string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.revocation != "" {
		return s.revocation
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, issuer+"/.well-known/openid-configuration", nil)
	if err != nil {
		return ""
	}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer func() { _ = resp.Body.Close() }()
	var doc struct {
		Revocation string `json:"revocation_endpoint"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBody)).Decode(&doc); err != nil {
		return ""
	}
	s.revocation = doc.Revocation
	return doc.Revocation
}

func (chatgptVendor) models(ctx context.Context, h *Handler, c *Credential) ([]modelInfo, error) {
	req, err := newJSONRequest(ctx, http.MethodGet, h.base("chatgpt.api", chatgptDefaultAPI)+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Access)
	return catalogModels(h, req)
}

// chat forwards a Responses request in the shape the plan route requires: store false, stream true, no sampling or
// output-limit overrides.
func (chatgptVendor) chat(ctx context.Context, h *Handler, c *Credential, payload map[string]json.RawMessage) (*http.Request, error) {
	for _, k := range responsesStripped {
		delete(payload, k)
	}
	payload["store"] = json.RawMessage("false")
	payload["stream"] = json.RawMessage("true")
	req, err := newChatRequest(ctx, h.base("chatgpt.api", chatgptDefaultAPI)+"/v1/responses", payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Access)
	return req, nil
}

// rewriteError gives the plan usage error family a readable message in the vendor's {"error": {"code", "message"}}
// shape and turns {"detail": "..."} admission failures into that shape. Other bodies pass through unchanged.
func (chatgptVendor) rewriteError(body []byte) []byte {
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		Detail string `json:"detail"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return body
	}
	text, known := chatgptErrorText[env.Error.Code]
	switch {
	case known:
		out, _ := json.Marshal(map[string]any{"error": map[string]string{"code": env.Error.Code, "message": text, "type": "subscription_sharing"}})
		return out
	case env.Error.Code == "" && env.Error.Message == "" && env.Detail != "":
		out, _ := json.Marshal(map[string]any{"error": map[string]string{"message": env.Detail, "type": "admission"}})
		return out
	}
	return body
}

// idClaims are the id token fields the flow checks or keeps.
type idClaims struct {
	Issuer   string          `json:"iss"`
	Audience json.RawMessage `json:"aud"`
	Expires  int64           `json:"exp"`
	Nonce    string          `json:"nonce"`
	Subject  string          `json:"sub"`
	Email    string          `json:"email"`
}

// verifyIDToken checks an RS256 id token against the issuer's JWKS plus iss, aud, exp and nonce.
func (s *chatgptState) verifyIDToken(ctx context.Context, client *http.Client, issuer, token, clientID, nonce string) (*idClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed token")
	}
	rawHeader, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(rawHeader, &header); err != nil {
		return nil, err
	}
	if header.Alg != "RS256" {
		return nil, fmt.Errorf("unsupported alg %q", header.Alg)
	}
	key, err := s.jwks.key(ctx, client, issuer+"/.well-known/jwks.json", header.Kid)
	if err != nil {
		return nil, err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, sum[:], sig); err != nil {
		return nil, err
	}
	rawClaims, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	var claims idClaims
	if err := json.Unmarshal(rawClaims, &claims); err != nil {
		return nil, err
	}
	switch {
	case claims.Issuer != issuer:
		return nil, fmt.Errorf("issuer %q", claims.Issuer)
	case !audienceHas(claims.Audience, clientID):
		return nil, errors.New("audience mismatch")
	case time.Now().Unix() >= claims.Expires:
		return nil, errors.New("expired")
	case claims.Nonce != nonce:
		return nil, errors.New("nonce mismatch")
	case claims.Subject == "":
		return nil, errors.New("missing sub")
	}
	return &claims, nil
}

func audienceHas(raw json.RawMessage, want string) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == want
	}
	var many []string
	return json.Unmarshal(raw, &many) == nil && slices.Contains(many, want)
}

// jwksCache keeps the issuer's RSA keys by kid and refetches at most once a minute for an unknown kid.
type jwksCache struct {
	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	fetched time.Time
}

func (j *jwksCache) key(ctx context.Context, client *http.Client, url, kid string) (*rsa.PublicKey, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if k, ok := j.keys[kid]; ok {
		return k, nil
	}
	if !j.fetched.IsZero() && time.Since(j.fetched) < time.Minute {
		return nil, fmt.Errorf("unknown key id %q", kid)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	var doc struct {
		Keys []struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBody)).Decode(&doc); err != nil {
		return nil, fmt.Errorf("jwks: %w", err)
	}
	j.fetched = time.Now()
	j.keys = make(map[string]*rsa.PublicKey, len(doc.Keys))
	for _, k := range doc.Keys {
		if k.Kty != "RSA" {
			continue
		}
		n, err := base64.RawURLEncoding.DecodeString(k.N)
		if err != nil {
			continue
		}
		e, err := base64.RawURLEncoding.DecodeString(k.E)
		if err != nil {
			continue
		}
		j.keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	k, ok := j.keys[kid]
	if !ok {
		return nil, fmt.Errorf("unknown key id %q", kid)
	}
	return k, nil
}
