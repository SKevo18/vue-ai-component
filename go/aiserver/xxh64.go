package aiserver

import (
	"encoding/binary"
	"math/bits"
)

// XXH64 primes (github.com/Cyan4973/xxHash, xxhash.h).
const (
	xxPrime1 uint64 = 0x9E3779B185EBCA87
	xxPrime2 uint64 = 0xC2B2AE3D27D4EB4F
	xxPrime3 uint64 = 0x165667B19E3779F9
	xxPrime4 uint64 = 0x85EBCA77C2B2AE63
	xxPrime5 uint64 = 0x27D4EB2F165667C5
)

func xxRound(acc, input uint64) uint64 {
	acc += input * xxPrime2
	return bits.RotateLeft64(acc, 31) * xxPrime1
}

func xxMerge(acc, val uint64) uint64 {
	acc ^= xxRound(0, val)
	return acc*xxPrime1 + xxPrime4
}

// xxh64 is XXH64 of b with the given seed; the Claude request attestation (claude.go) needs it.
func xxh64(b []byte, seed uint64) uint64 {
	n := len(b)
	var h uint64
	if n >= 32 {
		v1, v2, v3, v4 := seed+xxPrime1+xxPrime2, seed+xxPrime2, seed, seed-xxPrime1
		for len(b) >= 32 {
			v1 = xxRound(v1, binary.LittleEndian.Uint64(b))
			v2 = xxRound(v2, binary.LittleEndian.Uint64(b[8:]))
			v3 = xxRound(v3, binary.LittleEndian.Uint64(b[16:]))
			v4 = xxRound(v4, binary.LittleEndian.Uint64(b[24:]))
			b = b[32:]
		}
		h = bits.RotateLeft64(v1, 1) + bits.RotateLeft64(v2, 7) + bits.RotateLeft64(v3, 12) + bits.RotateLeft64(v4, 18)
		h = xxMerge(h, v1)
		h = xxMerge(h, v2)
		h = xxMerge(h, v3)
		h = xxMerge(h, v4)
	} else {
		h = seed + xxPrime5
	}
	h += uint64(n)
	for len(b) >= 8 {
		h ^= xxRound(0, binary.LittleEndian.Uint64(b))
		h = bits.RotateLeft64(h, 27)*xxPrime1 + xxPrime4
		b = b[8:]
	}
	if len(b) >= 4 {
		h ^= uint64(binary.LittleEndian.Uint32(b)) * xxPrime1
		h = bits.RotateLeft64(h, 23)*xxPrime2 + xxPrime3
		b = b[4:]
	}
	for _, c := range b {
		h ^= uint64(c) * xxPrime5
		h = bits.RotateLeft64(h, 11) * xxPrime1
	}
	h ^= h >> 33
	h *= xxPrime2
	h ^= h >> 29
	h *= xxPrime3
	h ^= h >> 32
	return h
}
