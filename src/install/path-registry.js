// Reads/writes only the saved per-user PATH value in
// HKCU\Environment\Path. The PATH value is passed to PowerShell through the
// process environment, never through a command line, and is read with
// DoNotExpandEnvironmentNames so %VAR% entries stay literal.
export const PATH_VALUE_ENV = 'METAVEIL_USER_PATH_VALUE';
export const PATH_KIND_ENV = 'METAVEIL_USER_PATH_KIND';
export const DEFAULT_PATH_KIND = 'ExpandString';

const READ_USER_PATH_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$false)",
  "$value=''",
  "$kind='ExpandString'",
  "if($null -ne $key){",
  "  $raw=$key.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "  if($null -ne $raw){$value=[string]$raw}",
  "  try{$kind=$key.GetValueKind('Path').ToString()}catch{$kind='ExpandString'}",
  "  $key.Close()",
  "}",
  "@{value=$value;kind=$kind} | ConvertTo-Json -Compress",
].join('\n');

const WRITE_USER_PATH_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  `$value=[Environment]::GetEnvironmentVariable('${PATH_VALUE_ENV}','Process')`,
  "if($null -eq $value){$value=''}",
  `$kindName=[Environment]::GetEnvironmentVariable('${PATH_KIND_ENV}','Process')`,
  "if([string]::IsNullOrWhiteSpace($kindName)){$kindName='ExpandString'}",
  "$kind=[Microsoft.Win32.RegistryValueKind]::$kindName",
  "$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)",
  "if($null -eq $key){$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')}",
  "$key.SetValue('Path',[string]$value,$kind)",
  "$key.Close()",
  "Add-Type -Namespace MetaveilRegistry -Name Native -MemberDefinition '[DllImport(\"user32.dll\", CharSet=CharSet.Auto, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'",
  "$result=[UIntPtr]::Zero",
  "[void][MetaveilRegistry.Native]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)",
].join('\n');

function resultText(result) {
  if (!result) return '';
  return String(result.stdout == null ? '' : result.stdout);
}

function failure(result) {
  const detail = result && (result.stderr || result.stdout);
  return detail ? `: ${String(detail).trim().slice(0, 300)}` : '';
}

export function readSavedUserPath({ runCommand }) {
  if (typeof runCommand !== 'function') throw new Error('runCommand is required');
  const result = runCommand('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', READ_USER_PATH_SCRIPT,
  ], { windowsHide: true });
  if (!result || result.code !== 0) {
    throw new Error(`could not read saved user PATH${failure(result)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(resultText(result));
  } catch {
    throw new Error('could not parse saved user PATH response');
  }
  const value = typeof parsed?.value === 'string' ? parsed.value : '';
  const kind = typeof parsed?.kind === 'string' && /^[A-Za-z]+$/.test(parsed.kind)
    ? parsed.kind
    : DEFAULT_PATH_KIND;
  return { value, kind };
}

export function writeSavedUserPath({ value, kind = DEFAULT_PATH_KIND }, { runCommand } = {}) {
  if (typeof runCommand !== 'function') throw new Error('runCommand is required');
  const rawValue = String(value == null ? '' : value);
  const rawKind = typeof kind === 'string' && /^[A-Za-z]+$/.test(kind) ? kind : DEFAULT_PATH_KIND;
  const env = {
    ...process.env,
    [PATH_VALUE_ENV]: rawValue,
    [PATH_KIND_ENV]: rawKind,
  };
  const result = runCommand('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', WRITE_USER_PATH_SCRIPT,
  ], { windowsHide: true, env });
  if (!result || result.code !== 0) {
    throw new Error(`could not update saved user PATH${failure(result)}`);
  }
  return { value: rawValue, kind: rawKind };
}

export function splitSavedPath(value) {
  return String(value == null ? '' : value).split(';');
}

export function pathEntryEquals(entry, target) {
  const key = (value) => String(value == null ? '' : value).trim().replace(/[\\/]+$/, '').toLowerCase();
  const left = key(entry);
  return left.length > 0 && left === key(target);
}

export function removePathEntry(currentValue, binDir) {
  const target = String(binDir || '').toLowerCase();
  if (!target) return { value: String(currentValue || ''), removed: false };
  const entries = splitSavedPath(currentValue);
  const index = entries.findIndex((entry) => pathEntryEquals(entry, binDir));
  if (index === -1) return { value: String(currentValue || ''), removed: false };
  entries.splice(index, 1);
  return { value: entries.join(';'), removed: true };
}

export const __scriptsForTests = {
  READ_USER_PATH_SCRIPT,
  WRITE_USER_PATH_SCRIPT,
};
