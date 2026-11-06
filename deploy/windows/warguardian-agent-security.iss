[Code]
{ Checks of the WarGuardian Agent installer for folders and paths that other
  accounts may control. warguardian-agent.iss includes this file. }

const
  FileAttributeDirectory = $10;
  FileAttributeReparsePoint = $400;
  InvalidFileAttributes = $FFFFFFFF;
  SeFileObject = 1;
  OwnerSecurityInformation = 1;
  DaclSecurityInformation = 4;
  WinLocalSystemSid = 22;
  WinBuiltinAdministratorsSid = 26;
  SddlRevision = 1;
  DriveLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  { SYSTEM and Administrators have full control. Nothing is inherited. }
  DataDirSddl = 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)';

function WinGetFileAttributes(Path: String): Cardinal;
  external 'GetFileAttributesW@kernel32 stdcall';
function WinGetNamedSecurityInfo(ObjectName: String; ObjectType: Integer;
  SecurityInfo: Cardinal; var Owner: Longword; Group, Dacl, Sacl: Longword;
  var Descriptor: Longword): Cardinal;
  external 'GetNamedSecurityInfoW@advapi32 stdcall';
function WinSetNamedSecurityInfo(ObjectName: String; ObjectType: Integer;
  SecurityInfo: Cardinal; Owner, Group, Dacl, Sacl: Longword): Cardinal;
  external 'SetNamedSecurityInfoW@advapi32 stdcall';
function WinIsWellKnownSid(Sid: Longword; SidType: Integer): Longword;
  external 'IsWellKnownSid@advapi32 stdcall';
function WinStringToSecurityDescriptor(Sddl: String; Revision: Cardinal;
  var Descriptor: Longword; Size: Longword): Longword;
  external 'ConvertStringSecurityDescriptorToSecurityDescriptorW@advapi32 stdcall';
function WinGetSecurityDescriptorDacl(Descriptor: Longword;
  var Present: Longword; var Dacl: Longword; var Defaulted: Longword): Longword;
  external 'GetSecurityDescriptorDacl@advapi32 stdcall';
function WinLocalFree(Memory: Longword): Longword;
  external 'LocalFree@kernel32 stdcall';

{ A junction or symbolic link. }
function IsReparsePoint(Path: String): Boolean;
var
  Attributes: Cardinal;
begin
  Attributes := WinGetFileAttributes(Path);
  Result := (Attributes <> InvalidFileAttributes) and
    ((Attributes and FileAttributeReparsePoint) <> 0);
end;

{ True when SYSTEM or the Administrators group owns the file or folder. }
function OwnedByAdministrators(Path: String): Boolean;
var
  Owner, Descriptor: Longword;
begin
  Result := False;
  Owner := 0;
  Descriptor := 0;
  if WinGetNamedSecurityInfo(Path, SeFileObject, OwnerSecurityInformation,
      Owner, 0, 0, 0, Descriptor) <> 0 then
    exit;
  try
    Result := (Owner <> 0) and
      ((WinIsWellKnownSid(Owner, WinBuiltinAdministratorsSid) <> 0) or
       (WinIsWellKnownSid(Owner, WinLocalSystemSid) <> 0));
  finally
    WinLocalFree(Descriptor);
  end;
end;

{ Replace every entry of the access list with Sddl, which must be
  protected, so nothing is inherited from the parent. Inheritable entries
  reach the files and folders inside. Windows does not follow a junction
  while it does this. }
function SetProtectedDacl(Path, Sddl: String): Boolean;
var
  Descriptor, Present, Dacl, Defaulted: Longword;
begin
  Result := False;
  Descriptor := 0;
  if WinStringToSecurityDescriptor(Sddl, SddlRevision, Descriptor, 0) = 0 then
    exit;
  try
    Present := 0;
    Dacl := 0;
    Defaulted := 0;
    if (WinGetSecurityDescriptorDacl(Descriptor, Present, Dacl, Defaulted) <> 0) and
      (Present <> 0) and (Dacl <> 0) then
      Result := WinSetNamedSecurityInfo(Path, SeFileObject,
        DaclSecurityInformation + $80000000, 0, 0, Dacl, 0) = 0;
  finally
    WinLocalFree(Descriptor);
  end;
end;

{ The data folder sits in C:\ProgramData, where every account may create a
  folder and own it. An existing folder is used only when SYSTEM or
  Administrators own it and it is no link. Its permissions are then
  replaced, so no other account keeps an entry. }
function SecureDataDir(Dir: String): String;
begin
  Result := '';
  if not DirExists(Dir) then
    CreateDir(Dir);
  if IsReparsePoint(Dir) or not DirExists(Dir) then
    Result := 'Setup stopped: ' + Dir + ' is a link or a file. Remove it and run setup again.'
  else if not OwnedByAdministrators(Dir) then
    Result := 'Setup stopped: another account owns ' + Dir + '. Remove the folder and run setup again.'
  else if not SetProtectedDacl(Dir, DataDirSddl) then
    Result := 'The permissions of ' + Dir + ' could not be set.';
end;

{ A folder the service account writes, inside the secured data folder. A
  link in its place is removed, which leaves its target unchanged. }
function PrepareWritableFolder(Dir: String): String;
begin
  Result := '';
  if IsReparsePoint(Dir) then
    RemoveDir(Dir);
  if not DirExists(Dir) then
    CreateDir(Dir);
  if IsReparsePoint(Dir) or not DirExists(Dir) then
    Result := 'The folder ' + Dir + ' could not be created.';
end;

{ A path from the agent's access list that may stand in double quotes on an
  icacls command line: a drive letter, a colon, a backslash and more, with no
  quote, slash, control character, second colon, empty, . or .. part or
  trailing backslash. It must exist as the named kind and be no link. }
function SafeAccessPath(Path: String; Folder: Boolean): Boolean;
var
  Index: Integer;
  Parts: String;
  Attributes: Cardinal;
begin
  Result := (Length(Path) >= 4) and (Length(Path) <= 1024) and
    (Pos(Uppercase(Copy(Path, 1, 1)), DriveLetters) > 0) and
    (Copy(Path, 2, 2) = ':\') and (Path[Length(Path)] <> '\');
  if not Result then
    exit;
  for Index := 1 to Length(Path) do
    if (Ord(Path[Index]) < 32) or (Path[Index] = '"') or (Path[Index] = '/') or
      ((Index > 2) and (Path[Index] = ':')) then
      Result := False;
  Parts := Copy(Path, 3, Length(Path)) + '\';
  if (Pos('\\', Parts) > 0) or (Pos('\.\', Parts) > 0) or (Pos('\..\', Parts) > 0) then
    Result := False;
  if not Result then
    exit;
  Attributes := WinGetFileAttributes(Path);
  Result := (Attributes <> InvalidFileAttributes) and
    ((Attributes and FileAttributeReparsePoint) = 0) and
    (((Attributes and FileAttributeDirectory) <> 0) = Folder);
end;

{ One line of the agent's access list: file <path> or folder <path>. }
function AccessEntry(Line: String; var Kind, Path: String): Boolean;
begin
  Result := False;
  if Pos('file ', Line) = 1 then
  begin
    Kind := 'file';
    Path := Copy(Line, 6, Length(Line));
  end
  else if Pos('folder ', Line) = 1 then
  begin
    Kind := 'folder';
    Path := Copy(Line, 8, Length(Line));
  end
  else
    exit;
  Result := SafeAccessPath(Path, Kind = 'folder');
end;
