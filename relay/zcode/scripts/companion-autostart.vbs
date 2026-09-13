' companion-autostart.vbs -- run the zcode companion hidden at Windows logon.
'
' Launches node with relay/zcode/companion.js in a hidden console and appends
' stdout/stderr to %USERPROFILE%\.wzxclaw\zcode-companion\autostart.log.
' NOTE: the log contains the one-time pairing URL -- it is a holder
' credential, do not share it or commit it anywhere.
'
' Registered by install-autostart.bat as scheduled task "wzxClawZcodeCompanion".
' All file paths are resolved relative to this script's own location, so the
' repository can be moved without editing this file.
Option Explicit

Const RELAY_URL = "wss://zcode.5945.top/ws"
Const NODE_EXE = "C:\Program Files\nodejs\node.exe"

Dim fso, shell, q, scriptsDir, zcodeDir, companionJs, logDir, logFile
Dim nodePath, cmdExe, cmdLine

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
q = Chr(34)

' companion.js sits one level above this scripts\ folder (scripts\..\companion.js)
scriptsDir = fso.GetParentFolderName(WScript.ScriptFullName)
zcodeDir = fso.GetParentFolderName(scriptsDir)
companionJs = zcodeDir & "\companion.js"

If Not fso.FileExists(companionJs) Then
  MsgBox "companion.js not found at:" & vbCrLf & companionJs & vbCrLf & vbCrLf _
    & "Expected next to the scripts\ folder of this VBS.", vbCritical, "zcode companion autostart"
  WScript.Quit 1
End If

' Use the pinned node install; fall back to a PATH lookup if it is missing.
If fso.FileExists(NODE_EXE) Then
  nodePath = NODE_EXE
Else
  nodePath = "node.exe"
End If

' Create the log directory (and parents) before cmd tries to append to the file.
logDir = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.wzxclaw\zcode-companion"
EnsureFolder logDir
logFile = logDir & "\autostart.log"

' The companion inherits this directory as its cwd (default --cwd for app-server).
shell.CurrentDirectory = zcodeDir

' cmd is required for ">>" redirection; quoting follows the cmd /c ""..."" rule.
' --no-qr keeps the log clean: the pairing URL is still printed as plain text.
cmdExe = shell.ExpandEnvironmentStrings("%ComSpec%")
cmdLine = q & cmdExe & q & " /c " & q & q & nodePath & q & " " & q & companionJs & q _
  & " --relay " & RELAY_URL & " --no-qr" _
  & " >> " & q & logFile & q & " 2>&1" & q

' 0 = hidden window, False = do not wait for the child process to exit.
shell.Run cmdLine, 0, False

' Recursively create a folder path, ignoring races and non-fatal errors.
Sub EnsureFolder(folderPath)
  Dim parent
  If fso.FolderExists(folderPath) Then Exit Sub
  parent = fso.GetParentFolderName(folderPath)
  If parent <> "" Then EnsureFolder parent
  If Not fso.FolderExists(folderPath) Then
    On Error Resume Next
    fso.CreateFolder folderPath
    On Error GoTo 0
  End If
End Sub
