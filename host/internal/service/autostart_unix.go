//go:build !windows

package service

import (
	"errors"
	"runtime"
)

var goos = runtime.GOOS

func setRunValue(string, bool) (string, error) { return "", errors.New("not Windows") }

func runValueSet() bool { return false }
