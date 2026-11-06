import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
export function validatePreviewState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'expiresAt,instanceId,pid,schema,startedAt' ||
      !/^[0-9a-f]{32}$/.test(value.instanceId ?? '') || value.schema !== `boot_preview_${value.instanceId}` ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      ![value.startedAt, value.expiresAt].every(date => typeof date === 'string' &&
        Number.isFinite(Date.parse(date)) && new Date(date).toISOString() === date) ||
      Date.parse(value.expiresAt) <= Date.parse(value.startedAt) ||
      Date.parse(value.expiresAt) - Date.parse(value.startedAt) > 8 * 60 * 60 * 1000) {
    throw new Error('Invalid local preview marker');
  }
  return value;
}
export async function previewDirectory() {
  const directory = join(repository, 'test-results');
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      resolve(await realpath(directory)) !== resolve(directory)) throw new Error('Invalid preview marker directory');
  return directory;
}
async function privateAcl(path, create) {
  if (process.platform !== 'win32') {
    const info = await lstat(path);
    if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('Private preview marker required');
    return;
  }
  const script = create
    ? `$ErrorActionPreference='Stop';$s=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object Security.AccessControl.FileSecurity;$a.SetOwner($s);$a.SetAccessRuleProtection($true,$false);$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','Allow')));$y=New-Object Security.Principal.SecurityIdentifier('S-1-5-18');$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($y,'FullControl','Allow')));Set-Acl -LiteralPath $env:BOOT_ERP_ACL_TARGET -AclObject $a`
    : `$ErrorActionPreference='Stop';$s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$a=Get-Acl -LiteralPath $env:BOOT_ERP_ACL_TARGET;if(-not $a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $s){throw 'Private ACL required'};$seen=@();foreach($r in $a.Access){$id=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($id -notin @($s,'S-1-5-18') -or $r.AccessControlType -ne 'Allow' -or (($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)){throw 'Private ACL required'};$seen+=$id};if($s -notin $seen -or 'S-1-5-18' -notin $seen){throw 'Private ACL required'}`;
  await new Promise((done, fail) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, BOOT_ERP_ACL_TARGET: path }, windowsHide: true, shell: false, stdio: 'ignore',
    });
    child.once('error', () => fail(new Error('Preview marker ACL unavailable')));
    child.once('exit', code => code === 0 ? done() : fail(new Error('Private preview marker required')));
  });
}
export async function writePrivateMarker(path, state) {
  validatePreviewState(state);
  const handle = await open(path, 'wx', 0o600);
  try {
    await privateAcl(path, true);
    await handle.writeFile(JSON.stringify(state) + '\n');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(path).catch(() => {}); // Only the file created by this call.
    throw error;
  }
  await handle.close();
}
export async function readPreviewMarker(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2048) throw new Error('Invalid local preview marker');
  await privateAcl(path, false);
  return validatePreviewState(JSON.parse(await readFile(path, 'utf8')));
}
export function samePreview(left, right) {
  return ['instanceId', 'schema', 'expiresAt', 'pid', 'startedAt'].every(key => left[key] === right[key]);
}
export async function requestPreviewStop() {
  const directory = await previewDirectory();
  const state = await readPreviewMarker(join(directory, 'local-preview.json'));
  const request = join(directory, `preview-stop-${state.instanceId}`);
  try { await writePrivateMarker(request, state); }
  catch (error) {
    if (error.code !== 'EEXIST' || !samePreview(await readPreviewMarker(request), state)) throw error;
  }
  // This command never kills a PID or connects to PostgreSQL.
  return { status: 'stop-requested', instanceId: state.instanceId };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await requestPreviewStop())); }
  catch { console.error('Preview stop unavailable; marker missing, changed or not private. No process or database was changed.'); process.exitCode = 1; }
}
