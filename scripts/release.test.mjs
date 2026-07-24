import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'vitest'
import {
  collectCommits,
  filterCommitsByPackage,
  findPreviousPackageTag,
  parseReleaseTag,
  requireReleaseTag,
  resolvePackageMetadata,
} from './release.mjs'

const temporaryDirectories = []
const releaseScriptPath = fileURLToPath(new URL('./release.mjs', import.meta.url))

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function createTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'pi-packages-release-'))
  temporaryDirectories.push(directory)
  return directory
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function createRepository() {
  const cwd = createTemporaryDirectory()
  git(cwd, ['init', '--initial-branch=main'])
  git(cwd, ['config', 'user.name', 'Release Test'])
  git(cwd, ['config', 'user.email', 'release@example.com'])
  git(cwd, ['config', 'commit.gpgSign', 'false'])
  git(cwd, ['config', 'tag.gpgSign', 'false'])
  return cwd
}

function commit(cwd, subject, body) {
  const args = ['commit', '--allow-empty', '--message', subject]
  if (body) {
    args.push('--message', body)
  }
  git(cwd, args)
  return git(cwd, ['rev-parse', 'HEAD'])
}

function writeManifest(cwd, directoryName, manifest) {
  const packageDirectory = join(cwd, 'packages', directoryName)
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), `${JSON.stringify(manifest)}\n`)
}

describe('release tag parsing', () => {
  it('accepts stable and SemVer prerelease tags', () => {
    assert.deepEqual(parseReleaseTag('package-name-v1.2.3'), {
      packageShortName: 'package-name',
      version: '1.2.3',
      prerelease: undefined,
      npmTag: 'latest',
    })
    assert.equal(parseReleaseTag('package-name-v1.2.3-beta')?.npmTag, 'next')
    assert.equal(parseReleaseTag('package-name-v1.2.3-beta.1')?.version, '1.2.3-beta.1')
    assert.equal(parseReleaseTag('package-name-v1.2.3-rc.2')?.prerelease, 'rc.2')
  })

  it('rejects malformed SemVer and scoped tag names', () => {
    for (const tag of [
      'package-name-v1.2',
      'package-name-v01.2.3',
      'package-name-v1.2.3-01',
      'package-name-v1.2.3-beta..1',
      'package-name-v1.2.3+build.1',
      '@scope/package-name-v1.2.3',
    ]) {
      assert.equal(parseReleaseTag(tag), null, tag)
    }
    assert.throws(() => requireReleaseTag('package-name-v1'), /Invalid release tag/)
  })
})

describe('package metadata validation', () => {
  it('maps a short tag name to a scoped npm package', () => {
    const cwd = createTemporaryDirectory()
    const release = requireReleaseTag('package-name-v1.2.3-beta.1')
    writeManifest(cwd, 'package-name', {
      name: '@scope/package-name',
      version: '1.2.3-beta.1',
    })

    assert.equal(resolvePackageMetadata(cwd, release).packageName, '@scope/package-name')
  })

  it('rejects missing, mismatched, and private packages', () => {
    const cwd = createTemporaryDirectory()
    const release = requireReleaseTag('package-name-v1.2.3')

    assert.throws(() => resolvePackageMetadata(cwd, release), /Unable to read/)

    writeManifest(cwd, 'package-name', {
      name: '@scope/other-package',
      version: '1.2.3',
    })
    assert.throws(() => resolvePackageMetadata(cwd, release), /does not match manifest package/)

    writeManifest(cwd, 'package-name', {
      name: '@scope/package-name',
      version: '1.2.4',
    })
    assert.throws(() => resolvePackageMetadata(cwd, release), /does not match/)

    writeManifest(cwd, 'package-name', {
      name: '@scope/package-name',
      private: true,
      version: '1.2.3',
    })
    assert.throws(() => resolvePackageMetadata(cwd, release), /is private/)
  })
})

describe('package changelog range', () => {
  it('uses the nearest reachable tag for the same package', () => {
    const cwd = createRepository()
    commit(cwd, 'feat(package-a): initial release')
    git(cwd, ['tag', 'package-a-v1.0.0'])
    commit(cwd, 'feat(package-b): initial release')
    git(cwd, ['tag', 'package-b-v1.0.0'])
    commit(cwd, 'fix(package-a): beta release')
    git(cwd, ['tag', 'package-a-v1.1.0-beta.1'])
    commit(cwd, 'fix(package-b): unrelated')
    commit(cwd, 'fix: prepare release', 'package-a is ready')
    git(cwd, ['tag', 'package-a-v1.1.0'])

    assert.equal(findPreviousPackageTag(cwd, 'package-a-v1.1.0', 'package-a'), 'package-a-v1.1.0-beta.1')

    const commits = collectCommits(cwd, 'package-a-v1.1.0-beta.1', 'package-a-v1.1.0')
    assert.deepEqual(
      filterCommitsByPackage(commits, 'package-a').map(entry => entry.message),
      ['fix: prepare release'],
    )
  })

  it('uses all reachable commits for the first package tag', () => {
    const cwd = createRepository()
    commit(cwd, 'chore: initialize repository')
    commit(cwd, 'feat: add package', 'package-c implementation')
    commit(cwd, 'docs: unrelated')
    git(cwd, ['tag', 'package-c-v0.1.0'])

    assert.equal(findPreviousPackageTag(cwd, 'package-c-v0.1.0', 'package-c'), undefined)

    const commits = collectCommits(cwd, undefined, 'package-c-v0.1.0')
    assert.deepEqual(
      filterCommitsByPackage(commits, 'package-c').map(entry => entry.message),
      ['feat: add package'],
    )
  })

  it('matches the complete commit message case-sensitively', () => {
    const commits = [
      { message: 'fix: package-a subject', body: '' },
      { message: 'fix: body match', body: 'updates package-a' },
      { message: 'fix: uppercase', body: 'updates PACKAGE-A' },
      { message: 'fix: unrelated', body: '' },
    ]

    assert.deepEqual(
      filterCommitsByPackage(commits, 'package-a').map(entry => entry.message),
      ['fix: package-a subject', 'fix: body match'],
    )
  })
})

describe('release preparation', () => {
  it('writes the selected scoped package and npm tag to GitHub outputs', () => {
    const cwd = createRepository()
    const runnerTemp = join(cwd, 'runner-temp')
    const outputPath = join(cwd, 'github-output')
    mkdirSync(runnerTemp)
    writeManifest(cwd, 'package-a', {
      name: '@scope/package-a',
      version: '1.0.0',
    })
    commit(cwd, 'chore: initialize repository')
    git(cwd, ['tag', 'package-a-v1.0.0'])

    execFileSync(process.execPath, [releaseScriptPath, 'prepare'], {
      cwd,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: 'scope/repository',
        GITHUB_TOKEN: 'test-token',
        RELEASE_TAG: 'package-a-v1.0.0',
        RUNNER_TEMP: runnerTemp,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const outputs = Object.fromEntries(
      readFileSync(outputPath, 'utf8')
        .trim()
        .split('\n')
        .map(line => {
          const separator = line.indexOf('=')
          return [line.slice(0, separator), line.slice(separator + 1)]
        }),
    )
    assert.equal(outputs.package_name, '@scope/package-a')
    assert.equal(outputs.npm_tag, 'latest')
    assert.equal(outputs.version, '1.0.0')
    assert.match(readFileSync(outputs.release_notes_path, 'utf8'), /No significant changes/)
  })
})
