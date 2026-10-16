import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { legacySpokenInventory, compareSpokenCoverage } from './spokenWorkImport.js'
import { SpokenWork } from './spokenWork.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sourceFiles = new Set(['coach.json', 'tasks.json', 'assistant.json', 'runs.json'])
const stages = ['snapshots', 'retention', 'links']

function inside(parent, child) {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function requireExternal(path, label, dataDir) {
  if (!isAbsolute(path) || inside(repositoryRoot, path) || inside(dataDir, path)) {
    throw new Error(`${label} must be an absolute path outside the repository and data directory`)
  }
}

function filesUnder(root) {
  const result = []
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`symlink in data directory: ${path}`)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) result.push(relative(root, path))
      else throw new Error(`unsupported data entry: ${path}`)
    }
  }
  visit(root)
  return result.sort()
}

function hashFile(path) {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  const chunk = Buffer.alloc(1024 * 1024)
  try {
    for (let bytes = readSync(fd, chunk, 0, chunk.length, null); bytes; bytes = readSync(fd, chunk, 0, chunk.length, null)) {
      hash.update(chunk.subarray(0, bytes))
    }
  } finally { closeSync(fd) }
  return hash.digest('hex')
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function inventoryHash(root, { normalized = false } = {}) {
  const fileHashes = {}
  for (const file of filesUnder(root)) {
    if (!sourceFiles.has(file) && !file.startsWith(`recordings${sep}`)) continue
    const path = join(root, file)
    if (normalized && file.endsWith(`${sep}manifest.json`)) {
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      delete manifest.kept
      delete manifest.expiresAt
      fileHashes[file] = digest(manifest)
    } else fileHashes[file] = hashFile(path)
  }
  return { files: fileHashes, hash: digest(fileHashes) }
}

function validateLegacySources(root) {
  for (const file of filesUnder(root)) {
    if (sourceFiles.has(file) || file.startsWith(`recordings${sep}`) && file.endsWith('.json')) {
      try { JSON.parse(readFileSync(join(root, file), 'utf8')) }
      catch (error) { throw new Error(`invalid source JSON: ${file}: ${error.message}`) }
    }
    if (file.startsWith(`recordings${sep}`) && file.endsWith('.jsonl')) {
      for (const [index, line] of readFileSync(join(root, file), 'utf8').split('\n').entries()) {
        if (!line.trim()) continue
        try { JSON.parse(line) }
        catch (error) { throw new Error(`invalid source JSONL: ${file}:${index + 1}: ${error.message}`) }
      }
    }
  }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(temp, path)
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }

function assertSame(actual, expected, message) {
  if (actual !== expected) throw new Error(message)
}

export function buildSpokenMigrationManifest(dataDir, now = Date.now()) {
  if (!isAbsolute(dataDir) || !lstatSync(dataDir).isDirectory()) throw new Error('absolute data directory required')
  validateLegacySources(dataDir)
  const source = inventoryHash(dataDir)
  const guard = inventoryHash(dataDir, { normalized: true })
  const inventory = legacySpokenInventory(dataDir, now)
  const entries = inventory.items.map(item => ({ ...item, audio: { ...item.audio,
    state: item.audio?.state || 'missing' } }))
  const id = digest({ source: source.hash, entries, exceptions: inventory.exceptions })
  return { schemaVersion: 1, id, createdAt: now, dataDir, source, guard,
    counts: inventory.counts, exceptions: inventory.exceptions, entries,
    retention: 'manual-purge-only', proposalStatus: 'not_processed' }
}

export function writeSpokenMigrationManifest(dataDir, outputPath, now = Date.now()) {
  requireExternal(outputPath, 'manifest', dataDir)
  if (existsSync(outputPath)) throw new Error('manifest path already exists')
  const manifest = buildSpokenMigrationManifest(dataDir, now)
  atomicJson(outputPath, manifest)
  return manifest
}

export function backupSpokenMigration(dataDir, manifestPath, backupDir) {
  requireExternal(manifestPath, 'manifest', dataDir)
  requireExternal(backupDir, 'backup', dataDir)
  if (existsSync(backupDir)) throw new Error('backup path already exists')
  const manifest = readJson(manifestPath)
  assertSame(resolve(dataDir), resolve(manifest.dataDir), 'manifest belongs to another data directory')
  assertSame(inventoryHash(dataDir).hash, manifest.source.hash, 'legacy source changed since dry run')
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const allFiles = filesUnder(dataDir)
  const hashes = {}
  for (const file of allFiles) {
    const destination = join(backupDir, file)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    copyFileSync(join(dataDir, file), destination)
    hashes[file] = hashFile(join(dataDir, file))
    assertSame(hashFile(destination), hashes[file], `backup mismatch: ${file}`)
  }
  assertSame(inventoryHash(dataDir).hash, manifest.source.hash, 'legacy source changed during backup')
  const report = { schemaVersion: 1, manifestId: manifest.id, dataDir, files: hashes, hash: digest(hashes) }
  atomicJson(join(backupDir, 'backup-report.json'), report)
  return report
}

function verifyBackup(dataDir, manifest, backupDir) {
  requireExternal(backupDir, 'backup', dataDir)
  const report = readJson(join(backupDir, 'backup-report.json'))
  assertSame(report.manifestId, manifest.id, 'backup belongs to another manifest')
  assertSame(resolve(report.dataDir), resolve(dataDir), 'backup belongs to another data directory')
  assertSame(digest(report.files), report.hash, 'backup report is corrupt')
  for (const [file, expected] of Object.entries(report.files)) {
    assertSame(hashFile(join(backupDir, file)), expected, `backup verification failed: ${file}`)
  }
  assertSame(digest(Object.fromEntries(Object.entries(report.files)
    .filter(([file]) => sourceFiles.has(file) || file.startsWith(`recordings${sep}`)))), manifest.source.hash,
  'backup does not match dry-run source')
  return report
}

function inputFrom(entry, stage) {
  const audio = entry.audio?.state === 'available' || entry.audio?.state === 'expiring'
    ? stage === 'snapshots' ? { ...entry.audio, state: 'retention_error', kept: false }
      : { ...entry.audio, state: 'available', kept: true, expiresAt: null }
    : entry.audio
  return {
    id: entry.id, sourceKey: entry.sourceKey, sourceAliases: entry.sourceAliases,
    sourceType: entry.sourceType, modeId: entry.modeId, space: entry.space,
    sessionId: entry.sessionId, sourceRefs: entry.sourceRefs,
    capturedAt: entry.capturedAt, endedAt: entry.endedAt,
    rawText: entry.rawTranscript.text, rawSegments: entry.rawTranscript.segments,
    complete: entry.rawTranscript.complete, transcriptSource: entry.rawTranscript.source,
    audio, cleanedTranscript: entry.cleanedTranscript, title: entry.title,
    summary: entry.summary, classification: entry.classification,
    clarificationQuestions: entry.clarificationQuestions,
    reviewState: stage === 'snapshots' && entry.reviewState === 'reviewed' ? 'unreviewed' : entry.reviewState,
    destinationRefs: stage === 'links' ? entry.destinationRefs : [],
    parentId: entry.parentId, amendmentKind: entry.amendmentKind,
    amendmentBaseRevision: entry.amendmentBaseRevision, ingest: 'migration',
  }
}

function keepRecording(dataDir, entry) {
  if (entry.audio?.state !== 'available' && entry.audio?.state !== 'expiring') return
  const sessionId = entry.audio.sessionId
  if (!sessionId || !/^[a-zA-Z0-9._-]{1,120}$/.test(sessionId)) throw new Error(`invalid recording ID: ${sessionId}`)
  const dir = join(dataDir, 'recordings', sessionId)
  if (!existsSync(join(dir, 'audio.pcm')) || !lstatSync(join(dir, 'audio.pcm')).size) throw new Error(`recording unavailable: ${sessionId}`)
  const path = join(dir, 'manifest.json')
  const manifest = readJson(path)
  if (manifest.kept !== true || manifest.expiresAt !== null) atomicJson(path, { ...manifest, kept: true, expiresAt: null })
  const verified = readJson(path)
  if (verified.kept !== true || verified.expiresAt !== null) throw new Error(`recording not kept: ${sessionId}`)
}

export function applySpokenMigration({ dataDir, manifestPath, backupDir, approveHash, batchSize = 25 }) {
  requireExternal(manifestPath, 'manifest', dataDir)
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('batch size must be 1–500')
  const manifest = readJson(manifestPath)
  assertSame(approveHash, manifest.id, 'explicit manifest hash approval required')
  assertSame(resolve(dataDir), resolve(manifest.dataDir), 'manifest belongs to another data directory')
  assertSame(digest({ source: manifest.source.hash, entries: manifest.entries, exceptions: manifest.exceptions }), manifest.id,
    'manifest contents changed')
  verifyBackup(dataDir, manifest, backupDir)
  assertSame(inventoryHash(dataDir, { normalized: true }).hash, manifest.guard.hash,
    'legacy source changed; run a new dry run before applying')
  const checkpointPath = `${manifestPath}.checkpoint.json`
  const checkpoint = existsSync(checkpointPath) ? readJson(checkpointPath)
    : { manifestId: manifest.id, stage: 'snapshots', index: 0, errors: [] }
  assertSame(checkpoint.manifestId, manifest.id, 'checkpoint belongs to another manifest')
  const store = new SpokenWork({ logPath: join(dataDir, 'spoken-work.jsonl'), indexPath: join(dataDir, 'spoken-work.json') })
  let processed = 0
  while (checkpoint.stage !== 'complete' && processed < batchSize) {
    const entry = manifest.entries[checkpoint.index]
    if (!entry) {
      const next = stages.indexOf(checkpoint.stage) + 1
      checkpoint.stage = stages[next] || 'complete'
      checkpoint.index = 0
      atomicJson(checkpointPath, checkpoint)
      continue
    }
    try {
      if (checkpoint.stage === 'retention') keepRecording(dataDir, entry)
      const result = store.ingest(inputFrom(entry, checkpoint.stage), { actor: 'migration' })
      if (!result.ok) throw new Error(result.error)
      if (checkpoint.stage === 'retention' && (entry.audio?.state === 'available' || entry.audio?.state === 'expiring') &&
        (result.item.audio.state !== 'available' || result.item.audio.kept !== true)) throw new Error('canonical audio not marked kept')
    } catch (error) {
      checkpoint.errors.push({ stage: checkpoint.stage, sourceKey: entry.sourceKey, error: String(error?.message || error) })
      atomicJson(checkpointPath, checkpoint)
      throw error
    }
    checkpoint.index += 1
    processed += 1
    atomicJson(checkpointPath, checkpoint)
  }
  assertSame(inventoryHash(dataDir, { normalized: true }).hash, manifest.guard.hash,
    'legacy source changed during apply')
  const coverage = compareSpokenCoverage({ items: manifest.entries }, store.all())
  return { checkpoint, processed, coverage, canonicalItems: store.all().length }
}

export function assessSpokenRetirement({ coverage, exceptionsReviewed = false, pathsValidated = false,
  migrationAccepted = false, retentionAccepted = false }) {
  const blockers = []
  if (coverage.legacyOnly?.length) blockers.push(`${coverage.legacyOnly.length} legacy sources are not canonical`)
  if (!exceptionsReviewed) blockers.push('migration exceptions require review')
  if (!pathsValidated) blockers.push('capture paths require no-loss validation')
  if (!migrationAccepted) blockers.push('migration requires operator acceptance')
  if (!retentionAccepted) blockers.push('manual-purge retention requires operator acceptance')
  return { ready: blockers.length === 0, blockers }
}
