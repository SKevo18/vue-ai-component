package aiserver_test

import (
	"crypto/sha256"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/SKevo18/vue-ai-component/go/aiserver"
	"github.com/SKevo18/vue-ai-component/go/aiserver/aiservertest"
)

// memStore keeps credentials in memory. A keyed store behaves like a host that seals with a key the browser sends
// in X-Test-Key: saving needs it, loading needs the one the credential was saved with.
type memStore struct {
	mu    sync.Mutex
	keyed bool
	creds map[string]stored
}

type stored struct {
	c  aiserver.Credential
	fp [32]byte
}

func newMemStore(keyed bool) *memStore {
	return &memStore{keyed: keyed, creds: map[string]stored{}}
}

func storeKey(user, provider string) string { return user + "/" + provider }

func (s *memStore) key(r *http.Request) ([]byte, error) {
	k := r.Header.Get("X-Test-Key")
	if k == "" {
		return nil, &aiserver.Error{Status: http.StatusUnauthorized, Code: "oauth_key_missing", Message: "The key of this browser is missing."}
	}
	return []byte(k), nil
}

func (s *memStore) Accounts(r *http.Request, user string) (map[string]aiserver.Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]aiserver.Account{}
	for k, v := range s.creds {
		u, p, _ := strings.Cut(k, "/")
		if u != user {
			continue
		}
		a := aiserver.Account{Connected: v.c.Access != "" || v.c.APIKey != "", Email: v.c.Email, AccountID: v.c.AccountID, ExpiresAt: v.c.ExpiresAt, ClientID: v.c.ClientID, HostID: v.c.HostID}
		if key := r.Header.Get("X-Test-Key"); s.keyed && key != "" && a.Connected {
			m := sha256.Sum256([]byte(key)) == v.fp
			a.KeyMatch = &m
		}
		out[p] = a
	}
	return out, nil
}

func (s *memStore) Load(r *http.Request, user, provider string) (*aiserver.Credential, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.creds[storeKey(user, provider)]
	if !ok || (v.c.Access == "" && v.c.APIKey == "") {
		if ok {
			c := aiserver.Credential{ClientID: v.c.ClientID, HostID: v.c.HostID}
			return &c, nil
		}
		return nil, nil
	}
	if s.keyed {
		key, err := s.key(r)
		if err != nil {
			return nil, err
		}
		if sha256.Sum256(key) != v.fp {
			return nil, &aiserver.Error{Status: http.StatusConflict, Code: "oauth_key_mismatch", Message: "The sign-in belongs to another browser."}
		}
	}
	c := v.c
	return &c, nil
}

func (s *memStore) CanSave(r *http.Request, _, _ string) error {
	if !s.keyed {
		return nil
	}
	_, err := s.key(r)
	return err
}

func (s *memStore) Save(r *http.Request, user, provider string, c *aiserver.Credential) error {
	var fp [32]byte
	if s.keyed {
		key, err := s.key(r)
		if err != nil {
			return err
		}
		fp = sha256.Sum256(key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.creds[storeKey(user, provider)] = stored{c: *c, fp: fp}
	return nil
}

// Delete keeps the Sign in with ChatGPT registration like a host must.
func (s *memStore) Delete(_ *http.Request, user, provider string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := storeKey(user, provider)
	if v, ok := s.creds[k]; ok && provider == aiserver.ChatGPT {
		s.creds[k] = stored{c: aiserver.Credential{ClientID: v.c.ClientID, HostID: v.c.HostID}}
		return nil
	}
	delete(s.creds, k)
	return nil
}

func (s *memStore) get(user, provider string) (aiserver.Credential, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.creds[storeKey(user, provider)]
	return v.c, ok
}

// expire makes the access token due for a refresh.
func (s *memStore) expire(user, provider string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := storeKey(user, provider)
	v := s.creds[k]
	v.c.ExpiresAt = time.Now()
	s.creds[k] = v
}

type env struct {
	t       *testing.T
	store   *memStore
	h       http.Handler
	key     string
	allowed map[string]bool
	mu      sync.Mutex
}

// newEnv mounts a handler at /api/ai/ for the users named by the X-User header, with the vendor origins of urls.
func newEnv(t *testing.T, keyed bool, providers []string, urls ...map[string]string) *env {
	t.Helper()
	e := &env{t: t, store: newMemStore(keyed)}
	base := map[string]string{}
	for _, u := range urls {
		maps.Copy(base, u)
	}
	e.h = aiserver.New(aiserver.Config{
		Prefix:    "/api/ai/",
		Providers: providers,
		User: func(r *http.Request) (string, error) {
			if u := r.Header.Get("X-User"); u != "" {
				return u, nil
			}
			return "", &aiserver.Error{Status: http.StatusUnauthorized, Code: "unauthorized", Message: "Sign in first."}
		},
		Store: e.store,
		Allowed: func(_ *http.Request, _, provider string) (bool, error) {
			e.mu.Lock()
			defer e.mu.Unlock()
			return e.allowed == nil || e.allowed[provider], nil
		},
		BaseURLs:    base,
		Originator:  "testapp",
		AgentName:   "Test App",
		Antigravity: aiservertest.AntigravityClient,
	})
	return e
}

func (e *env) allow(providers ...string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.allowed = map[string]bool{}
	for _, p := range providers {
		e.allowed[p] = true
	}
}

func (e *env) callKey(user, key, method, path, body string) *httptest.ResponseRecorder {
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, "/api/ai"+path, rd)
	req.Header.Set("Content-Type", "application/json")
	if user != "" {
		req.Header.Set("X-User", user)
	}
	if key != "" {
		req.Header.Set("X-Test-Key", key)
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func (e *env) call(user, method, path, body string) *httptest.ResponseRecorder {
	return e.callKey(user, e.key, method, path, body)
}

func (e *env) expect(rec *httptest.ResponseRecorder, status int, contains, what string) {
	e.t.Helper()
	if rec.Code != status || !strings.Contains(rec.Body.String(), contains) {
		e.t.Fatalf("%s: %d %s", what, rec.Code, rec.Body.String())
	}
}
