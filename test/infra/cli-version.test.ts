/**
 * The build number the settings page shows, and where it is read from.
 *
 * The page compares this to the SDK's pin before the user signs in, so it has
 * to be readable for an install that ships no package manifest at all — and it
 * has to stay quiet when there is nothing to read, because callers treat
 * "unknown" as "say nothing", never as a mismatch.
 */
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { installedCliVersion } from '../../src/infra/cli.ts'
import { EXE, QODER_CLI_HOME, machine } from '../helpers/cli-machine.ts'

describe('installed CLI version', () => {
  const exe = path.join(QODER_CLI_HOME, '.qoder', 'bin', 'qodercli', `qodercli${EXE}`)
  const versionFile = path.join(path.dirname(exe), 'version.txt')

  it('reads the version an installer-managed build records beside it', () => {
    const lookup = machine([exe], {
      readFile: file => {
        if (path.normalize(file) !== path.normalize(versionFile)) throw new Error('ENOENT')
        return '1.1.37\n'
      },
    })
    expect(installedCliVersion('global', lookup)).toBe('1.1.37')
  })

  it('answers nothing when the build records no usable version', () => {
    const silent = (): string => {
      throw new Error('ENOENT')
    }
    expect(installedCliVersion('global', machine([exe], { readFile: silent }))).toBeUndefined()
    // A file that is not a version is not worth guessing at either: callers
    // read "unknown" as "say nothing", never as a mismatch.
    expect(installedCliVersion('global', machine([exe], { readFile: () => 'unknown\n' }))).toBeUndefined()
  })
})
