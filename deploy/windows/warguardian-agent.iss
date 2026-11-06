; WarGuardian Agent installer for Windows (Inno Setup 6).
; The agent build (build.mjs) stages the files and passes:
;   /DAgentVersion=<version>  /DAgentNumericVersion=<x.y.z>
;   /DStagingDir=<folder with warguardian-agent.exe, warguardian-agent-service.exe,
;                 warguardian-agent-service.xml and, with /DWithLicense=1, LICENSE.txt>
;   /DPanelDefault=<WarGuardian address shown on the setup code page>
;   /DSignToolName=<name>  with  /S<name>=<signtool command>  when signing is configured
; Silent install: WarGuardianAgentSetup-<version>.exe /VERYSILENT /CODE=WG-XXXXX-XXXXX /PANEL=https://<address>

#ifndef AgentVersion
  #error Define AgentVersion.
#endif
#ifndef AgentNumericVersion
  #define AgentNumericVersion "0.0.0"
#endif
#ifndef StagingDir
  #error Define StagingDir.
#endif
#ifndef PanelDefault
  #define PanelDefault ""
#endif

[Setup]
AppId={{6F0C7B5E-3A2D-4C8B-9E41-7D2A5B9C0E13}
AppName=WarGuardian Agent
AppVersion={#AgentVersion}
AppVerName=WarGuardian Agent {#AgentVersion}
AppPublisher=WarGuardian
VersionInfoVersion={#AgentNumericVersion}
DefaultDirName={autopf}\WarGuardian Agent
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Setup and uninstall do not follow junctions that other accounts created.
RedirectionGuard=yes
#ifdef WithLicense
LicenseFile={#StagingDir}\LICENSE.txt
#endif
UninstallDisplayName=WarGuardian Agent
UninstallDisplayIcon={app}\warguardian-agent.exe
CloseApplications=no
RestartApplications=no
#ifdef SignToolName
SignTool={#SignToolName}
SignedUninstaller=yes
#endif

[Files]
; The service starts this copy, which runs the version self-update selected.
; Setup writes nothing into versions, where the service account creates folders.
Source: "{#StagingDir}\warguardian-agent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StagingDir}\warguardian-agent-service.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StagingDir}\warguardian-agent-service.xml"; DestDir: "{app}"; DestName: "warguardian-agent-service.xml.in"; Flags: ignoreversion
#ifdef WithLicense
Source: "{#StagingDir}\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
#endif

[UninstallRun]
; The system tools stop and remove the service. The service wrapper would
; read its configuration with administrator rights.
Filename: "{sys}\net.exe"; Parameters: "stop WarGuardianAgent"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{sys}\sc.exe"; Parameters: "delete WarGuardianAgent"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\versions"
Type: files; Name: "{app}\warguardian-agent-service.xml"
Type: filesandordirs; Name: "{commonappdata}\WarGuardian"

[Code]
const
  ServiceName = 'WarGuardianAgent';
  ServiceKey = 'SYSTEM\CurrentControlSet\Services\WarGuardianAgent';
  { The virtual service account. It holds only the grants below. }
  ServiceAccount = 'NT SERVICE\WarGuardianAgent';
  CodeCharacters = '0123456789ABCDEFGHJKMNPQRSTVWXYZOIL';
  PanelCharacters = 'abcdefghijklmnopqrstuvwxyz0123456789.-:/[]';

var
  EnrollPage: TInputQueryWizardPage;

#include "warguardian-agent-security.iss"

function DataDir(): String;
begin
  Result := ExpandConstant('{commonappdata}\WarGuardian');
end;

function ServiceExe(): String;
begin
  Result := ExpandConstant('{app}\warguardian-agent-service.exe');
end;

function Enrolled(): Boolean;
begin
  Result := FileExists(DataDir() + '\agent.json');
end;

function ServiceInstalled(): Boolean;
begin
  Result := RegKeyExists(HKLM, ServiceKey);
end;

function CompactCode(Value: String): String;
begin
  Result := Uppercase(Trim(Value));
  StringChangeEx(Result, ' ', '', True);
  StringChangeEx(Result, '-', '', True);
end;

function ValidCode(Value: String): Boolean;
var
  Compact: String;
  Index: Integer;
begin
  Compact := CompactCode(Value);
  Result := (Length(Compact) = 12) and (Copy(Compact, 1, 2) = 'WG');
  if Result then
    for Index := 3 to 12 do
      if Pos(Compact[Index], CodeCharacters) = 0 then
        Result := False;
end;

function ValidPanel(Value: String): Boolean;
var
  Lower: String;
  Index: Integer;
begin
  Lower := Lowercase(Trim(Value));
  Result := (Pos('https://', Lower) = 1) or (Pos('http://localhost', Lower) = 1) or (Pos('http://127.0.0.1', Lower) = 1);
  if Result then
    for Index := 1 to Length(Lower) do
      if Pos(Lower[Index], PanelCharacters) = 0 then
        Result := False;
end;

function EnteredCode(): String;
begin
  Result := Trim(EnrollPage.Values[1]);
end;

function EnteredPanel(): String;
begin
  Result := Trim(EnrollPage.Values[0]);
end;

procedure InitializeWizard;
begin
  EnrollPage := CreateInputQueryPage(wpLicense, 'Setup code', 'Connect this host to WarGuardian.', '');
  EnrollPage.Add('WarGuardian address:', False);
  EnrollPage.Add('Setup code:', False);
  EnrollPage.Values[0] := ExpandConstant('{param:PANEL|{#PanelDefault}}');
  EnrollPage.Values[1] := ExpandConstant('{param:CODE|}');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = EnrollPage.ID) and Enrolled() and (ExpandConstant('{param:CODE|}') = '');
end;

function CheckEnrollment(): String;
begin
  Result := '';
  if EnteredCode() = '' then
  begin
    if not Enrolled() then
      Result := 'Enter the setup code.';
    exit;
  end;
  if not ValidCode(EnteredCode()) then
    Result := 'Enter the code in the form WG-XXXXX-XXXXX.'
  else if not ValidPanel(EnteredPanel()) then
    Result := 'Enter the WarGuardian address as an https:// URL.';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Problem: String;
begin
  Result := True;
  if CurPageID = EnrollPage.ID then
  begin
    Problem := CheckEnrollment();
    if Problem <> '' then
    begin
      MsgBox(Problem, mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function Icacls(Params: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\icacls.exe'), Params, '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function ServiceCommand(Tool, Params: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\' + Tool), Params, '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

{ Grant the service account Rights on a path from the access list or on an
  installer folder. /L changes a link itself, never its target. }
procedure GrantPath(Rights, Path: String; var Problems: String);
begin
  if not Icacls('"' + Path + '" /grant "' + ServiceAccount + ':' + Rights + '" /L /Q') then
    Problems := Problems + #13#10 + Path;
end;

{ A folder in which the service account creates and changes files. On the
  folder itself it may only list and add entries, so it cannot replace the
  folder with a link. }
procedure GrantWritableFolder(Path, FolderRights: String; var Problems: String);
begin
  if IsReparsePoint(Path) or not DirExists(Path) or
    not Icacls('"' + Path + '" /grant:r "' + ServiceAccount + ':' + FolderRights +
      '" "' + ServiceAccount + ':(OI)(CI)(IO)M" /L /Q') then
    Problems := Problems + #13#10 + Path;
end;

{ Read the agent configuration, write its state and logs, and install
  updates into versions, as the Linux service does. The service
  configuration and the program folder stay closed to the account. Game
  files: read access to exactly the RCON files of the configured servers,
  listed by the installer's own copy of the agent and checked again here. }
procedure GrantServiceAccess(var Problems: String);
var
  Lines, Granted: TArrayOfString;
  Index, Count, ResultCode: Integer;
  Agent, List, Kind, Path: String;
begin
  GrantPath('(OI)(CI)RX', DataDir(), Problems);
  GrantWritableFolder(DataDir() + '\state', '(RX,WD,AD)', Problems);
  GrantWritableFolder(DataDir() + '\logs', '(RX,WD,AD)', Problems);
  ForceDirectories(ExpandConstant('{app}\versions'));
  GrantWritableFolder(ExpandConstant('{app}\versions'), '(RX,AD)', Problems);
  Agent := ExpandConstant('{tmp}\warguardian-agent.exe');
  if not FileExists(Agent) then
    ExtractTemporaryFile('warguardian-agent.exe');
  List := ExpandConstant('{tmp}\access.txt');
  if Exec(ExpandConstant('{cmd}'),
      '/C ""' + Agent + '" access --config "' + DataDir() + '\agent.json" > "' + List + '""',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) and
    LoadStringsFromFile(List, Lines) then
  begin
    Count := 0;
    SetArrayLength(Granted, GetArrayLength(Lines));
    for Index := 0 to GetArrayLength(Lines) - 1 do
      if AccessEntry(Lines[Index], Kind, Path) then
      begin
        if Kind = 'file' then
          GrantPath('(R)', Path, Problems)
        else
          GrantPath('(RD)', Path, Problems);
        Granted[Count] := Lines[Index];
        Count := Count + 1;
      end
      else if Trim(Lines[Index]) <> '' then
        Problems := Problems + #13#10 + Lines[Index];
    SetArrayLength(Granted, Count);
    { The uninstaller removes these grants again. }
    SaveStringsToFile(DataDir() + '\access.txt', Granted, False);
  end
  else
    Problems := Problems + #13#10 + 'the RCON files of the configured servers';
end;

{ Remove the game file grants before the service and its account go. }
function InitializeUninstall(): Boolean;
var
  Lines: TArrayOfString;
  Index: Integer;
  Kind, Path: String;
begin
  Result := True;
  if not LoadStringsFromFile(DataDir() + '\access.txt', Lines) then
    exit;
  for Index := 0 to GetArrayLength(Lines) - 1 do
    if AccessEntry(Lines[Index], Kind, Path) then
      Icacls('"' + Path + '" /remove:g "' + ServiceAccount + '" /L /Q');
end;

{ net stop waits until the service has stopped. Neither it nor sc.exe reads
  the service configuration. }
procedure StopService();
begin
  ServiceCommand('net.exe', 'stop ' + ServiceName);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Agent, Log, CodeFile: String;
  Output: AnsiString;
begin
  Result := CheckEnrollment();
  if Result <> '' then
    exit;
  if ServiceInstalled() then
    StopService();
  Result := SecureDataDir(DataDir());
  if Result = '' then
    Result := PrepareWritableFolder(DataDir() + '\state');
  if Result = '' then
    Result := PrepareWritableFolder(DataDir() + '\logs');
  if (Result <> '') or (EnteredCode() = '') then
    exit;
  ExtractTemporaryFile('warguardian-agent.exe');
  Agent := ExpandConstant('{tmp}\warguardian-agent.exe');
  Log := ExpandConstant('{tmp}\enroll.log');
  { The code goes to the agent on stdin, so no process list shows it. }
  CodeFile := ExpandConstant('{tmp}\code.txt');
  if not SaveStringToFile(CodeFile, AnsiString(CompactCode(EnteredCode()) + #13#10), False) then
  begin
    Result := 'Setup failed.';
    exit;
  end;
  try
    if not Exec(ExpandConstant('{cmd}'),
        '/C ""' + Agent + '" enroll --code-stdin --panel "' + EnteredPanel() + '" < "' + CodeFile + '" > "' + Log + '" 2>&1"',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
    begin
      Result := 'Setup failed.';
      if LoadStringFromFile(Log, Output) then
        Result := Result + #13#10 + Trim(String(Output));
    end;
  finally
    DeleteFile(CodeFile);
  end;
end;

{ Write the service configuration from the installed template. A new file
  takes the permissions of the program folder, which only administrators
  may change. }
procedure WriteServiceXml();
var
  Template: AnsiString;
  Text, Target: String;
begin
  if not LoadStringFromFile(ExpandConstant('{app}\warguardian-agent-service.xml.in'), Template) then
    RaiseException('The service configuration template is missing.');
  Text := String(Template);
  StringChangeEx(Text, '@EXECUTABLE@', ExpandConstant('{app}\warguardian-agent.exe'), True);
  StringChangeEx(Text, '@DATA@', DataDir(), True);
  Target := ExpandConstant('{app}\warguardian-agent-service.xml');
  DeleteFile(Target);
  if not SaveStringToFile(Target, AnsiString(Text), False) then
    RaiseException('The service configuration could not be written.');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Problems: String;
begin
  if CurStep <> ssPostInstall then
    exit;
  WriteServiceXml();
  if not ServiceInstalled() then
    if not Exec(ServiceExe(), 'install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
    begin
      SuppressibleMsgBox('The WarGuardian Agent service could not be registered.', mbError, MB_OK, IDOK);
      exit;
    end;
  if not ServiceCommand('sc.exe', 'config ' + ServiceName + ' obj= "' + ServiceAccount + '"') then
  begin
    SuppressibleMsgBox('The WarGuardian Agent service could not run as ' + ServiceAccount + '.', mbError, MB_OK, IDOK);
    exit;
  end;
  Problems := '';
  GrantServiceAccess(Problems);
  if Problems <> '' then
    SuppressibleMsgBox('Give ' + ServiceAccount + ' read access to:' + Problems, mbError, MB_OK, IDOK);
  if Enrolled() then
    if not ServiceCommand('sc.exe', 'start ' + ServiceName) then
      SuppressibleMsgBox('The WarGuardian Agent service could not start. Logs: ' + DataDir() + '\logs', mbError, MB_OK, IDOK);
end;
