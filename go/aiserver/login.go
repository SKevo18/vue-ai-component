package aiserver

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const loginTTL = 10 * time.Minute

// errPending is a device sign-in the user has not confirmed yet.
var errPending = errors.New("authorization pending")

// pendingLogin is a sign-in between start and complete. It lives in memory only.
type pendingLogin struct {
	id       string
	user     string
	provider string
	expires  time.Time
	verifier string
	state    string
	// Device flow.
	deviceAuthID string
	userCode     string
	interval     time.Duration
	lastPoll     time.Time
	// Sign in with ChatGPT.
	nonce    string
	clientID string
	hostID   string
	// busy marks a login one request is completing.
	busy bool
}

// startView is the oauth/{provider}/start response.
type startView struct {
	Flow            string `json:"flow"` // device or code
	LoginID         string `json:"login_id"`
	AuthorizeURL    string `json:"authorize_url,omitempty"`
	VerificationURL string `json:"verification_url,omitempty"`
	UserCode        string `json:"user_code,omitempty"`
	Interval        int    `json:"interval,omitempty"`
	ExpiresIn       int    `json:"expires_in"`
}

// logins holds the pending sign-ins and the per-credential refresh locks: refresh tokens rotate, so two refreshes
// of one credential must not race.
type logins struct {
	mu        sync.Mutex
	pending   map[string]*pendingLogin
	refreshes map[string]*sync.Mutex
}

func newLogins() *logins {
	return &logins{pending: map[string]*pendingLogin{}, refreshes: map[string]*sync.Mutex{}}
}

func (s *logins) remember(l *pendingLogin) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, v := range s.pending {
		if now.After(v.expires) {
			delete(s.pending, k)
		}
	}
	s.pending[l.id] = l
}

// claim marks the user's live pending login busy and returns it: nil when it is unknown, expired, another user's or
// another provider's, or being completed by another request.
func (s *logins) claim(id, user, provider string) *pendingLogin {
	s.mu.Lock()
	defer s.mu.Unlock()
	l := s.pending[id]
	if l == nil || l.user != user || l.provider != provider || l.busy {
		return nil
	}
	if time.Now().After(l.expires) {
		delete(s.pending, id)
		return nil
	}
	l.busy = true
	return l
}

func (s *logins) release(l *pendingLogin, done bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l.busy = false
	if done {
		delete(s.pending, l.id)
	}
}

func (s *logins) refreshLock(user, provider string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := provider + "\x00" + user
	l, ok := s.refreshes[k]
	if !ok {
		l = &sync.Mutex{}
		s.refreshes[k] = l
	}
	return l
}

// oauthProvider resolves the path's provider among the enabled sign-in providers.
func (h *Handler) oauthProvider(r *http.Request, user string, usable bool) (string, oauthVendor, error) {
	p, err := h.provider(r, user, usable)
	if err != nil {
		return "", nil, err
	}
	v, ok := oauthVendors[p]
	if !ok {
		return "", nil, errNotFound("This provider has no sign-in.")
	}
	return p, v, nil
}

func (h *Handler) oauthStart(w http.ResponseWriter, r *http.Request) error {
	user, err := h.cfg.User(r)
	if err != nil {
		return err
	}
	p, v, err := h.oauthProvider(r, user, true)
	if err != nil {
		return err
	}
	l := &pendingLogin{id: randomToken(), user: user, provider: p, expires: time.Now().Add(loginTTL)}
	view, err := v.start(r, h, l)
	if ge, ok := errors.AsType[*grantError](err); ok {
		h.log.Warn("ai sign-in start rejected", "provider", p, "status", ge.status, "code", ge.code, "message", ge.message)
		return errUpstream("The sign-in could not start (" + ge.code + ").")
	}
	if err != nil {
		return err
	}
	h.logins.remember(l)
	view.LoginID = l.id
	view.ExpiresIn = int(time.Until(l.expires).Seconds())
	return writeJSON(w, http.StatusOK, view)
}

func (h *Handler) oauthComplete(w http.ResponseWriter, r *http.Request) error {
	user, err := h.cfg.User(r)
	if err != nil {
		return err
	}
	p, v, err := h.oauthProvider(r, user, true)
	if err != nil {
		return err
	}
	if sc, ok := h.cfg.Store.(SaveChecker); ok {
		if err := sc.CanSave(r, user, p); err != nil {
			return err
		}
	}
	var in struct {
		LoginID string `json:"login_id"`
		Code    string `json:"code"`
	}
	if err := bind(r, &in); err != nil {
		return err
	}
	l := h.logins.claim(in.LoginID, user, p)
	if l == nil {
		return &Error{Status: http.StatusBadRequest, Code: "oauth_login", Message: "The sign-in attempt is unknown or expired. Start again."}
	}
	pending := map[string]bool{"pending": true}
	if l.deviceAuthID != "" && time.Since(l.lastPoll) < l.interval {
		h.logins.release(l, false)
		return writeJSON(w, http.StatusAccepted, pending)
	}
	ctx := r.Context()
	g, err := v.complete(ctx, h, l, strings.TrimSpace(in.Code))
	if errors.Is(err, errPending) {
		l.lastPoll = time.Now()
		h.logins.release(l, false)
		return writeJSON(w, http.StatusAccepted, pending)
	}
	if ge, ok := errors.AsType[*grantError](err); ok {
		h.logins.release(l, true)
		h.log.Warn("ai sign-in rejected", "provider", p, "status", ge.status, "code", ge.code, "message", ge.message)
		return &Error{Status: http.StatusBadRequest, Code: "oauth_exchange", Message: "The sign-in was rejected (" + ge.code + "). Start again."}
	}
	if err != nil {
		// a malformed paste keeps the attempt so the user can correct it
		h.logins.release(l, !isValidation(err))
		return err
	}
	h.logins.release(l, true)
	if err := h.storeGrant(r, user, p, &Credential{}, g); err != nil {
		return err
	}
	st, err := h.statusOf(r, user)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, st)
}

// oauthDisconnect forgets the sign-in. A vendor that supports it revokes the session first when this request can
// open the credential; a credential it cannot open is still removed.
func (h *Handler) oauthDisconnect(w http.ResponseWriter, r *http.Request) error {
	user, err := h.cfg.User(r)
	if err != nil {
		return err
	}
	p, v, err := h.oauthProvider(r, user, false)
	if err != nil {
		return err
	}
	if rv, ok := v.(revoker); ok {
		if c, err := h.cfg.Store.Load(r, user, p); err == nil && c != nil && c.Refresh != "" {
			rv.revoke(r.Context(), h, c)
		}
	}
	if err := h.cfg.Store.Delete(r, user, p); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// bind decodes a JSON request body of at most maxBody bytes into v.
func bind(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, maxBody))
	if err := dec.Decode(v); err != nil {
		if errors.Is(err, io.EOF) {
			return errBad("The request body is empty.")
		}
		return errBad("Invalid JSON: " + err.Error())
	}
	return nil
}
