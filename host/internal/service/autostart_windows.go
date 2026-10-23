package service

import (
	"errors"

	"golang.org/x/sys/windows/registry"
)

const goos = "windows"

const runKeyPath = `HKCU\` + RunKey

// setRunValue writes or deletes HKCU\...\Run "n2n-nexus-host".
func setRunValue(exe string, on bool) (string, error) {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, RunKey, registry.SET_VALUE)
	if err != nil {
		return runKeyPath, err
	}
	defer k.Close()
	if on {
		return runKeyPath, k.SetStringValue(RunValue, WindowsRunValue(exe))
	}
	if err := k.DeleteValue(RunValue); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return runKeyPath, err
	}
	return runKeyPath, nil
}

func runValueSet() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, RunKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(RunValue)
	return err == nil
}
