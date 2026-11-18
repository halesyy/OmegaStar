; Installs made up to 0.6.5 used the product's old name for their folder, keys, shortcuts and login item. These hooks
; move such an install into this one.

!define OLD_PRODUCT_NAME "Omega Star"
!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_PRODUCT_NAME}"
!define RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define STARTUPAPPROVEDKEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"

Var OldInstallDir

; Finds the old install and stops its app, as the installer does for its own.
!macro NSIS_HOOK_PREINSTALL
  StrCpy $OldInstallDir ""
  ReadRegStr $0 SHCTX "${OLD_UNINSTKEY}" "DisplayName"
  ${If} $0 != ""
    ReadRegStr $OldInstallDir SHCTX "${MANUKEY}\${OLD_PRODUCT_NAME}" ""
  ${EndIf}
  ${If} $OldInstallDir != ""
  ${AndIf} $OldInstallDir != $INSTDIR
    !insertmacro CheckIfAppIsRunning "$OldInstallDir\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ${EndIf}
!macroend

; Replaces the old shortcut in `dir` with one to this install, only where the user still has it.
!macro MoveOldShortcut dir
  ${If} ${FileExists} "${dir}\${OLD_PRODUCT_NAME}.lnk"
    !insertmacro UnpinShortcut "${dir}\${OLD_PRODUCT_NAME}.lnk"
    Delete "${dir}\${OLD_PRODUCT_NAME}.lnk"
    CreateShortcut "${dir}\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "${dir}\${PRODUCTNAME}.lnk"
  ${EndIf}
!macroend

; Moves the old shortcuts and login item to this install and removes the old program files and keys.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $OldInstallDir != ""
    ${If} $OldInstallDir != $INSTDIR
      Delete "$OldInstallDir\${MAINBINARYNAME}.exe"
      Delete "$OldInstallDir\uninstall.exe"
      RMDir "$OldInstallDir"
    ${EndIf}
    !insertmacro MoveOldShortcut "$SMPROGRAMS"
    !insertmacro MoveOldShortcut "$DESKTOP"
    ReadRegStr $0 HKCU "${RUNKEY}" "${OLD_PRODUCT_NAME}"
    ${If} $0 != ""
      WriteRegStr HKCU "${RUNKEY}" "${PRODUCTNAME}" '"$INSTDIR\${MAINBINARYNAME}.exe" --background'
      DeleteRegValue HKCU "${RUNKEY}" "${OLD_PRODUCT_NAME}"
    ${EndIf}
    DeleteRegValue HKCU "${STARTUPAPPROVEDKEY}" "${OLD_PRODUCT_NAME}"
    DeleteRegKey SHCTX "${OLD_UNINSTKEY}"
    DeleteRegKey SHCTX "${MANUKEY}\${OLD_PRODUCT_NAME}"
  ${EndIf}
!macroend
