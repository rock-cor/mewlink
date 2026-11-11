import { blanketStyles, cupStyles, petSkins, workVisuals, type EncryptedEnvelope, type PlainEvent } from '../domain/types';
import { validOperationBatch } from '../history/operations';
import { MAX_UTC_OFFSET_MINUTES } from '../platform/clock';

type Sodium = typeof import('libsodium-wrappers-sumo').default;
let sodiumPromise: Promise<Sodium> | undefined;
const readySodium = () => sodiumPromise ??= import('libsodium-wrappers-sumo').then(async module => {
  await module.default.ready;
  return module.default;
});
const b64 = (sodium: Sodium, bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
const unb64 = (sodium: Sodium, value: string) => sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
const aad = (e: Omit<EncryptedEnvelope, 'nonce' | 'ciphertext'>) => new TextEncoder().encode(JSON.stringify(e));

export async function newDemoKey(): Promise<Uint8Array> { const sodium = await readySodium(); return sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES); }
export async function encodeSecret(bytes: Uint8Array): Promise<string> { return b64(await readySodium(), bytes); }
export async function decodeSecret(value: string): Promise<Uint8Array> { return unb64(await readySodium(), value); }

/** A sender's clock may run ahead of this one, but an event dated later than this is refused. */
export const MAX_CLOCK_AHEAD_MS = 24 * 3_600_000;
/** An instant exactly as `toISOString` writes it: stored events are ordered and pruned by this text. */
const canonicalInstant = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
};
const oneOf = (list: readonly string[], value: unknown) => value === undefined || (typeof value === 'string' && list.includes(value));

/**
 * Whether a decrypted event is well formed. Everything in it is the other
 * person's to choose, so each field the app acts on is checked here: a date
 * that sorts and is not far in the future (or the event would never be
 * pruned), a real time zone, and only names the app knows.
 */
export function isPlainEvent(value: unknown, now = Date.now()): value is PlainEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  if (event.version !== 1 || typeof event.id !== 'string' || event.id.length > 80
    || typeof event.relationshipId !== 'string' || typeof event.senderDeviceId !== 'string'
    || !canonicalInstant(event.createdAt) || Date.parse(event.createdAt) > now + MAX_CLOCK_AHEAD_MS
    || typeof event.payload !== 'object' || !event.payload) return false;
  const offset = event.senderUtcOffsetMinutes;
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isFinite(offset) || Math.abs(offset) > MAX_UTC_OFFSET_MINUTES)) return false;
  const payload = event.payload as Record<string, unknown>;
  if (event.kind === 'operation.batch') return validOperationBatch(payload) && event.createdAt === payload.startedAt;
  if (event.kind === 'cup.consumed') return typeof payload.cupEventId === 'string' && payload.cupEventId.length > 0 && payload.cupEventId.length <= 80;
  if (event.kind === 'interaction') {
    // The styles pick artwork by name: only the app's own names.
    return (payload.action === 'water' || payload.action === 'hug')
      && oneOf(cupStyles, payload.cupStyle) && oneOf(blanketStyles, payload.blanketStyle);
  }
  if (event.kind === 'activity.segment') {
    return typeof payload.category === 'string'
      && ['work', 'meeting', 'leisure', 'idle', 'rest', 'coding', 'reading', 'video', 'browsing'].includes(payload.category)
      && typeof payload.startedAt === 'string'
      && typeof payload.endedAt === 'string'
      && Number.isFinite(Date.parse(payload.startedAt))
      && Number.isFinite(Date.parse(payload.endedAt))
      && (payload.workVisual === undefined || workVisuals.includes(payload.workVisual as (typeof workVisuals)[number]));
  }
  if (event.kind === 'profile.skin') return petSkins.includes(payload.skin as (typeof petSkins)[number]);
  if (event.kind !== 'statistics.snapshot'
    || (payload.visibility !== 'private' && payload.visibility !== 'partner')
    || typeof payload.generatedAt !== 'string') return false;
  if (payload.visibility === 'private') return payload.snapshots === undefined;
  if (!payload.snapshots || typeof payload.snapshots !== 'object') return false;
  const snapshots = payload.snapshots as Record<string, unknown>;
  return isStatisticsSnapshot(snapshots.day, 6)
    && isStatisticsSnapshot(snapshots.week, 7)
    && isStatisticsSnapshot(snapshots.month, 5);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000;
}

function isNumberRecord(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return keys.every(key => isNonNegativeNumber(record[key]));
}

function isStatisticsSnapshot(value: unknown, expectedBars: number): boolean {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Record<string, unknown>;
  const workVisual = snapshot.workVisual as Record<string, unknown> | undefined;
  if (!isNumberRecord(snapshot.input, ['keyboard', 'pointer'])
    || !isNumberRecord(workVisual, ['code', 'document', 'web'])
    || (workVisual?.ai !== undefined && !isNonNegativeNumber(workVisual.ai))
    || (workVisual?.mewlink !== undefined && !isNonNegativeNumber(workVisual.mewlink))
    || !isNumberRecord(snapshot.activity, ['work', 'meeting', 'idle'])
    || (snapshot.pomodoros !== undefined && !isNonNegativeNumber(snapshot.pomodoros))
    || !Array.isArray(snapshot.bars)
    || snapshot.bars.length !== expectedBars) return false;
  return snapshot.bars.every(bar => {
    if (!bar || typeof bar !== 'object') return false;
    const item = bar as Record<string, unknown>;
    return typeof item.label === 'string'
      && item.label.length <= 20
      && isNonNegativeNumber(item.keyboard)
      && isNonNegativeNumber(item.pointer);
  });
}

export async function encryptEvent(event: PlainEvent, recipientDeviceId: string, sequence: number, key: Uint8Array, keyId = 'demo-session'): Promise<EncryptedEnvelope> {
  const sodium = await readySodium();
  const header = { protocolVersion: 1 as const, relationshipId: event.relationshipId, senderDeviceId: event.senderDeviceId, recipientDeviceId, keyId, sequence };
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(event));
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad(header), null, nonce, key);
  return { ...header, nonce: b64(sodium, nonce), ciphertext: b64(sodium, ciphertext) };
}
export async function decryptEvent(envelope: EncryptedEnvelope, key: Uint8Array): Promise<PlainEvent> {
  if (envelope.protocolVersion !== 1) throw new Error('unsupported protocol');
  const sodium = await readySodium();
  const { nonce, ciphertext, ...header } = envelope;
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, unb64(sodium, ciphertext), aad(header), unb64(sodium, nonce), key);
  const event: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (!isPlainEvent(event) || event.relationshipId !== envelope.relationshipId || event.senderDeviceId !== envelope.senderDeviceId) {
    throw new Error('encrypted event metadata mismatch');
  }
  return event;
}
