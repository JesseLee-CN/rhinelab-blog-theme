// Package config loads and validates the auth service configuration.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/example-org/example-blog/services/lab-auth/internal/password"
)

type Env string

const (
	Development Env = "development"
	Production  Env = "production"
)

type Config struct {
	Env            Env
	Listen         string // "unix:/run/.../http.sock" or "127.0.0.1:8081"
	DBPath         string
	AllowedOrigins []string
	Argon          password.Params
	CSRFSecret     []byte
	CookieSecure   bool

	SessionIdle        time.Duration
	SessionAbsolute    time.Duration
	PendingTTL         time.Duration
	FlowTTL            time.Duration
	CSRFTTL            time.Duration
	ShutdownGrace      time.Duration
	MaxBodyBytes       int64
	HashConcurrency    int
	HashQueue          int
	SourceRatePerMin   int
	SourceBurst        int
	UsernameRate       int
	UsernameWindow     time.Duration
	MaxAttemptsPerFlow int

	// Public registration (register-v1). Disabled by default; see CONTRACT §11.
	RegistrationEnabled  bool
	RegisterSourceHourly int
	RegisterGlobalDaily  int
	RegisterMaxUsers     int

	// Account management API (/api/auth/admin/...). Disabled while empty: the
	// endpoints exist but answer 503, so no deployment grows an unauthenticated
	// management surface by accident.
	AdminToken string
	AdminRate  int
}

func Load(getenv func(string) string) (Config, error) {
	cfg := Config{
		Env:                Development,
		Listen:             "unix:/run/example-blog-auth/http.sock",
		Argon:              password.DefaultParams(),
		CookieSecure:       true,
		SessionIdle:        30 * time.Minute,
		SessionAbsolute:    12 * time.Hour,
		PendingTTL:         60 * time.Second,
		FlowTTL:            10 * time.Minute,
		CSRFTTL:            10 * time.Minute,
		ShutdownGrace:      10 * time.Second,
		MaxBodyBytes:       4 << 10,
		HashConcurrency:    2,
		HashQueue:          8,
		SourceRatePerMin:   10,
		SourceBurst:        3,
		UsernameRate:       5,
		UsernameWindow:     15 * time.Minute,
		MaxAttemptsPerFlow: 4,

		RegistrationEnabled:  false,
		RegisterSourceHourly: 10,
		RegisterGlobalDaily:  200,
		RegisterMaxUsers:     5000,

		AdminRate: 60,
	}
	if v := strings.TrimSpace(getenv("LAB_AUTH_ENV")); v != "" {
		cfg.Env = Env(v)
	}
	if v := strings.TrimSpace(getenv("LAB_AUTH_LISTEN")); v != "" {
		cfg.Listen = v
	}
	cfg.DBPath = strings.TrimSpace(getenv("LAB_AUTH_DB"))
	if v := strings.TrimSpace(getenv("LAB_AUTH_ALLOWED_ORIGINS")); v != "" {
		for _, origin := range strings.Split(v, ",") {
			if origin = strings.TrimSpace(origin); origin != "" {
				cfg.AllowedOrigins = append(cfg.AllowedOrigins, origin)
			}
		}
	}
	if raw := strings.TrimSpace(getenv("LAB_AUTH_CSRF_SECRET")); raw != "" {
		secret, err := hex.DecodeString(raw)
		if err != nil {
			return Config{}, fmt.Errorf("config: LAB_AUTH_CSRF_SECRET must be hex-encoded")
		}
		cfg.CSRFSecret = secret
	}
	if strings.TrimSpace(getenv("LAB_AUTH_COOKIE_INSECURE")) == "1" {
		cfg.CookieSecure = false
	}
	if len(cfg.CSRFSecret) == 0 && cfg.Env == Development {
		secret := make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			return Config{}, err
		}
		cfg.CSRFSecret = secret
	}
	if err := applyInt(getenv, "LAB_AUTH_ARGON_MEMORY_KIB", func(n int) error {
		cfg.Argon.Memory = uint32(n)
		return nil
	}); err != nil {
		return Config{}, err
	}
	if err := applyInt(getenv, "LAB_AUTH_ARGON_ITERATIONS", func(n int) error {
		cfg.Argon.Iterations = uint32(n)
		return nil
	}); err != nil {
		return Config{}, err
	}
	if err := applyInt(getenv, "LAB_AUTH_ARGON_PARALLELISM", func(n int) error {
		cfg.Argon.Parallelism = uint8(n)
		return nil
	}); err != nil {
		return Config{}, err
	}
	if err := applyDuration(getenv, "LAB_AUTH_PENDING_TTL", &cfg.PendingTTL); err != nil {
		return Config{}, err
	}
	if err := applyDuration(getenv, "LAB_AUTH_FLOW_TTL", &cfg.FlowTTL); err != nil {
		return Config{}, err
	}
	// Limit overrides exist for calibration (G7) and controlled tests; the
	// production defaults above are unchanged when the variables are absent.
	if err := applyInt(getenv, "LAB_AUTH_SOURCE_RATE_PER_MIN", func(n int) error {
		cfg.SourceRatePerMin = n
		return nil
	}); err != nil {
		return Config{}, err
	}
	if err := applyInt(getenv, "LAB_AUTH_USERNAME_RATE", func(n int) error {
		cfg.UsernameRate = n
		return nil
	}); err != nil {
		return Config{}, err
	}
	if v := strings.TrimSpace(getenv("LAB_AUTH_REGISTRATION_ENABLED")); v == "1" || strings.EqualFold(v, "true") {
		cfg.RegistrationEnabled = true
	}
	if err := applyInt(getenv, "LAB_AUTH_REGISTER_SOURCE_HOURLY", func(n int) error {
		cfg.RegisterSourceHourly = n
		return nil
	}); err != nil {
		return Config{}, err
	}
	if err := applyInt(getenv, "LAB_AUTH_REGISTER_GLOBAL_DAILY", func(n int) error {
		cfg.RegisterGlobalDaily = n
		return nil
	}); err != nil {
		return Config{}, err
	}
	if err := applyInt(getenv, "LAB_AUTH_REGISTER_MAX_USERS", func(n int) error {
		cfg.RegisterMaxUsers = n
		return nil
	}); err != nil {
		return Config{}, err
	}
	cfg.AdminToken = strings.TrimSpace(getenv("LAB_AUTH_ADMIN_TOKEN"))
	if err := applyInt(getenv, "LAB_AUTH_ADMIN_RATE", func(n int) error {
		cfg.AdminRate = n
		return nil
	}); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if c.Env != Development && c.Env != Production {
		return fmt.Errorf("config: unknown LAB_AUTH_ENV %q", c.Env)
	}
	if !strings.HasPrefix(c.Listen, "unix:") && !strings.HasPrefix(c.Listen, "127.0.0.1:") && !strings.HasPrefix(c.Listen, "[::1]:") {
		return fmt.Errorf("config: LAB_AUTH_LISTEN must be a unix socket or loopback address, got %q", c.Listen)
	}
	if c.DBPath == "" {
		return fmt.Errorf("config: LAB_AUTH_DB is required")
	}
	if c.Env == Production {
		if len(c.AllowedOrigins) == 0 {
			return fmt.Errorf("config: production requires LAB_AUTH_ALLOWED_ORIGINS")
		}
		for _, origin := range c.AllowedOrigins {
			u, err := url.Parse(origin)
			if err != nil || u.Scheme != "https" || u.Host == "" {
				return fmt.Errorf("config: production origin %q must be an https origin", origin)
			}
		}
		if !strings.HasPrefix(c.Listen, "unix:") {
			return fmt.Errorf("config: production must listen on a unix socket")
		}
		if len(c.CSRFSecret) < 32 {
			return fmt.Errorf("config: production requires LAB_AUTH_CSRF_SECRET of at least 32 bytes")
		}
	}
	if len(c.CSRFSecret) < 16 {
		return fmt.Errorf("config: CSRF secret too short")
	}
	if c.MaxBodyBytes < 1024 || c.MaxBodyBytes > 1<<20 {
		return fmt.Errorf("config: unreasonable MaxBodyBytes %d", c.MaxBodyBytes)
	}
	if c.HashConcurrency < 1 || c.HashQueue < 0 {
		return fmt.Errorf("config: invalid hash concurrency")
	}
	if c.RegisterSourceHourly < 1 || c.RegisterSourceHourly > 100000 {
		return fmt.Errorf("config: unreasonable RegisterSourceHourly %d", c.RegisterSourceHourly)
	}
	if c.RegisterGlobalDaily < 1 || c.RegisterGlobalDaily > 1000000 {
		return fmt.Errorf("config: unreasonable RegisterGlobalDaily %d", c.RegisterGlobalDaily)
	}
	if c.RegisterMaxUsers < 1 || c.RegisterMaxUsers > 10000000 {
		return fmt.Errorf("config: unreasonable RegisterMaxUsers %d", c.RegisterMaxUsers)
	}
	// A management token is optional, but a weak one is worse than none: 32
	// characters is the shortest value that is plausibly random.
	if c.AdminToken != "" && len(c.AdminToken) < 32 {
		return fmt.Errorf("config: LAB_AUTH_ADMIN_TOKEN must be at least 32 characters (or unset to disable the admin API)")
	}
	if c.AdminRate < 1 || c.AdminRate > 100000 {
		return fmt.Errorf("config: unreasonable AdminRate %d", c.AdminRate)
	}
	if _, err := password.Hash("config-validation-only", c.Argon); err != nil {
		return err
	}
	return nil
}

func applyInt(getenv func(string) string, key string, set func(int) error) error {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fmt.Errorf("config: %s must be an integer", key)
	}
	return set(n)
}

func applyDuration(getenv func(string) string, key string, target *time.Duration) error {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return fmt.Errorf("config: %s must be a duration", key)
	}
	*target = d
	return nil
}

// OS returns the process environment loader.
func OS(key string) string { return os.Getenv(key) }
