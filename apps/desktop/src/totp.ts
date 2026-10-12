/** RFC 6238 TOTP implementation without external dependencies. */
import { createHmac } from 'node:crypto'

function base32Decode(encoded: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const input = encoded.toUpperCase().replace(/\s/g, '')
  if (!/^[A-Z2-7]+={0,6}$/.test(input)) throw new Error('Invalid base32 secret')
  const normalized = input.replace(/=+$/, '')
  const bits = normalized.split('').map((c) => {
    const index = alphabet.indexOf(c)
    if (index === -1) throw new Error('Invalid base32 character')
    return index.toString(2).padStart(5, '0')
  }).join('')

  const result: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    result.push(parseInt(bits.slice(i, i + 8), 2))
  }
  if (result.length === 0) throw new Error('Invalid base32 secret')
  return Buffer.from(result)
}

/** RFC 6238 parameters; omitted options use six digits, 30 seconds and SHA1. */
export interface TotpConfig {
  secret: string
  digits?: number
  period?: number
  algorithm?: 'SHA1' | 'SHA256' | 'SHA512'
}

/** @param uri - otpauth TOTP URI. @returns validated key and supplied options; rejects invalid numeric parameters. */
export function parseTotpUri(uri: string): TotpConfig {
  let url: URL
  try { url = new URL(uri) } catch (_error) { throw new Error('Invalid otpauth URI') }
  if (url.protocol !== 'otpauth:' || url.hostname !== 'totp') {
    throw new Error('Invalid otpauth URI')
  }

  const secret = url.searchParams.get('secret')
  if (!secret) throw new Error('Missing secret in otpauth URI')

  const digitsStr = url.searchParams.get('digits')
  const periodStr = url.searchParams.get('period')
  const algorithmStr = url.searchParams.get('algorithm')

  const config: TotpConfig = { secret }
  const integer = (value: string): number => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid TOTP integer')
    return Number(value)
  }
  if (digitsStr !== null) {
    config.digits = integer(digitsStr)
    if (config.digits < 6 || config.digits > 8) throw new Error('Invalid TOTP digits')
  }
  if (periodStr !== null) {
    config.period = integer(periodStr)
    if (config.period <= 0) throw new Error('Invalid TOTP period')
  }
  if (algorithmStr !== null) {
    if (algorithmStr !== 'SHA1' && algorithmStr !== 'SHA256' && algorithmStr !== 'SHA512') throw new Error('Invalid TOTP algorithm')
    config.algorithm = algorithmStr
  }
  base32Decode(secret)
  return config
}

/** @param config - key and TOTP options. @returns current RFC 6238 code; rejects invalid parameters. */
export function generateTotp(config: TotpConfig): string {
  const digits = config.digits ?? 6
  const period = config.period ?? 30
  const algorithm = (config.algorithm ?? 'SHA1').toLowerCase() as 'sha1' | 'sha256' | 'sha512'

  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new Error('Invalid TOTP digits')
  if (!Number.isSafeInteger(period) || period <= 0) throw new Error('Invalid TOTP period')
  const secret = base32Decode(config.secret)
  const counter = Math.floor(Date.now() / 1000 / period)
  const buf = Buffer.alloc(8)
  buf.writeBigInt64BE(BigInt(counter), 0)

  const hmac = createHmac(algorithm, secret)
  hmac.update(buf)
  const hash = hmac.digest()

  const offset = hash.readUInt8(hash.length - 1) & 0x0f
  const code = hash.readUInt32BE(offset) & 0x7fffffff
  const otp = (code % Math.pow(10, digits)).toString().padStart(digits, '0')
  return otp
}
