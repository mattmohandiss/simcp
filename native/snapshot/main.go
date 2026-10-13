package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type request struct {
	Path  string     `json:"path"`
	Roots []rootSpec `json:"roots"`
}

type rootSpec struct {
	Path   string `json:"path"`
	Device string `json:"device,omitempty"`
	Inode  string `json:"inode,omitempty"`
}

type policyError string

func (e policyError) Error() string { return string(e) }

func beneath(root, path string) (string, bool) {
	rel, err := filepath.Rel(root, path)
	if err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", false
	}
	return rel, true
}

// snapshot opens only through an os.Root capability and reads the opened file
// twice. A timeout in the Node caller bounds opens of raced special files.
func snapshot(path string, roots []rootSpec) ([]byte, error) {
	return snapshotWithHook(path, roots, nil)
}

func snapshotWithHook(path string, roots []rootSpec, beforeOpen func()) ([]byte, error) {
	for _, spec := range roots {
		rel, ok := beneath(spec.Path, path)
		if !ok {
			continue
		}
		pathInfo, err := os.Stat(spec.Path)
		if err != nil || !sameRoot(pathInfo, spec) {
			return nil, errors.New("stale_artifact: allowed root changed")
		}
		root, err := os.OpenRoot(spec.Path)
		if err != nil {
			return nil, fmt.Errorf("path_policy: cannot open allowed root: %w", err)
		}
		rootInfo, err := root.Stat(".")
		if err != nil || !sameRoot(rootInfo, spec) {
			root.Close()
			return nil, errors.New("stale_artifact: allowed root changed while opening")
		}
		beforePath, err := root.Stat(rel)
		if err != nil {
			root.Close()
			return nil, fmt.Errorf("path_policy: cannot stat artifact in allowed root: %w", err)
		}
		if !beforePath.Mode().IsRegular() {
			root.Close()
			return nil, errors.New("path_policy: artifact must be a regular file")
		}
		if beforeOpen != nil {
			beforeOpen()
		}
		file, err := root.Open(rel)
		if err != nil {
			root.Close()
			return nil, fmt.Errorf("path_policy: cannot open artifact beneath allowed root: %w", err)
		}
		before, err := file.Stat()
		if err != nil || !before.Mode().IsRegular() {
			file.Close()
			root.Close()
			return nil, errors.New("path_policy: opened artifact is not a regular file")
		}
		first, readErr := io.ReadAll(file)
		if readErr == nil {
			_, readErr = file.Seek(0, io.SeekStart)
		}
		var second []byte
		if readErr == nil {
			second, readErr = io.ReadAll(file)
		}
		after, statErr := file.Stat()
		pathAfter, pathErr := root.Stat(rel)
		file.Close()
		root.Close()
		if readErr != nil || statErr != nil || pathErr != nil ||
			!os.SameFile(before, after) || !os.SameFile(before, pathAfter) ||
			before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || !bytes.Equal(first, second) {
			return nil, errors.New("stale_artifact: artifact changed while being snapshotted")
		}
		return first, nil
	}
	return nil, errors.New("path_policy: artifact is outside allowed roots")
}

func sameRoot(info os.FileInfo, spec rootSpec) bool {
	if spec.Device == "" && spec.Inode == "" {
		return true
	}
	device, inode, err := fileIdentity(info)
	return err == nil && device == spec.Device && inode == spec.Inode
}

func main() {
	var req request
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil || req.Path == "" || len(req.Roots) == 0 {
		fmt.Fprintln(os.Stderr, "invalid_input: expected path and nonempty roots")
		os.Exit(2)
	}
	for _, root := range req.Roots {
		if root.Path == "" || (root.Device == "") != (root.Inode == "") {
			fmt.Fprintln(os.Stderr, "invalid_input: root identity must include device and inode")
			os.Exit(2)
		}
	}
	data, err := snapshot(req.Path, req.Roots)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if _, err := os.Stdout.Write(data); err != nil {
		fmt.Fprintln(os.Stderr, "snapshot_output: ", err)
		os.Exit(1)
	}
}
