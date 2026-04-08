package mockrealtime

// ReceiveSourceArchiveCommand builds a platform→agent JSON payload for receive_source_archive
// using a .tar.gz already present on the agent host (typical mock / local dev flow).
// commandId defaults to "mock-receive-archive-1" when empty.
func ReceiveSourceArchiveCommand(archivePath, destDir, commandID string) map[string]interface{} {
	if commandID == "" {
		commandID = "mock-receive-archive-1"
	}
	m := map[string]interface{}{
		"type":        "receive_source_archive",
		"commandId":   commandID,
		"archivePath": archivePath,
	}
	if destDir != "" {
		m["destDir"] = destDir
	}
	return m
}
