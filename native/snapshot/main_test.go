package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSnapshotAllowsOnlyRegularFilesBeneathRoot(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	allowed := filepath.Join(root, "model.step")
	secret := filepath.Join(outside, "secret.step")
	if err := os.WriteFile(allowed, []byte("ISO-10303-21;"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secret, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := snapshot(allowed, []string{root})
	if err != nil || string(got) != "ISO-10303-21;" {
		t.Fatalf("snapshot allowed file: got %q, err %v", got, err)
	}
	if _, err := snapshot(secret, []string{root}); err == nil || !strings.HasPrefix(err.Error(), "path_policy:") {
		t.Fatalf("outside file should be rejected, got %v", err)
	}
	if _, err := snapshot(root, []string{root}); err == nil || !strings.HasPrefix(err.Error(), "path_policy:") {
		t.Fatalf("directory should be rejected, got %v", err)
	}
}

func TestSnapshotRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.step")
	if err := os.WriteFile(secret, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "linked.step")
	if err := os.Symlink(secret, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := snapshot(link, []string{root}); err == nil || !strings.HasPrefix(err.Error(), "path_policy:") {
		t.Fatalf("symlink escape should be rejected, got %v", err)
	}
}
