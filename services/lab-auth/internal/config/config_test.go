package config

import (
	"strings"
	"testing"
)

func envMap(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestDefaultsAreDevelopment(t *testing.T) {
	cfg, err := Load(envMap(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Env != Development {
		t.Fatalf("env = %q", cfg.Env)
	}
	if cfg.DBPath != "" {
		t.Fatalf("db path should be empty by default")
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("validate without DB path must fail")
	}
}

func TestDevelopmentAcceptsLoopback(t *testing.T) {
	cfg, err := Load(envMap(map[string]string{
		"LAB_AUTH_ENV":    "development",
		"LAB_AUTH_LISTEN": "127.0.0.1:8081",
		"LAB_AUTH_DB":     "/tmp/auth.db",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("development config should validate: %v", err)
	}
}

func TestProductionRequirements(t *testing.T) {
	base := map[string]string{
		"LAB_AUTH_ENV":             "production",
		"LAB_AUTH_LISTEN":          "unix:/run/example-blog-auth/http.sock",
		"LAB_AUTH_DB":              "/var/lib/example-blog-auth/auth.db",
		"LAB_AUTH_ALLOWED_ORIGINS": "https://example.com",
		"LAB_AUTH_CSRF_SECRET":     strings.Repeat("ab", 32),
	}
	if err := mustLoad(t, base).Validate(); err != nil {
		t.Fatalf("valid production config rejected: %v", err)
	}

	noOrigin := clone(base)
	delete(noOrigin, "LAB_AUTH_ALLOWED_ORIGINS")
	if err := mustLoad(t, noOrigin).Validate(); err == nil {
		t.Fatal("production without origins must fail")
	}

	httpOrigin := clone(base)
	httpOrigin["LAB_AUTH_ALLOWED_ORIGINS"] = "http://example.com"
	if err := mustLoad(t, httpOrigin).Validate(); err == nil {
		t.Fatal("production with http origin must fail")
	}

	publicListen := clone(base)
	publicListen["LAB_AUTH_LISTEN"] = "0.0.0.0:8081"
	if err := mustLoad(t, publicListen).Validate(); err == nil {
		t.Fatal("production on a public address must fail")
	}

	noSecret := clone(base)
	delete(noSecret, "LAB_AUTH_CSRF_SECRET")
	if err := mustLoad(t, noSecret).Validate(); err == nil {
		t.Fatal("production without a CSRF secret must fail")
	}
}

func TestUnknownEnvRejected(t *testing.T) {
	cfg, err := Load(envMap(map[string]string{
		"LAB_AUTH_ENV": "staging",
		"LAB_AUTH_DB":  "/tmp/auth.db",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("unknown environment must fail validation")
	}
}

func TestRegistrationDefaultsAndOverrides(t *testing.T) {
	base := map[string]string{"LAB_AUTH_LISTEN": "127.0.0.1:8081", "LAB_AUTH_DB": "/tmp/auth.db"}
	cfg := mustLoad(t, base)
	if cfg.RegistrationEnabled {
		t.Fatal("registration must be disabled by default")
	}
	if cfg.RegisterSourceHourly != 10 || cfg.RegisterGlobalDaily != 200 || cfg.RegisterMaxUsers != 5000 {
		t.Fatalf("defaults = %d/%d/%d", cfg.RegisterSourceHourly, cfg.RegisterGlobalDaily, cfg.RegisterMaxUsers)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	enabled := clone(base)
	enabled["LAB_AUTH_REGISTRATION_ENABLED"] = "true"
	enabled["LAB_AUTH_REGISTER_SOURCE_HOURLY"] = "3"
	enabled["LAB_AUTH_REGISTER_GLOBAL_DAILY"] = "30"
	enabled["LAB_AUTH_REGISTER_MAX_USERS"] = "50"
	on := mustLoad(t, enabled)
	if !on.RegistrationEnabled || on.RegisterSourceHourly != 3 || on.RegisterGlobalDaily != 30 || on.RegisterMaxUsers != 50 {
		t.Fatalf("override = %+v", on)
	}
	if err := on.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestRegistrationInvalidValuesRejected(t *testing.T) {
	cases := []map[string]string{
		{"LAB_AUTH_REGISTER_SOURCE_HOURLY": "0"},
		{"LAB_AUTH_REGISTER_SOURCE_HOURLY": "200000"},
		{"LAB_AUTH_REGISTER_GLOBAL_DAILY": "-1"},
		{"LAB_AUTH_REGISTER_GLOBAL_DAILY": "2000000"},
		{"LAB_AUTH_REGISTER_MAX_USERS": "0"},
		{"LAB_AUTH_REGISTER_MAX_USERS": "20000001"},
		{"LAB_AUTH_REGISTER_GLOBAL_DAILY": "not-a-number"},
	}
	for _, extra := range cases {
		values := map[string]string{"LAB_AUTH_LISTEN": "127.0.0.1:8081", "LAB_AUTH_DB": "/tmp/auth.db"}
		for key, value := range extra {
			values[key] = value
		}
		cfg, err := Load(envMap(values))
		if err == nil {
			err = cfg.Validate()
		}
		if err == nil {
			t.Fatalf("%v must be rejected", extra)
		}
	}
}

func mustLoad(t *testing.T, values map[string]string) Config {
	t.Helper()
	cfg, err := Load(envMap(values))
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func clone(values map[string]string) map[string]string {
	out := make(map[string]string, len(values))
	for k, v := range values {
		out[k] = v
	}
	return out
}
