!macro customUnInstall
  ; A per-user scheduled task outlives the application files unless the uninstaller
  ; removes it explicitly. Ignore "task not found" so uninstall remains best-effort.
  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /F /TN "CleanMyCodex Automatic Cleanup"'
!macroend
