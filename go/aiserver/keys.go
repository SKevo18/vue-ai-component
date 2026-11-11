package aiserver

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strings"
)

const (
	openaiDefaultAPI    = "https://api.openai.com"
	anthropicDefaultAPI = "https://api.anthropic.com"
	geminiDefaultAPI    = "https://generativelanguage.googleapis.com"
	anthropicVersion    = "2023-06-01"
)

var (
	openaiChat    = regexp.MustCompile(`^(gpt-|chatgpt-|o\d)`)
	openaiNonChat = regexp.MustCompile(`image|realtime|audio|tts|transcribe|search|instruct|embedding|moderation`)
	geminiModel   = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
)

// keyProvider resolves the path's provider among the enabled key providers.
func (h *Handler) keyProvider(r *http.Request, user string, usable bool) (string, vendor, error) {
	p, err := h.provider(r, user, usable)
	if err != nil {
		return "", nil, err
	}
	v, ok := keyVendors[p]
	if !ok {
		return "", nil, errNotFound("This provider takes no API key.")
	}
	return p, v, nil
}

// putKey verifies the key by listing the vendor's models, then stores it.
func (h *Handler) putKey(w http.ResponseWriter, r *http.Request) error {
	user, err := h.cfg.User(r)
	if err != nil {
		return err
	}
	p, v, err := h.keyProvider(r, user, true)
	if err != nil {
		return err
	}
	var in struct {
		APIKey string `json:"api_key"`
	}
	if err := bind(r, &in); err != nil {
		return err
	}
	key := strings.TrimSpace(in.APIKey)
	if key == "" || len(key) > 512 || strings.ContainsAny(key, " \t\r\n") {
		return errInvalid("api_key", "Paste the API key.")
	}
	c := &Credential{APIKey: key}
	_, err = v.models(r.Context(), h, c)
	if ge, ok := errors.AsType[*grantError](err); ok {
		if ge.status == http.StatusBadRequest || ge.status == http.StatusUnauthorized || ge.status == http.StatusForbidden {
			return &Error{Status: http.StatusUnprocessableEntity, Code: "invalid_key", Message: "The provider rejected the key (" + ge.message + ")."}
		}
		return errUpstream("The key could not be verified (" + ge.code + ").")
	}
	if err != nil {
		return err
	}
	if err := h.cfg.Store.Save(r, user, p, c); err != nil {
		return err
	}
	st, err := h.statusOf(r, user)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, st)
}

func (h *Handler) deleteKey(w http.ResponseWriter, r *http.Request) error {
	user, err := h.cfg.User(r)
	if err != nil {
		return err
	}
	p, _, err := h.keyProvider(r, user, false)
	if err != nil {
		return err
	}
	if err := h.cfg.Store.Delete(r, user, p); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type openaiVendor struct{}

func (openaiVendor) models(ctx context.Context, h *Handler, c *Credential) ([]modelInfo, error) {
	req, err := newJSONRequest(ctx, http.MethodGet, h.base("openai", openaiDefaultAPI)+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	var out struct {
		Data []struct {
			ID      string `json:"id"`
			Created int64  `json:"created"`
		} `json:"data"`
	}
	if err := h.vendorDo(req, &out); err != nil {
		return nil, err
	}
	sort.SliceStable(out.Data, func(i, j int) bool {
		if out.Data[i].Created != out.Data[j].Created {
			return out.Data[i].Created > out.Data[j].Created
		}
		return out.Data[i].ID < out.Data[j].ID
	})
	list := []modelInfo{}
	for _, m := range out.Data {
		if openaiChat.MatchString(m.ID) && !openaiNonChat.MatchString(m.ID) {
			list = append(list, modelInfo{ID: m.ID, Name: m.ID})
		}
	}
	return list, nil
}

func (openaiVendor) chat(ctx context.Context, h *Handler, c *Credential, payload map[string]json.RawMessage) (*http.Request, error) {
	req, err := newChatRequest(ctx, h.base("openai", openaiDefaultAPI)+"/v1/responses", payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	return req, nil
}

type anthropicVendor struct{}

func (anthropicVendor) models(ctx context.Context, h *Handler, c *Credential) ([]modelInfo, error) {
	req, err := newJSONRequest(ctx, http.MethodGet, h.base("anthropic", anthropicDefaultAPI)+"/v1/models?limit=1000", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-api-key", c.APIKey)
	req.Header.Set("anthropic-version", anthropicVersion)
	return anthropicModels(h, req)
}

// anthropicModels sends an Anthropic model list request and reads the answer.
func anthropicModels(h *Handler, req *http.Request) ([]modelInfo, error) {
	var out struct {
		Data []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"data"`
	}
	if err := h.vendorDo(req, &out); err != nil {
		return nil, err
	}
	list := make([]modelInfo, 0, len(out.Data))
	for _, m := range out.Data {
		list = append(list, modelInfo{ID: m.ID, Name: cmp.Or(m.DisplayName, m.ID)})
	}
	return list, nil
}

func (anthropicVendor) chat(ctx context.Context, h *Handler, c *Credential, payload map[string]json.RawMessage) (*http.Request, error) {
	req, err := newChatRequest(ctx, h.base("anthropic", anthropicDefaultAPI)+"/v1/messages", payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-api-key", c.APIKey)
	req.Header.Set("anthropic-version", anthropicVersion)
	return req, nil
}

type geminiVendor struct{}

func (geminiVendor) models(ctx context.Context, h *Handler, c *Credential) ([]modelInfo, error) {
	req, err := newJSONRequest(ctx, http.MethodGet, h.base("gemini", geminiDefaultAPI)+"/v1beta/models?pageSize=1000", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-goog-api-key", c.APIKey)
	var out struct {
		Models []struct {
			Name        string   `json:"name"`
			DisplayName string   `json:"displayName"`
			Methods     []string `json:"supportedGenerationMethods"`
		} `json:"models"`
	}
	if err := h.vendorDo(req, &out); err != nil {
		return nil, err
	}
	list := []modelInfo{}
	for _, m := range out.Models {
		id := strings.TrimPrefix(m.Name, "models/")
		if id == "" || !slices.Contains(m.Methods, "generateContent") {
			continue
		}
		list = append(list, modelInfo{ID: id, Name: cmp.Or(m.DisplayName, id)})
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].ID > list[j].ID })
	return list, nil
}

func (geminiVendor) chat(ctx context.Context, h *Handler, c *Credential, payload map[string]json.RawMessage) (*http.Request, error) {
	var model string
	if json.Unmarshal(payload["model"], &model) != nil || !geminiModel.MatchString(model) {
		return nil, errInvalid("model", "Choose a model.")
	}
	delete(payload, "model")
	req, err := newChatRequest(ctx, h.base("gemini", geminiDefaultAPI)+"/v1beta/models/"+url.PathEscape(model)+":streamGenerateContent?alt=sse", payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-goog-api-key", c.APIKey)
	return req, nil
}
