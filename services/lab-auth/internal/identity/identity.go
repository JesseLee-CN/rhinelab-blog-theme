package identity

import "strings"

// Rules mirrored from src/boot-identity.ts (CONTRACT.md §2). The two
// implementations are held in sync by the shared fixture at
// scripts/auth/fixtures/identity-cases.json (see parity_test.go).

const (
	UsernameMin = 3
	UsernameMax = 24
	PasswordMin = 15
	PasswordMax = 128
)

var reservedUsernameKeys = []string{"guest"}

// Key is the ASCII lower-case uniqueness key. Never displayed.
func Key(username string) string { return strings.ToLower(username) }

// Label is the upper-case display value for "ID CONFIRMED : <LABEL>".
func Label(username string) string { return strings.ToUpper(username) }

// CodePoints counts Unicode code points, matching [...value].length in TS.
func CodePoints(value string) int { return len([]rune(value)) }

type UsernameError string

const (
	UsernameTooShort UsernameError = "too-short"
	UsernameTooLong  UsernameError = "too-long"
	UsernameCharset  UsernameError = "charset"
	UsernameReserved UsernameError = "reserved"
)

func isUsernameRune(r rune) bool {
	switch {
	case r >= 'A' && r <= 'Z':
		return true
	case r >= 'a' && r <= 'z':
		return true
	case r >= '0' && r <= '9':
		return true
	case r == '.' || r == '_' || r == '-':
		return true
	default:
		return false
	}
}

// ValidateUsername returns the uniqueness key, or an error string matching the
// TS UsernameError union.
func ValidateUsername(value string) (key string, err UsernameError) {
	length := CodePoints(value)
	if length < UsernameMin {
		return "", UsernameTooShort
	}
	if length > UsernameMax {
		return "", UsernameTooLong
	}
	for _, r := range value {
		if !isUsernameRune(r) {
			return "", UsernameCharset
		}
	}
	key = Key(value)
	for _, reserved := range reservedUsernameKeys {
		if key == reserved {
			return "", UsernameReserved
		}
	}
	return key, ""
}

type PasswordError string

const (
	PasswordTooShort PasswordError = "too-short"
	PasswordTooLong  PasswordError = "too-long"
)

// ValidatePassword counts code points; it never trims or normalises.
func ValidatePassword(value string) PasswordError {
	length := CodePoints(value)
	if length < PasswordMin {
		return PasswordTooShort
	}
	if length > PasswordMax {
		return PasswordTooLong
	}
	return ""
}
