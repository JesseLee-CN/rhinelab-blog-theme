package identity

import "testing"

func TestKeyAndLabel(t *testing.T) {
	if got := Key("Joyce-Moore"); got != "joyce-moore" {
		t.Fatalf("Key = %q", got)
	}
	if got := Label("joyce-moore"); got != "JOYCE-MOORE" {
		t.Fatalf("Label = %q", got)
	}
}

func TestValidateUsername(t *testing.T) {
	cases := []struct {
		value string
		key   string
		err   UsernameError
	}{
		{"abc", "abc", ""},
		{"JOYCE_01", "joyce_01", ""},
		{"a.b-c_d", "a.b-c_d", ""},
		{"ab", "", UsernameTooShort},
		{"a", "", UsernameTooShort},
		{"a b", "", UsernameCharset},
		{"中文名", "", UsernameCharset},
		{"a@b", "", UsernameCharset},
		{"guest", "", UsernameReserved},
		{"Guest", "", UsernameReserved},
		{"GUEST", "", UsernameReserved},
	}
	for _, tc := range cases {
		key, err := ValidateUsername(tc.value)
		if key != tc.key || err != tc.err {
			t.Errorf("ValidateUsername(%q) = (%q,%q), want (%q,%q)", tc.value, key, err, tc.key, tc.err)
		}
	}
}

func TestUsernameLengthBounds(t *testing.T) {
	longest := make([]byte, UsernameMax)
	for i := range longest {
		longest[i] = 'a'
	}
	if _, err := ValidateUsername(string(longest)); err != "" {
		t.Fatalf("24 chars should pass, got %q", err)
	}
	if _, err := ValidateUsername(string(append(longest, 'a'))); err != UsernameTooLong {
		t.Fatalf("25 chars should be too-long, got %q", err)
	}
}

func TestValidatePassword(t *testing.T) {
	cases := []struct {
		value string
		err   PasswordError
	}{
		{"a", PasswordTooShort},
		{"aaaaa", PasswordTooShort}, // 5
		{"aaaaaa", PasswordWeak},    // length ok, no uppercase and no digit
		{"AAAAA1", PasswordWeak},    // no lowercase
		{"aaaaa1", PasswordWeak},    // no uppercase
		{"Aaaaaa", PasswordWeak},    // no digit
		{"Aa1bbb", ""},              // the shortest accepted shape
		{"  Aa1  ", ""},             // surrounding spaces preserved
		{"\U0001F600\U0001F600\U0001F600\U0001F600\U0001F600\U0001F600", PasswordWeak}, // 6 code points, no ASCII class
	}
	for _, tc := range cases {
		if err := ValidatePassword(tc.value); err != tc.err {
			t.Errorf("ValidatePassword(%q) = %q, want %q", tc.value, err, tc.err)
		}
	}
	longest := make([]rune, PasswordMax)
	for i := range longest {
		longest[i] = 'a'
	}
	longest[0], longest[1], longest[2] = 'A', 'a', '1'
	if err := ValidatePassword(string(longest)); err != "" {
		t.Fatalf("128 code points with every class should pass, got %q", err)
	}
	if err := ValidatePassword(string(append(longest, 'a'))); err != PasswordTooLong {
		t.Fatalf("129 code points should be too-long, got %q", err)
	}
}
