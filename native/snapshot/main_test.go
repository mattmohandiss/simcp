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
	got, err := snapshot(allowed, []rootSpec{{Path: root}})
	if err != nil || string(got) != "ISO-10303-21;" {
		t.Fatalf("snapshot allowed file: got %q, err %v", got, err)
	}
	if _, err := snapshot(secret, []rootSpec{{Path: root}}); err == nil || !strings.HasPrefix(err.Error(), "path_policy:") {
		t.Fatalf("outside file should be rejected, got %v", err)
	}
	if _, err := snapshot(root, []rootSpec{{Path: root}}); err == nil || !strings.HasPrefix(err.Error(), "path_policy:") {
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
	if _, err := snapshot(link, []rootSpec{{Path: root}}); err == nil || !strings.HasPrefix(err.Error(), "path_policy:") {
		t.Fatalf("symlink escape should be rejected, got %v", err)
	}
}

func TestSnapshotRejectsAncestorSwapAfterAdmission(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	dir := filepath.Join(root, "model")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "part.step"), []byte("allowed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "part.step"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := snapshotWithHook(filepath.Join(dir, "part.step"), []rootSpec{{Path: root}}, func() {
		if renameErr := os.Rename(dir, filepath.Join(root, "old-model")); renameErr != nil {
			t.Fatal(renameErr)
		}
		if linkErr := os.Symlink(outside, dir); linkErr != nil {
			t.Skipf("symlink unavailable: %v", linkErr)
		}
	})
	if err == nil || !strings.HasPrefix(err.Error(), "path_policy:") {
		t.Fatalf("ancestor replacement should be rejected, got %v", err)
	}
}

func TestSnapshotRejectsReplacedRoot(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	path := filepath.Join(root, "part.step")
	if err := os.WriteFile(path, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	device, inode, err := fileIdentity(info)
	if err != nil {
		t.Skipf("root identity unavailable: %v", err)
	}
	moved := filepath.Join(outside, "old-root")
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "part.step"), []byte("attacker"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = snapshot(filepath.Join(root, "part.step"), []rootSpec{{Path: root, Device: device, Inode: inode}})
	if err == nil || !strings.HasPrefix(err.Error(), "stale_artifact:") {
		t.Fatalf("replaced root should be rejected, got %v", err)
	}
}
