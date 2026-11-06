import os from 'node:os';
import path from 'node:path';

export const DEFAULT_API_KEY_COMMAND = Object.freeze([
  'pi', 'auth', 'print-api-key', '--provider', 'openrouter',
]);

export function metaveilHome(env = process.env) {
  if (env.METAVEIL_HOME && env.METAVEIL_HOME.trim()) return path.resolve(env.METAVEIL_HOME);
  if (env.LOCALAPPDATA && env.LOCALAPPDATA.trim()) return path.join(env.LOCALAPPDATA, 'metaveil');
  return path.join(os.homedir(), '.metaveil');
}

export function userHome(env = process.env) {
  if (env.METAVEIL_USER_HOME && env.METAVEIL_USER_HOME.trim()) return path.resolve(env.METAVEIL_USER_HOME);
  if (env.USERPROFILE && env.USERPROFILE.trim()) return path.resolve(env.USERPROFILE);
  return os.homedir();
}

export function museSettingsPath(homeDir) {
  return path.join(homeDir, '.config', 'muse', 'settings.json');
}

export function realMuseCmd(env = process.env) {
  if (env.METAVEIL_MUSE_REAL && env.METAVEIL_MUSE_REAL.trim()) return path.resolve(env.METAVEIL_MUSE_REAL);
  const local = env.LOCALAPPDATA || path.join(userHome(env), 'AppData', 'Local');
  return path.join(local, 'Programs', 'muse', 'muse.cmd');
}

export function launcherConfigPath(home = metaveilHome()) {
  return path.join(home, 'launcher.json');
}

export function installStatePath(home = metaveilHome()) {
  return path.join(home, 'install-state.json');
}

export function aclStatePath(home = metaveilHome()) {
  return path.join(home, 'acl-state.json');
}

export function hookConfigPath(home = metaveilHome()) {
  return path.join(home, 'hook', 'hook-policy.json');
}

export function installedHookPath(home = metaveilHome()) {
  return path.join(home, 'hook', 'policy.cjs');
}

export function contributorMarkerPath(home = metaveilHome()) {
  return path.join(home, 'contributor-leak-test.ok');
}
