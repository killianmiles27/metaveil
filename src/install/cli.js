#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  applyInstall,
  aclApplyFor,
  aclPlanFor,
  aclRemoveFor,
  aclStatusFor,
  contributorSet,
  metaveilHomeFor,
  planInstall,
  uninstall,
} from './index.js';
import { formatCommand } from './acl.js';
import {
  installedHookPath,
  launcherConfigPath,
  museSettingsPath,
  userHome,
} from './paths.js';
import {
  contributorGate,
  fetchProxyHealth,
  loadLauncherConfig,
} from './launcher.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const without = arg.slice(2);
      const eq = without.indexOf('=');
      if (eq !== -1) {
        flags[without.slice(0, eq)] = without.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[without] = next;
          i += 1;
        } else {
          flags[without] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function csv(value) {
  if (!value || value === true) return [];
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function commonOptions(flags) {
  return {
    homeDir: flags.home || userHome(),
    metaveilHome: flags['metaveil-home'],
    workspaceRoot: flags.workspace || flags.ws || process.cwd(),
    port: flags.port ? Number(flags.port) : undefined,
    extras: csv(flags.extras),
    allowedSkills: csv(flags['allowed-skill']),
    bundledSkills: csv(flags['bundled-skill']),
    allowedRoots: csv(flags['allowed-root']),
    currentPath: flags['current-path'],
    museReal: flags['muse-real'],
    identity: typeof flags.identity === 'string' ? flags.identity : undefined,
  };
}

function printAclPlan(plan) {
  for (const entry of plan.entries) {
    if (entry.action === 'deny') process.stdout.write(`deny  ${entry.path}  (${entry.kind}, ${entry.label})\n`);
    else process.stdout.write(`skip  ${entry.path}  (${entry.reason})\n`);
  }
}

function usage() {
  return `metaveil install/uninstall (dry-run by default)

Usage:
  metaveil install [--home <dir>] [--workspace <path>] [--port <n>] [--apply] [--json]
  metaveil uninstall [--home <dir>] [--apply] [--json]
  metaveil acl plan|status|apply|remove [--home <dir>] [--workspace <path>] [--apply] [--json]
  metaveil contributor on|off [--home <dir>] [--apply] [--json]
  metaveil status [--home <dir>] [--metaveil-home <dir>] [--port <n>] [--json]

--home selects the synthetic or real user home. Tests must pass a temp home.
--identity <path> copies an identity JSON file to <metaveil-home>/identity.json.
--apply performs mutations. Without it every command is a dry-run.
`;
}

function readSettingsBaseUrl(homeDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(museSettingsPath(homeDir), 'utf8'));
    return parsed?.endpoint_transport?.base_url || null;
  } catch {
    return null;
  }
}

async function statusReport(options) {
  const homeDir = path.resolve(options.homeDir);
  const metaveil = metaveilHomeFor(homeDir, options.metaveilHome);
  let launcher = null;
  try { launcher = loadLauncherConfig(metaveil); } catch { launcher = null; }
  const port = launcher?.port
    || (Number.isInteger(options.port) && options.port > 0 && options.port < 65536 ? options.port : 8787);
  const health = await fetchProxyHealth(port);
  let acl;
  let gate;
  if (launcher) {
    gate = contributorGate(launcher, { proxyHealthy: health.healthy, jevReady: health.jevReady });
    acl = gate.acl;
  } else {
    acl = aclStatusFor(options);
    gate = { on: false, reasons: ['launcher config is not installed'] };
  }
  const hookPath = launcher?.hookPath || installedHookPath(metaveil);
  const marker = launcher?.contributorMarkerPath || path.join(metaveil, 'contributor-leak-test.ok');
  return {
    metaveilHome: metaveil,
    proxy: { url: `http://127.0.0.1:${port}`, healthy: health.healthy },
    jevReady: health.jevReady,
    hook: { path: hookPath, present: fs.existsSync(hookPath) },
    acl: { ok: acl.ok === true, entries: acl.checked || 0, reason: acl.reason || null },
    settingsBaseUrl: readSettingsBaseUrl(homeDir),
    contributorEnabled: launcher ? launcher.contributor.enabled === true : false,
    markerPresent: fs.existsSync(marker),
    gate: { on: gate.on, reasons: gate.reasons },
    installed: Boolean(launcher),
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage());
    process.exit(command ? 0 : 1);
  }
  const { positional, flags } = parseArgs(rest);
  const subcommand = positional[0];
  const options = commonOptions(flags);
  const apply = flags.apply === true;
  const isRealHome = path.resolve(options.homeDir).toLowerCase() === path.resolve(userHome()).toLowerCase();
  if (apply && isRealHome && flags['allow-real-home'] !== true) {
    throw new Error('refusing --apply against the real user home; pass --home <synthetic dir> for tests or --allow-real-home for an intentional real install');
  }

  if (command === 'status') {
    const report = await statusReport(options);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`metaveil status${report.installed ? '' : ' (not installed)'}\n`);
      process.stdout.write(`proxy: ${report.proxy.healthy ? 'healthy' : 'unhealthy'} (${report.proxy.url})\n`);
      process.stdout.write(`jevReady: ${report.jevReady}\n`);
      process.stdout.write(`hook: ${report.hook.present ? 'present' : 'missing'} (${report.hook.path})\n`);
      process.stdout.write(`acl: ${report.acl.ok ? 'ok' : 'drift'} (${report.acl.entries} entries)${report.acl.reason ? ` (${report.acl.reason})` : ''}\n`);
      process.stdout.write(`settings base_url: ${report.settingsBaseUrl || 'absent'}\n`);
      process.stdout.write(`contributor: ${report.contributorEnabled ? 'enabled' : 'disabled'}\n`);
      process.stdout.write(`marker: ${report.markerPresent ? 'present' : 'missing'}\n`);
      process.stdout.write(`gate: ${report.gate.on ? 'on' : 'off'}${report.gate.reasons.length ? ` (${report.gate.reasons.join('; ')})` : ''}\n`);
    }
    return;
  }

  if (command === 'install') {
    const plan = planInstall(options);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ dryRun: !apply, plan }, null, 2)}\n`);
    } else {
      process.stdout.write(`metaveil install (${apply ? 'APPLY' : 'dry-run'})\n`);
      process.stdout.write(`home: ${plan.homeDir}\nsettings: ${plan.settingsPath}\n`);
      process.stdout.write(`--- settings diff ---\n${plan.settingsDiff}\n`);
      process.stdout.write(`PATH: prepend ${plan.pathPlan.binDir}\n`);
      process.stdout.write('ACL plan:\n');
      printAclPlan(plan.aclPlan);
    }
    if (!apply) return;
    const result = applyInstall(plan, { applyAcl: true, applyPath: true });
    if (!flags.json) {
      process.stdout.write(`\napplied: settings backup ${result.backupPath || '(none)'}\n`);
      process.stdout.write(`acl: ${result.acl.applied.length} applied, ${result.acl.alreadyApplied.length} already applied, ${result.acl.errors.length} errors\n`);
      process.stdout.write(`path: ${result.path.applied ? 'updated' : (result.path.synthetic ? 'synthetic home; plan written only' : 'unchanged')}\n`);
    }
    return;
  }

  if (command === 'uninstall') {
    if (!apply) {
      const statePath = path.join(planInstall(options).metaveilHome, 'install-state.json');
      process.stdout.write(`metaveil uninstall (dry-run)\nwould reverse settings, hook, PATH and ACL state from ${statePath}\n`);
      return;
    }
    const result = uninstall(options, { applyAcl: true, applyPath: true });
    if (result.acl.errors.length > 0) {
      const commands = result.acl.errors.map((e) => `  icacls "${e.path}" /remove:d MuseSandboxUsers`).join('\n');
      process.stderr.write(`metaveil: ${result.acl.errors.length} permission blocks could not be removed. Blocks on drive roots need an Administrator terminal:\n${commands}\n`);
    }
    if (!flags.json) {
      process.stdout.write(`removed ${result.acl.removed.length} ACL entries\n`);
      if (result.remaining.length === 0) process.stdout.write('retained: none\n');
      else for (const file of result.remaining) process.stdout.write(`retained: ${file}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ removed: result.acl.removed.length, path: result.path, remaining: result.remaining }, null, 2)}\n`);
    }
    return;
  }

  if (command === 'acl') {
    if (subcommand === 'plan') {
      const plan = aclPlanFor(options);
      if (flags.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      else printAclPlan(plan);
      return;
    }
    if (subcommand === 'status') {
      const status = aclStatusFor(options);
      if (flags.json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      else {
        process.stdout.write(`acl status: ${status.ok ? 'clean' : 'drift'} (${status.checked} checked)\n`);
        for (const item of status.drift) process.stdout.write(`drift: ${item.path} (${item.reason})\n`);
      }
      return;
    }
    if (subcommand === 'apply') {
      const plan = aclPlanFor(options);
      const result = aclApplyFor(plan, { ...options, dryRun: !apply });
      if (flags.json) process.stdout.write(`${JSON.stringify({ dryRun: !apply, result }, null, 2)}\n`);
      else {
        process.stdout.write(`acl apply (${apply ? 'APPLY' : 'dry-run'})\n`);
        for (const spec of result.commands) process.stdout.write(`${formatCommand(spec)}\n`);
      }
      return;
    }
    if (subcommand === 'remove') {
      const result = aclRemoveFor({ ...options, dryRun: !apply });
      if (flags.json) process.stdout.write(`${JSON.stringify({ dryRun: !apply, result }, null, 2)}\n`);
      else {
        process.stdout.write(`acl remove (${apply ? 'APPLY' : 'dry-run'})\n`);
        for (const spec of result.commands) process.stdout.write(`${formatCommand(spec)}\n`);
      }
      return;
    }
    throw new Error(`unknown acl subcommand: ${subcommand || '(missing)'}`);
  }

  if (command === 'contributor') {
    if (subcommand !== 'on' && subcommand !== 'off') throw new Error('contributor requires on|off');
    const enabled = subcommand === 'on';
    if (!apply) {
      process.stdout.write(`metaveil contributor ${subcommand} (dry-run; pass --apply to write)\n`);
      return;
    }
    const config = contributorSet(options, enabled);
    if (flags.json) process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    else process.stdout.write(`contributor.enabled=${config.contributor.enabled}\n`);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`metaveil: ${error && error.message ? error.message : String(error)}\n`);
  process.exit(1);
});
