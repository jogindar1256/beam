; Windows installer extras: allow Beam through Windows Firewall on ALL network types.
; Without this, Windows asks on first launch, and a hotspot or new Wi-Fi is often
; classed as "Public", where inbound transfers are blocked silently. This was the
; most likely cause of "the other computer doesn't show up".
!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Beam"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Beam" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Beam"'
!macroend
