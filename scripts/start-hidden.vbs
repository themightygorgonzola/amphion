' start-hidden.vbs
' Launches the Amphion supervisor (node scripts/start.js) with no visible window.
' Used as the Task Scheduler action so no CMD window appears at login.
' WScript.Run window style 0 = SW_HIDE

Dim oShell, sRoot, sNode
Set oShell = CreateObject("WScript.Shell")

' Derive the project root from this script's location
sRoot = CreateObject("Scripting.FileSystemObject").GetParentFolderName( _
          CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName))

' Build command: node scripts\start.js  (no --headless — Electron is included)
sNode = oShell.ExpandEnvironmentStrings("%PROGRAMFILES%\nodejs\node.exe")
If Not CreateObject("Scripting.FileSystemObject").FileExists(sNode) Then
    ' Fallback: just use "node" from PATH
    sNode = "node"
End If

oShell.Run Chr(34) & sNode & Chr(34) & " " & Chr(34) & sRoot & "\scripts\start.js" & Chr(34), 0, False

Set oShell = Nothing
