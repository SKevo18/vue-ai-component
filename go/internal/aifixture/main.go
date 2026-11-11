// Command aifixture serves the aiserver handler under /api/ai/ with every provider wired to the aiservertest fakes and
// an in-memory store, for the TypeScript integration tests of createServerBackend. The user is the X-User header,
// alice by default. A request's X-Test-Key seals what it saves: a later request with another key gets 409.
// POST /fake/vendors {"approved", "challenge"} steers the subscription fake. It prints "listening <url>" when ready.
package main

import (
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"maps"
	"net"
	"net/http"
	"strings"
	"sync"

	"github.com/SKevo18/vue-ai-component/go/aiserver"
	"github.com/SKevo18/vue-ai-component/go/aiserver/aiservertest"
)

type tb struct{}

func (tb) Helper()           {}
func (tb) Cleanup(func())    {}
func (tb) Fatal(args ...any) { log.Fatal(args...) }

type entry struct {
	c  aiserver.Credential
	fp string
}

// store keeps credentials in memory, each sealed with the X-Test-Key it was saved with.
type store struct {
	mu    sync.Mutex
	creds map[string]entry
}

func fingerprint(r *http.Request) string {
	if k := r.Header.Get("X-Test-Key"); k != "" {
		sum := sha256.Sum256([]byte(k))
		return string(sum[:])
	}
	return ""
}

func (s *store) Accounts(r *http.Request, user string) (map[string]aiserver.Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]aiserver.Account{}
	for k, v := range s.creds {
		u, p, _ := strings.Cut(k, "/")
		if u != user {
			continue
		}
		a := aiserver.Account{Connected: true, Email: v.c.Email, AccountID: v.c.AccountID, ExpiresAt: v.c.ExpiresAt}
		if fp := fingerprint(r); fp != "" && v.fp != "" {
			match := fp == v.fp
			a.KeyMatch = &match
		}
		out[p] = a
	}
	return out, nil
}

func (s *store) Load(r *http.Request, user, provider string) (*aiserver.Credential, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.creds[user+"/"+provider]
	if !ok {
		return nil, nil
	}
	if v.fp != "" && fingerprint(r) != v.fp {
		return nil, &aiserver.Error{Status: http.StatusConflict, Code: "oauth_key_mismatch", Message: "The sign-in belongs to another browser. Sign in again here."}
	}
	c := v.c
	return &c, nil
}

func (s *store) Save(r *http.Request, user, provider string, c *aiserver.Credential) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.creds[user+"/"+provider] = entry{c: *c, fp: fingerprint(r)}
	return nil
}

func (s *store) Delete(_ *http.Request, user, provider string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.creds, user+"/"+provider)
	return nil
}

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "listen address")
	flag.Parse()
	vendors, keys, issuer := aiservertest.NewVendors(tb{}), aiservertest.NewKeys(tb{}), aiservertest.NewIssuer(tb{})
	base := vendors.BaseURLs()
	maps.Copy(base, keys.BaseURLs())
	maps.Copy(base, issuer.BaseURLs())
	h := aiserver.New(aiserver.Config{
		Prefix:    "/api/ai/",
		Providers: []string{aiserver.ChatGPT, aiserver.Codex, aiserver.Claude, aiserver.Antigravity, aiserver.OpenAI, aiserver.Anthropic, aiserver.Gemini},
		User: func(r *http.Request) (string, error) {
			if u := r.Header.Get("X-User"); u != "" {
				return u, nil
			}
			return "alice", nil
		},
		Store: &store{creds: map[string]entry{}},
		Allowed: func(_ *http.Request, _, provider string) (bool, error) {
			return provider != aiserver.Antigravity, nil
		},
		BaseURLs:    base,
		Originator:  "fixture",
		Antigravity: aiservertest.AntigravityClient,
	})
	mux := http.NewServeMux()
	mux.Handle("/api/ai/", h)
	mux.HandleFunc("POST /fake/vendors", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Approved  bool   `json:"approved"`
			Challenge string `json:"challenge"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		vendors.Lock()
		vendors.Approved, vendors.Challenge = in.Approved, in.Challenge
		vendors.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("listening http://" + ln.Addr().String())
	log.Fatal(http.Serve(ln, mux)) //nolint:gosec // a local test fixture
}
