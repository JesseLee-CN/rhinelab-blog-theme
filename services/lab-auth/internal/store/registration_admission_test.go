package store

import (
	"context"
	"errors"
	"testing"
)

func TestDuplicateRegistrationConsumesPersistentQuota(t *testing.T) {
	s, _ := openRegistrationStore(t)
	in := registerInput(t, "AdmissionUser", "admission-source", 2, 10, 100)
	if _, err := s.RegisterUser(in); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RegisterUser(in); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("duplicate: %v", err)
	}
	for _, key := range []string{"register:src:admission-source", "register:global"} {
		count, err := s.QuotaCount(key)
		if err != nil || count != 2 {
			t.Fatalf("%s: count=%d err=%v", key, count, err)
		}
	}
	in.Username = "AnotherAdmission"
	if err := s.ConsumeRegistrationQuota(context.Background(), in); !errors.Is(err, ErrRegistrationQuota) {
		t.Fatalf("third admission should be rejected before hashing: %v", err)
	}
}

func TestRegistrationCapacityFailureDoesNotRefundAdmission(t *testing.T) {
	s, _ := openRegistrationStore(t)
	in := registerInput(t, "CapacityFirst", "capacity-source", 10, 10, 1)
	if _, err := s.RegisterUser(in); err != nil {
		t.Fatal(err)
	}
	in.Username = "CapacitySecond"
	if _, err := s.RegisterUser(in); !errors.Is(err, ErrUserLimit) {
		t.Fatalf("cap: %v", err)
	}
	count, err := s.QuotaCount("register:global")
	if err != nil || count != 2 {
		t.Fatalf("quota refunded: count=%d err=%v", count, err)
	}
	users, err := s.CountUsers()
	if err != nil || users != 1 {
		t.Fatalf("user cap: users=%d err=%v", users, err)
	}
}
