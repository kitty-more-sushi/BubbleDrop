; Lets phones reach BubbleDrop through Windows Firewall on any network type
; (phone hotspots usually show up as "Public" networks).
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="BubbleDrop"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="BubbleDrop" dir=in action=allow program="$INSTDIR\BubbleDrop.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="BubbleDrop"'
!macroend
