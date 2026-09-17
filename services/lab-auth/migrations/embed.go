// Package migrations embeds the SQLite schema files so the compiled binary can
// migrate without the source tree.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
