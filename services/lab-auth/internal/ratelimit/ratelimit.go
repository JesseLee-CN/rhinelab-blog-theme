// Package ratelimit is a small bounded fixed-window limiter. State is in-memory
// and intentionally resets on restart; the choice is recorded in
// 见 services/lab-auth/README.md 的容量说明。
package ratelimit

import (
	"sync"
	"time"
)

type bucket struct {
	windowStart time.Time
	count       int
}

type Limiter struct {
	mu         sync.Mutex
	buckets    map[string]*bucket
	now        func() time.Time
	maxBuckets int
}

func New(maxBuckets int, now func() time.Time) *Limiter {
	if maxBuckets < 1 {
		maxBuckets = 1
	}
	if now == nil {
		now = time.Now
	}
	return &Limiter{buckets: make(map[string]*bucket), now: now, maxBuckets: maxBuckets}
}

// Allow consumes one unit and reports whether the key is under limit for the
// window. New keys are refused (fail closed) when the bucket table is full of
// live entries, so memory stays bounded.
func (l *Limiter) Allow(key string, limit int, window time.Duration) bool {
	if limit < 1 {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= l.maxBuckets {
			l.evictExpiredLocked(now, window)
			if len(l.buckets) >= l.maxBuckets {
				return false
			}
		}
		l.buckets[key] = &bucket{windowStart: now, count: 1}
		return true
	}
	if now.Sub(b.windowStart) >= window {
		b.windowStart = now
		b.count = 1
		return true
	}
	if b.count >= limit {
		return false
	}
	b.count++
	return true
}

// Reset clears a key (e.g. after a successful login).
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	delete(l.buckets, key)
	l.mu.Unlock()
}

// Cleanup drops expired buckets.
func (l *Limiter) Cleanup(window time.Duration) {
	l.mu.Lock()
	l.evictExpiredLocked(l.now(), window)
	l.mu.Unlock()
}

func (l *Limiter) evictExpiredLocked(now time.Time, window time.Duration) {
	for key, b := range l.buckets {
		if now.Sub(b.windowStart) >= window {
			delete(l.buckets, key)
		}
	}
}

// Len reports the number of live buckets (test/diagnostic use).
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
