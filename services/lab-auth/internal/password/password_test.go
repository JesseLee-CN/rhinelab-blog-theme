package password

import (
	"strings"
	"testing"
)

func lowParams() Params {
	return Params{Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32}
}

func TestHashVerifyRoundTrip(t *testing.T) {
	phc, err := Hash("correct horse battery staple", lowParams())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(phc, "$argon2id$v=19$") {
		t.Fatalf("unexpected PHC prefix: %q", phc)
	}
	ok, err := Verify("correct horse battery staple", phc)
	if err != nil || !ok {
		t.Fatalf("Verify correct = (%v,%v)", ok, err)
	}
	ok, err = Verify("wrong password", phc)
	if err != nil || ok {
		t.Fatalf("Verify wrong = (%v,%v), want false,nil", ok, err)
	}
}

func TestHashUsesFreshSalt(t *testing.T) {
	a, _ := Hash("same password value", lowParams())
	b, _ := Hash("same password value", lowParams())
	if a == b {
		t.Fatal("two hashes with the same password must differ (fresh salt)")
	}
}

func TestPasswordBytesAreNotNormalised(t *testing.T) {
	// Composed vs decomposed e-acute must not collide.
	composed := "caf\u00e9 password value"
	decomposed := "cafe\u0301 password value"
	phc, _ := Hash(composed, lowParams())
	if ok, _ := Verify(decomposed, phc); ok {
		t.Fatal("decomposed form must not verify against composed hash")
	}
}

func TestMalformedHashes(t *testing.T) {
	for _, phc := range []string{
		"",
		"not-a-hash",
		"$argon2i$v=19$m=8192,t=1,p=1$AAAA$BBBB",
		"$argon2id$v=18$m=8192,t=1,p=1$AAAA$BBBB",
		"$argon2id$v=19$m=8192,t=1,p=1$not-base64!$BBBB",
	} {
		ok, err := Verify("anything", phc)
		if ok {
			t.Errorf("malformed hash %q must never match", phc)
		}
		if err == nil {
			t.Errorf("malformed hash %q should return an error", phc)
		}
	}
}

func TestNeedsRehash(t *testing.T) {
	phc, _ := Hash("value long enough here", lowParams())
	if !NeedsRehash(phc, DefaultParams()) {
		t.Fatal("weaker stored hash should need rehash")
	}
	if NeedsRehash(phc, lowParams()) {
		t.Fatal("matching params should not need rehash")
	}
	if !NeedsRehash("broken", DefaultParams()) {
		t.Fatal("unparseable hash should need rehash")
	}
}

func TestDummyIsStableAndInvalid(t *testing.T) {
	if Dummy() != Dummy() {
		t.Fatal("Dummy must be stable within a process")
	}
	if ok, err := Verify("anything at all", Dummy()); err != nil || ok {
		t.Fatalf("Dummy hash must never verify a real password: (%v,%v)", ok, err)
	}
}

func TestRejectsWeakParams(t *testing.T) {
	if _, err := Hash("value long enough here", Params{Memory: 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32}); err == nil {
		t.Fatal("memory below 8 MiB must be rejected")
	}
}
