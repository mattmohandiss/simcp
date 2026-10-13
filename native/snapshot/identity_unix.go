//go:build unix

package main

import (
	"fmt"
	"os"
	"syscall"
)

func fileIdentity(info os.FileInfo) (string, string, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", "", fmt.Errorf("unsupported Unix file identity")
	}
	return fmt.Sprint(stat.Dev), fmt.Sprint(stat.Ino), nil
}
