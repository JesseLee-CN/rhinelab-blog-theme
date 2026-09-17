// Package password implements the Argon2id password hashing frozen in
// CONTRACT.md §2/§7 using the PHC string format.
package password

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
)

// Params are the Argon2id work factors. Defaults follow OWASP (19 MiB, t=2, p=1).
type Params struct {
	Memory      uint32
	Iterations  uint32
	Parallelism uint8
	SaltLength  uint32
	KeyLength   uint32
}

func DefaultParams() Params {
	return Params{Memory: 19 * 1024, Iterations: 2, Parallelism: 1, SaltLength: 16, KeyLength: 32}
}

func (p Params) validate() error {
	if p.Memory < 8*1024 {
		return errors.New("password: argon2 memory below 8 MiB")
	}
	if p.Iterations < 1 || p.Parallelism < 1 || p.SaltLength < 8 || p.KeyLength < 16 {
		return errors.New("password: invalid argon2 parameters")
	}
	return nil
}

// Hash derives a PHC-encoded Argon2id hash with a fresh random salt.
func Hash(plain string, params Params) (string, error) {
	if err := params.validate(); err != nil {
		return "", err
	}
	salt := make([]byte, params.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("password: salt: %w", err)
	}
	key := argon2.IDKey([]byte(plain), salt, params.Iterations, params.Memory, params.Parallelism, params.KeyLength)
	return encode(params, salt, key), nil
}

func encode(p Params, salt, key []byte) string {
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.Memory, p.Iterations, p.Parallelism,
		b64.EncodeToString(salt), b64.EncodeToString(key))
}

type decoded struct {
	params Params
	salt   []byte
	key    []byte
}

func decode(phc string) (decoded, error) {
	parts := strings.Split(phc, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return decoded{}, errors.New("password: malformed hash")
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return decoded{}, errors.New("password: unsupported argon2 version")
	}
	var p Params
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.Memory, &p.Iterations, &p.Parallelism); err != nil {
		return decoded{}, errors.New("password: malformed parameters")
	}
	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return decoded{}, errors.New("password: malformed salt")
	}
	key, err := b64.DecodeString(parts[5])
	if err != nil {
		return decoded{}, errors.New("password: malformed key")
	}
	p.SaltLength = uint32(len(salt))
	p.KeyLength = uint32(len(key))
	if err := p.validate(); err != nil {
		return decoded{}, err
	}
	return decoded{params: p, salt: salt, key: key}, nil
}

// Verify compares the plain password against a PHC hash in constant time.
// A malformed hash returns an error; the caller must treat it as invalid, not
// as a successful match.
func Verify(plain, phc string) (bool, error) {
	d, err := decode(phc)
	if err != nil {
		return false, err
	}
	computed := argon2.IDKey([]byte(plain), d.salt, d.params.Iterations, d.params.Memory, d.params.Parallelism, d.params.KeyLength)
	return subtle.ConstantTimeCompare(computed, d.key) == 1, nil
}

// NeedsRehash reports whether a stored hash uses weaker parameters than want.
func NeedsRehash(phc string, want Params) bool {
	d, err := decode(phc)
	if err != nil {
		return true
	}
	return d.params.Memory < want.Memory ||
		d.params.Iterations < want.Iterations ||
		d.params.Parallelism < want.Parallelism ||
		d.params.KeyLength < want.KeyLength
}

var (
	dummyOnce sync.Once
	dummyPHC  string
)

// Dummy returns a fixed PHC hash used to equalise work for unknown users, so
// login latency does not reveal whether a username exists.
func Dummy() string {
	dummyOnce.Do(func() {
		// Deterministic salt keeps the cost identical across restarts without
		// depending on the database.
		salt := make([]byte, DefaultParams().SaltLength)
		for i := range salt {
			salt[i] = byte(i + 1)
		}
		key := argon2.IDKey([]byte("invalid-placeholder-password"), salt,
			DefaultParams().Iterations, DefaultParams().Memory,
			DefaultParams().Parallelism, DefaultParams().KeyLength)
		dummyPHC = encode(DefaultParams(), salt, key)
	})
	return dummyPHC
}

// DummyVerify always fails but performs a full hash computation.
func DummyVerify(plain string, params Params) {
	_ = argon2.IDKey([]byte(plain), []byte("dummy-salt-16byt"), params.Iterations, params.Memory, params.Parallelism, params.KeyLength)
}
