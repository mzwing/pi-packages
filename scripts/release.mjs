import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { generateMarkdown, parseCommits, resolveAuthors, resolveConfig, sendRelease } from 'changelogithub'

const RELEASE_TAG_PATTERN =
  /^(?<packageShortName>[a-z0-9][a-z0-9._-]*)-v(?<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)$/
const NUMERIC_IDENTIFIER_PATTERN = /^\d+$/

export function parseReleaseTag(tag) {
  const match = RELEASE_TAG_PATTERN.exec(tag)
  if (!match?.groups) {
    return null
  }

  const prereleaseIdentifiers = match.groups.prerelease?.split('.') ?? []
  if (
    prereleaseIdentifiers.some(
      identifier => NUMERIC_IDENTIFIER_PATTERN.test(identifier) && identifier.length > 1 && identifier.startsWith('0'),
    )
  ) {
    return null
  }

  return {
    packageShortName: match.groups.packageShortName,
    version: match.groups.version,
    prerelease: match.groups.prerelease,
    npmTag: match.groups.prerelease ? 'next' : 'latest',
  }
}

export function requireReleaseTag(tag) {
  const parsed = parseReleaseTag(tag)
  if (!parsed) {
    throw new Error(`Invalid release tag "${tag}". Expected <package>-vX.Y.Z or <package>-vX.Y.Z-prerelease.`)
  }
  return parsed
}

export function resolvePackageMetadata(cwd, release) {
  const packageDirectory = resolve(cwd, 'packages', release.packageShortName)
  const manifestPath = resolve(packageDirectory, 'package.json')
  let manifest

  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read ${manifestPath}: ${error.message}`, {
      cause: error,
    })
  }

  if (manifest.private === true) {
    throw new Error(`Package "${release.packageShortName}" is private and cannot be published.`)
  }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error(`${manifestPath} must define a package name.`)
  }

  const manifestShortName = manifest.name.split('/').at(-1)
  if (manifestShortName !== release.packageShortName) {
    throw new Error(`Tag package "${release.packageShortName}" does not match manifest package "${manifest.name}".`)
  }
  if (manifest.version !== release.version) {
    throw new Error(`Tag version "${release.version}" does not match ${manifest.name} version "${manifest.version}".`)
  }

  return {
    packageDirectory,
    packageName: manifest.name,
  }
}

function runGit(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'pipe'],
    }).trim()
  } catch (error) {
    if (allowFailure) {
      return ''
    }
    throw error
  }
}

export function findPreviousPackageTag(cwd, currentTag, packageShortName) {
  let ref = `${currentTag}^`

  while (true) {
    const candidate = runGit(cwd, ['describe', '--tags', '--abbrev=0', '--match', `${packageShortName}-v*`, ref], {
      allowFailure: true,
    })
    if (!candidate) {
      return undefined
    }

    const parsed = parseReleaseTag(candidate)
    if (parsed?.packageShortName === packageShortName) {
      return candidate
    }
    ref = `${candidate}^`
  }
}

function readCommit(cwd, hash) {
  const output = execFileSync('git', ['show', '--no-patch', '--format=%s%x00%b%x00%h%x00%an%x00%ae', hash], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const [message, body, shortHash, authorName, authorEmail] = output.split('\0')

  return {
    message,
    body,
    shortHash,
    author: {
      name: authorName,
      email: authorEmail.trimEnd(),
    },
  }
}

export function collectCommits(cwd, from, to) {
  const range = from ? `${from}..${to}` : to
  const output = runGit(cwd, ['rev-list', range])
  if (!output) {
    return []
  }
  return output.split('\n').map(hash => readCommit(cwd, hash))
}

export function filterCommitsByPackage(commits, packageShortName) {
  return commits.filter(commit => commit.message.includes(packageShortName) || commit.body.includes(packageShortName))
}

function getFirstCommit(cwd, ref) {
  const roots = runGit(cwd, ['rev-list', '--max-parents=0', ref]).split('\n')
  return roots[0]
}

function resolveReleaseContext(cwd, tag) {
  const release = requireReleaseTag(tag)
  runGit(cwd, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`])
  const packageMetadata = resolvePackageMetadata(cwd, release)
  const previousTag = findPreviousPackageTag(cwd, tag, release.packageShortName)
  const compareFrom = previousTag ?? getFirstCommit(cwd, tag)
  const commits = collectCommits(cwd, previousTag, tag)

  return {
    ...release,
    ...packageMetadata,
    compareFrom,
    commits: filterCommitsByPackage(commits, release.packageShortName),
    previousTag,
    tag,
  }
}

async function getChangelogConfig(context, repository, token) {
  return resolveConfig({
    from: context.compareFrom,
    name: context.tag,
    prerelease: Boolean(context.prerelease),
    releaseRepo: repository,
    repo: repository,
    tag: `${context.packageShortName}-v%s`,
    to: context.tag,
    token,
  })
}

function requireEnvironment(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required.`)
  }
  return value
}

function writeStepOutputs(path, outputs) {
  for (const [name, value] of Object.entries(outputs)) {
    const stringValue = value ?? ''
    if (stringValue.includes('\n')) {
      throw new Error(`GitHub Actions output "${name}" contains a newline.`)
    }
    appendFileSync(path, `${name}=${stringValue}\n`)
  }
}

async function prepareRelease() {
  const cwd = process.cwd()
  const tag = requireEnvironment('RELEASE_TAG')
  const repository = requireEnvironment('GITHUB_REPOSITORY')
  const token = requireEnvironment('GITHUB_TOKEN')
  const outputPath = requireEnvironment('GITHUB_OUTPUT')
  const context = resolveReleaseContext(cwd, tag)
  const config = await getChangelogConfig(context, repository, token)
  const commits = parseCommits(context.commits, config)

  if (config.contributors) {
    await resolveAuthors(commits, config)
  }

  const releaseNotesPath = resolve(process.env.RUNNER_TEMP ?? tmpdir(), 'release-notes.md')
  writeFileSync(releaseNotesPath, `${generateMarkdown(commits, config)}\n`)
  writeStepOutputs(outputPath, {
    npm_tag: context.npmTag,
    package_name: context.packageName,
    previous_tag: context.previousTag,
    release_notes_path: releaseNotesPath,
    version: context.version,
  })
}

async function publishGitHubRelease() {
  const cwd = process.cwd()
  const tag = requireEnvironment('RELEASE_TAG')
  const repository = requireEnvironment('GITHUB_REPOSITORY')
  const token = requireEnvironment('GITHUB_TOKEN')
  const releaseNotesPath = requireEnvironment('RELEASE_NOTES_PATH')
  const context = resolveReleaseContext(cwd, tag)
  const config = await getChangelogConfig(context, repository, token)
  const content = readFileSync(releaseNotesPath, 'utf8')

  await sendRelease(config, content)
}

async function main() {
  switch (process.argv[2]) {
    case 'prepare':
      await prepareRelease()
      break
    case 'github':
      await publishGitHubRelease()
      break
    default:
      throw new Error('Expected command "prepare" or "github".')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
