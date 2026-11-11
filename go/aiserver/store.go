package aiserver

import (
	"errors"
	"net/http"
	"strconv"
	"time"
)

// Credential is one user's API key or sign-in for one provider, in plain text. A Store seals it at rest.
type Credential struct {
	// APIKey is the key of a key provider.
	APIKey string
	// Access and Refresh are the tokens of a sign-in; IDToken is kept by Sign in with ChatGPT for later sign-ins.
	Access, Refresh, IDToken string
	// ExpiresAt is when Access expires.
	ExpiresAt time.Time
	// AccountID, Email and ProjectID are the identity the vendor reported. Codex sends AccountID with every request
	// and Antigravity ProjectID.
	AccountID, Email, ProjectID string
	// ClientID and HostID are the Sign in with ChatGPT registration: the client id OpenAI issued and the stable
	// ext_agent_host_id. They survive a sign-out so that the next sign-in reuses the registration.
	ClientID, HostID string
}

// Account is what the status shows of a stored credential, readable without opening its secrets.
type Account struct {
	// Connected is false for a registration kept after a sign-out (ClientID or HostID only).
	Connected        bool
	Email, AccountID string
	ExpiresAt        time.Time
	// KeyMatch reports, for a store that seals with a key the request brings, whether this request's key opens the
	// credential. Nil when the store does not use one or the request brought none.
	KeyMatch *bool
	// ClientID and HostID are Credential's.
	ClientID, HostID string
}

// Store keeps the credentials of each user and provider, sealed however the host seals secrets. Every method gets
// the request it serves, so a store may read a key the browser sends. Errors are written as is: a store returns
// its own API errors, for example when the request's key cannot open the credential.
type Store interface {
	// Accounts lists the user's stored credentials by provider.
	Accounts(r *http.Request, user string) (map[string]Account, error)
	// Load returns the user's credential for the provider, nil without an error when there is none.
	Load(r *http.Request, user, provider string) (*Credential, error)
	// Save stores the credential, replacing any earlier one of the user and provider.
	Save(r *http.Request, user, provider string, c *Credential) error
	// Delete removes the credential; a Sign in with ChatGPT store may keep ClientID and HostID. Deleting nothing is
	// not an error.
	Delete(r *http.Request, user, provider string) error
}

// SaveChecker is a Store that can tell before a sign-in completes whether it could save for the request. The
// handler asks it first, so a request without the store's key fails before it consumes the sign-in attempt.
type SaveChecker interface {
	CanSave(r *http.Request, user, provider string) error
}

// Error is an API error with an HTTP status and a stable code. Fields names the offending request fields.
type Error struct {
	Status  int
	Code    string
	Message string
	Fields  map[string]string
}

func (e *Error) Error() string { return strconv.Itoa(e.Status) + " " + e.Code + ": " + e.Message }

func errNotFound(msg string) *Error {
	return &Error{Status: http.StatusNotFound, Code: "not_found", Message: msg}
}

func errBad(msg string) *Error {
	return &Error{Status: http.StatusBadRequest, Code: "bad_request", Message: msg}
}

// errInvalid is a 422 naming one offending field.
func errInvalid(field, msg string) *Error {
	return &Error{Status: http.StatusUnprocessableEntity, Code: "validation", Message: msg, Fields: map[string]string{field: msg}}
}

func errUpstream(msg string) *Error {
	return &Error{Status: http.StatusBadGateway, Code: "upstream", Message: msg}
}

func isValidation(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == "validation"
}
