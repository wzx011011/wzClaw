; customUnInstall — 卸载时询问是否删除应用数据
!macro customUnInstall
  MessageBox MB_YESNO \
    "是否同时删除应用数据（会话记录、设置、密钥等）？$\n$\n选择「否」将保留数据，下次安装时可恢复。" \
    IDYES deleteAppData IDNO keepAppData
  deleteAppData:
    RMDir /r "$APPDATA\wzxclaw"
    RMDir /r "$PROFILE\.wzxclaw"
  keepAppData:
!macroend
