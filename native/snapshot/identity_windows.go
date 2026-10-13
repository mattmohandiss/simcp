//go:build windows

package main

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
)

func fileIdentity(path string, _ os.FileInfo) (string, string, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", "", err
	}
	handle, err := windows.CreateFile(name, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", "", err
	}
	defer windows.CloseHandle(handle)
	var data windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &data); err != nil {
		return "", "", err
	}
	inode := uint64(data.FileIndexHigh)<<32 | uint64(data.FileIndexLow)
	return fmt.Sprint(data.VolumeSerialNumber), fmt.Sprint(inode), nil
}
