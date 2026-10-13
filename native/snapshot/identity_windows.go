//go:build windows

package main

import (
	"errors"
	"os"
)

func fileIdentity(os.FileInfo) (string, string, error) {
	return "", "", errors.New("Windows root identity verification is not implemented")
}
