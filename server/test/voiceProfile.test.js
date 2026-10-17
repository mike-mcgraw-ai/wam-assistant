import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { VoiceProfileStore } from '../src/voiceProfile.js'
import { unverifiedVoiceAssessment } from '../src/voiceIdentity.js'
import { wavFromPcm } from '../src/stt.js'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wam-voice-test-'))
  const source = join(directory, 'selected.wav')
  const samples = Buffer.alloc(16_000 * 2 * 4)
  for (let offset = 0; offset < samples.length; offset += 2) {
    samples.writeInt16LE(Math.round(2_000 * Math.sin(offset / 24)), offset)
  }
  writeFileSync(source, wavFromPcm(samples))
  return { directory, source, root: join(directory, 'voice-profile') }
}

const consent = { selected: true, mike: true, clean: true, consent: true }

test('device self direction never becomes verified Mike identity', () => {
  const assessment = unverifiedVoiceAssessment({ id: 'raw-1', speaker: 'me', speakerRole: 'self' })
  assert.equal(assessment.identity, 'uncertain')
  assert.equal(assessment.similarity.mike, null)
  assert.equal(assessment.confidence, null)
  assert.deepEqual(assessment.sourceSegmentIds, ['raw-1'])
})

test('only a deliberately selected, confirmed clean Mike clip can be staged', () => {
  const { directory, source, root } = fixture()
  try {
    const profile = new VoiceProfileStore(root)
    assert.throws(() => profile.stageClip(source, { speakerRole: 'self' }), /confirmations/)
    assert.equal(existsSync(root), false)
    const staged = profile.stageClip(source, consent)
    assert.equal(staged.verificationReady, false)
    assert.equal(profile.status().model, null)
    assert.equal(profile.status().stagedClipCount, 1)
    assert.equal(statSync(root).mode & 0o077, 0)
    assert.equal(statSync(join(root, `${staged.id}.wav`)).mode & 0o077, 0)
    assert.deepEqual(readFileSync(join(root, `${staged.id}.wav`)), readFileSync(source))
    assert.throws(() => profile.stageClip(source, consent), /already staged/)
    profile.removeClip(staged.id)
    assert.equal(profile.status().stagedClipCount, 0)
    assert.equal(existsSync(join(root, `${staged.id}.wav`)), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reset deletes staged audio; invalid and silent files never enter the profile', () => {
  const { directory, source, root } = fixture()
  try {
    const profile = new VoiceProfileStore(root)
    const staged = profile.stageClip(source, consent)
    const silent = join(directory, 'silent.wav')
    writeFileSync(silent, wavFromPcm(Buffer.alloc(16_000 * 2 * 4)))
    assert.throws(() => profile.stageClip(silent, consent), /silent/)
    assert.throws(() => profile.removeClip('../other'), /invalid clip id/)
    profile.reset()
    assert.equal(existsSync(root), false)
    assert.equal(existsSync(join(root, `${staged.id}.wav`)), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reset handles an interrupted stage but refuses unrelated files', () => {
  const { directory, source, root } = fixture()
  try {
    const profile = new VoiceProfileStore(root)
    profile.stageClip(source, consent)
    const interrupted = join(root, '12345678-1234-1234-1234-123456789abc.wav')
    writeFileSync(interrupted, Buffer.from('partial'), { mode: 0o600 })
    const unrelated = join(root, 'other.txt')
    writeFileSync(unrelated, 'leave me alone', { mode: 0o600 })
    assert.throws(() => profile.reset(), /unexpected/)
    assert.equal(existsSync(unrelated), true)
    rmSync(unrelated)
    profile.reset()
    assert.equal(existsSync(root), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
