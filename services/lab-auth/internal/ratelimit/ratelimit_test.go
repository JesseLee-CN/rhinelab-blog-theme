package ratelimit

import (
	"testing"
	"time"
)

func TestAllowResetsAfterWindow(t *testing.T) {
	now := time.Unix(0, 0)
	l := New(8, func() time.Time { return now })
	for i := 0; i < 3; i++ {
		if !l.Allow("k", 3, time.Minute) {
			t.Fatalf("request %d should be allowed", i)
		}
	}
	if l.Allow("k", 3, time.Minute) {
		t.Fatal("fourth request in the window must be blocked")
	}
	now = now.Add(time.Minute)
	if !l.Allow("k", 3, time.Minute) {
		t.Fatal("window should reset after one minute")
	}
}

func TestTableIsBounded(t *testing.T) {
	now := time.Unix(0, 0)
	l := New(2, func() time.Time { return now })
	if !l.Allow("a", 5, time.Minute) || !l.Allow("b", 5, time.Minute) {
		t.Fatal("first two keys should be allowed")
	}
	if l.Allow("c", 5, time.Minute) {
		t.Fatal("a full live table must fail closed")
	}
	l.Reset("a")
	if !l.Allow("c", 5, time.Minute) {
		t.Fatal("after reset a new key should fit")
	}
}

func TestCleanupDropsExpired(t *testing.T) {
	now := time.Unix(0, 0)
	l := New(8, func() time.Time { return now })
	if !l.Allow("a", 5, time.Minute) {
		t.Fatal("allow failed")
	}
	now = now.Add(2 * time.Minute)
	l.Cleanup(time.Minute)
	if l.Len() != 0 {
		t.Fatalf("expected cleanup to drop all buckets, got %d", l.Len())
	}
}
