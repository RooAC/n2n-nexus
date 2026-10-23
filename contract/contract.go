// Package contract embeds the protocol files the host shares with the
// TypeScript clients and the conformance tests (see README.md).
package contract

import _ "embed"

//go:embed tools.json
var ToolsJSON []byte

//go:embed hook.json
var HookJSON []byte

//go:embed errors.json
var ErrorsJSON []byte
