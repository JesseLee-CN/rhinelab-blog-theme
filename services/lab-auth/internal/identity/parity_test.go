package identity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The TypeScript contract generates this fixture. If the two implementations
// drift, this test fails with the exact case.
const fixturePath = "../../../../scripts/auth/fixtures/identity-cases.json"

type usernameCase struct {
	Value string `json:"value"`
	OK    bool   `json:"ok"`
	Key   string `json:"key"`
	Label string `json:"label"`
	Error string `json:"error"`
}

type passwordCase struct {
	Value      string `json:"value"`
	OK         bool   `json:"ok"`
	Error      string `json:"error"`
	CodePoints int    `json:"codePoints"`
}

type fixture struct {
	Username []usernameCase `json:"username"`
	Password []passwordCase `json:"password"`
}

func TestParityWithTypeScriptContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.FromSlash(fixturePath))
	if err != nil {
		t.Fatalf("read fixture (run scripts/auth/gen-identity-fixtures.mjs): %v", err)
	}
	var data fixture
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(data.Username) == 0 || len(data.Password) == 0 {
		t.Fatal("fixture is empty")
	}

	for _, tc := range data.Username {
		key, verr := ValidateUsername(tc.Value)
		if tc.OK {
			if verr != "" || key != tc.Key {
				t.Errorf("username %q: Go=(%q,%q), TS key=%q", tc.Value, key, verr, tc.Key)
			}
			if Label(tc.Value) != tc.Label {
				t.Errorf("username %q: Go label=%q, TS label=%q", tc.Value, Label(tc.Value), tc.Label)
			}
		} else if string(verr) != tc.Error {
			t.Errorf("username %q: Go error=%q, TS error=%q", tc.Value, verr, tc.Error)
		}
	}

	for _, tc := range data.Password {
		perr := ValidatePassword(tc.Value)
		if tc.OK {
			if perr != "" {
				t.Errorf("password %q: Go error=%q, TS ok", tc.Value, perr)
			}
		} else if string(perr) != tc.Error {
			t.Errorf("password %q: Go error=%q, TS error=%q", tc.Value, perr, tc.Error)
		}
		if CodePoints(tc.Value) != tc.CodePoints {
			t.Errorf("password %q: Go code points=%d, TS=%d", tc.Value, CodePoints(tc.Value), tc.CodePoints)
		}
	}
}
