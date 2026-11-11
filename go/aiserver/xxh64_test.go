package aiserver

import (
	"strings"
	"testing"
)

// Reference values from Bun.hash.xxHash64; the lengths cover the short path, the tail loops and the 32-byte stripes.
func TestXXH64(t *testing.T) {
	const seed = 0x4d659218e32a3268
	for _, c := range []struct {
		in         string
		zero, seed uint64
	}{
		{"", 0xef46db3751d8e999, 0xb8b30e7de65b46c5},
		{"a", 0xd24ec4f1a98c6e5b, 0xde28ae28b0e07bb2},
		{"abc", 0x44bc2cf5ad770999, 0xdfc4f4d6913699b6},
		{"0123456789abcdef0123456789abcdef0123456789", 0xa76190c3acf08a1c, 0x2ac90d74cd822d3a},
		{strings.Repeat("x", 100), 0x92f0de5a88a3c094, 0x6070011b77a4bb8e},
	} {
		if got := xxh64([]byte(c.in), 0); got != c.zero {
			t.Errorf("xxh64(%q, 0) = %x, want %x", c.in, got, c.zero)
		}
		if got := xxh64([]byte(c.in), seed); got != c.seed {
			t.Errorf("xxh64(%q, seed) = %x, want %x", c.in, got, c.seed)
		}
	}
}

// The attestation must match omp's (Bun.hash.xxHash64 over the body with the placeholder, low 20 bits).
func TestStampCCH(t *testing.T) {
	body := []byte(`{"messages":[],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.abc; cc_entrypoint=claude-desktop; cch=00000;"}]}`)
	stampCCH(body)
	if !strings.Contains(string(body), "cch=78fcb;") {
		t.Fatalf("stamped body: %s", body)
	}
	// A placeholder only in user content (no billing block first) stays untouched.
	other := []byte(`{"messages":[{"role":"user","content":"cch=00000"}],"system":"x"}`)
	stampCCH(other)
	if !strings.Contains(string(other), "cch=00000") {
		t.Fatalf("user content changed: %s", other)
	}
}
