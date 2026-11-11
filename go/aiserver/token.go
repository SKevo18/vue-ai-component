package aiserver

import (
	"cmp"
	"errors"
	"net/http"
	"time"
)

const refreshMargin = 2 * time.Minute

// deadRefresh are the refresh error codes after which the stored sign-in is unusable.
var deadRefresh = map[string]bool{"invalid_grant": true, "invalid_refresh_token": true, "token_expired": true, "refresh_token_expired": true, "refresh_token_invalidated": true, "refresh_token_reused": true}

var errNotConnected = &Error{Status: http.StatusForbidden, Code: "not_connected", Message: "This provider is not connected."}

func fresh(c *Credential) bool {
	return !c.ExpiresAt.IsZero() && time.Until(c.ExpiresAt) > refreshMargin
}

// credential returns the user's usable credential for the provider, refreshing a sign-in whose access token is about
// to expire. Refreshes of one credential are serialized because refresh tokens rotate; a refresh the vendor answers
// with a dead-token code removes the credential.
func (h *Handler) credential(r *http.Request, user, p string) (*Credential, error) {
	load := func() (*Credential, error) {
		c, err := h.cfg.Store.Load(r, user, p)
		if err == nil && c == nil {
			return nil, errNotConnected
		}
		return c, err
	}
	c, err := load()
	if err != nil {
		return nil, err
	}
	v, ok := oauthVendors[p]
	if !ok {
		if c.APIKey == "" {
			return nil, errNotConnected
		}
		return c, nil
	}
	if c.Access == "" {
		return nil, errNotConnected
	}
	if fresh(c) {
		return c, nil
	}
	lock := h.logins.refreshLock(user, p)
	lock.Lock()
	defer lock.Unlock()
	// another request may have refreshed while this one waited
	if c, err = load(); err != nil {
		return nil, err
	}
	if c.Access == "" {
		return nil, errNotConnected
	}
	if fresh(c) {
		return c, nil
	}
	g, err := v.refresh(r.Context(), h, c)
	if ge, ok := errors.AsType[*grantError](err); ok {
		if deadRefresh[ge.code] || ge.status == http.StatusUnauthorized {
			if err := h.cfg.Store.Delete(r, user, p); err != nil {
				return nil, err
			}
			return nil, &Error{Status: http.StatusForbidden, Code: "oauth_expired", Message: "The sign-in expired. Sign in again."}
		}
		h.log.Error("ai token refresh rejected", "provider", p, "status", ge.status, "code", ge.code, "message", ge.message)
		return nil, errUpstream("The token refresh failed (" + ge.code + ").")
	}
	if err != nil {
		return nil, err
	}
	if err := h.storeGrant(r, user, p, c, g); err != nil {
		return nil, err
	}
	return c, nil
}

// storeGrant updates c with the grant and saves it. A refresh that returns no refresh token or id token keeps the
// stored one (RFC 6749 section 6), and identity fields the vendor did not report keep their values.
func (h *Handler) storeGrant(r *http.Request, user, p string, c *Credential, g *grant) error {
	c.Access = g.access
	c.Refresh = cmp.Or(g.refresh, c.Refresh)
	c.IDToken = cmp.Or(g.idToken, c.IDToken)
	if c.Refresh == "" {
		return errUpstream("The sign-in returned no refresh token. Sign in again.")
	}
	c.AccountID = cmp.Or(g.accountID, c.AccountID)
	c.Email = cmp.Or(g.email, c.Email)
	c.ProjectID = cmp.Or(g.projectID, c.ProjectID)
	c.ClientID = cmp.Or(g.clientID, c.ClientID)
	c.HostID = cmp.Or(g.hostID, c.HostID)
	expiresIn := g.expiresIn
	if expiresIn <= 0 {
		expiresIn = 3600
	}
	c.ExpiresAt = time.Now().Add(time.Duration(expiresIn) * time.Second).Truncate(time.Millisecond)
	return h.cfg.Store.Save(r, user, p, c)
}
