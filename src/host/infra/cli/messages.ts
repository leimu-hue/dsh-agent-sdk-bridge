/**
 * What a user reads when a CLI is missing or unusable — the wording layer.
 *
 * Kept apart from the lookup so the reason a message exists never has to travel
 * with the machinery that detected it: the page's job is to name the CLI to
 * install, not to explain the plugin's environment plumbing. The technical
 * detail stays in the layers below.
 *
 * @module dsh-agent-sdk-bridge/cli/messages
 */

import type { QoderBrand } from '../../core/brand.ts'
import { brandProfile } from '../../core/brand.ts'
import { requiredCliVersion } from './version.ts'

/**
 * The error text for {@link foreignCliOverride}.
 *
 * Deliberately says nothing about the variable or the path that caused it: the
 * page's job here is to tell the user which CLI to install, not to explain the
 * plugin's environment plumbing. The technical reason stays in the lookup.
 */
export function cliConflictMessage(brand: QoderBrand): string {
  const command = brandProfile(brand).cliCommands[0]
  return `未检测到可用的 ${command}，请先安装并登录后再使用此版本。`
}

/**
 * Turn a CLI failure into something a user can act on.
 *
 * The SDK reports an outdated CLI as `Qoder CLI process exited with code 42`,
 * which says nothing about the cause: CLI 1.1.81 removed the worker-session
 * handshake the older SDK spoke, and its own log says so
 * (`sdk_worker_removed: … Upgrade to the latest Qoder SDK version, or roll back
 * the CLI`). The only fix available to a user is reinstalling the pair through
 * the bundled helper, so say that instead of echoing the number.
 *
 * @param detail - the error text as the SDK reported it.
 * @param brand - which edition's helper the message should name.
 * @returns the original detail, prefixed with the actionable explanation.
 */
export function cliFailureText(detail: string, brand: QoderBrand): string {
  // The SDK routes every query through one process-wide daemon pinned to the
  // first launch configuration it saw. When the machine changes under it (a
  // reinstall, a new edition, a different environment) every query is rejected
  // with this message until the process restarts. The plugin now drops the SDK
  // instance at that point, so the next request recovers; say that instead of
  // echoing an English internal error into the page.
  if (/DaemonConfigurationConflict|Global daemon is already initialized with different options/i.test(detail)) {
    const command = brandProfile(brand).cliCommands[0]
    return `本机 ${command} 的运行配置在本次会话期间发生了变化，SDK 的本地守护进程仍按旧配置运行。`
      + `插件已重置这部分运行时，请重试一次；若仍失败，重启 DSH Web。原始信息：${detail}`
  }
  if (!/exit(?:ed)?(?: with)? code 42|sdk_worker_removed/i.test(detail)) return detail
  const profile = brandProfile(brand)
  const pkg = profile.cliPackages[0]
  const spec = pkg === undefined ? profile.cliCommands[0] : `${pkg.scope}/${pkg.name}`
  const required = requiredCliVersion(brand)
  const target = required === undefined ? spec : `${spec}@${required}`
  return `本机 ${profile.cliCommands[0]} 与插件使用的 SDK 版本不匹配（CLI 已移除旧版握手，退出码 42）。`
    + `请在设置页点「一键配置」重新安装配套版本，或手动执行 npm install -g ${target} 后重试。`
    + `原始信息：${detail}`
}
