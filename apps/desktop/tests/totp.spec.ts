import { describe, expect, it, vi } from 'vitest'
import { generateTotp, parseTotpUri } from '../src/totp.ts'

describe('TOTP', () => {
  describe('cryptographic operations', () => {
    const secret = 'JBSWY3DPEBLW64TMMQ======'

    it('generates 6 digits by default', () => {
      const otp = generateTotp({ secret })
      expect(otp).toMatch(/^\d{6}$/)
    })

    it('generates 8 digits when requested', () => {
      const otp = generateTotp({ secret, digits: 8 })
      expect(otp).toMatch(/^\d{8}$/)
    })

    it('produces deterministic output for fixed time', () => {
      const otp1 = generateTotp({ secret })
      const otp2 = generateTotp({ secret })
      expect(otp1).toBe(otp2)
    })

    it('supports SHA256 algorithm', () => {
      const otp = generateTotp({ secret, algorithm: 'SHA256' })
      expect(otp).toMatch(/^\d{6}$/)
    })

    it('supports SHA512 algorithm', () => {
      const otp = generateTotp({ secret, algorithm: 'SHA512' })
      expect(otp).toMatch(/^\d{6}$/)
    })
  })

  describe('parseTotpUri', () => {
    it('parses basic otpauth URI', () => {
      const uri = 'otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEBLW64TMMQ======&issuer=Example'
      const config = parseTotpUri(uri)

      expect(config.secret).toBe('JBSWY3DPEBLW64TMMQ======')
      expect(config.digits).toBeUndefined()
      expect(config.period).toBeUndefined()
      expect(config.algorithm).toBeUndefined()
    })

    it('parses otpauth URI with all parameters', () => {
      const uri = 'otpauth://totp/test?secret=JBSWY3DPEBLW64TMMQ======&digits=8&period=60&algorithm=SHA256'
      const config = parseTotpUri(uri)

      expect(config.secret).toBe('JBSWY3DPEBLW64TMMQ======')
      expect(config.digits).toBe(8)
      expect(config.period).toBe(60)
      expect(config.algorithm).toBe('SHA256')
    })

    it('rejects invalid otpauth URIs', () => {
      expect(() => parseTotpUri('https://example.com')).toThrow('Invalid otpauth URI')
      expect(() => parseTotpUri('otpauth://hotp/test?secret=JBSWY3DPEBLW64TMMQ======')).toThrow('Invalid otpauth URI')
      expect(() => parseTotpUri('otpauth://totp/test')).toThrow('Missing secret')
    })
  })

})

// RFC 6238 Appendix B uses ASCII keys of 20, 32 and 64 bytes for SHA1, SHA256 and SHA512.
function encodeKey(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bits = [...Buffer.from(value)].map(byte => byte.toString(2).padStart(8, '0')).join('')
  return (bits.match(/.{1,5}/g) ?? []).map(group => alphabet[parseInt(group.padEnd(5, '0'), 2)]).join('')
}

describe('RFC 6238 Appendix B', () => {
  const keys = {
    SHA1: '12345678901234567890',
    SHA256: '12345678901234567890123456789012',
    SHA512: '1234567890123456789012345678901234567890123456789012345678901234',
  }
  const rows = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ] as const
  for (const [time, sha1, sha256, sha512] of rows) {
    it.each([['SHA1', sha1], ['SHA256', sha256], ['SHA512', sha512]] as const)('%s at ' + String(time), (algorithm, expected) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(time * 1000)
      try { expect(generateTotp({ secret: encodeKey(keys[algorithm]), digits: 8, algorithm })).toBe(expected) }
      finally { clock.mockRestore() }
    })
  }
})

describe('TOTP input validation', () => {
  it.each(['digits=5', 'digits=9', 'digits=NaN', 'digits=6x', 'digits=6.5', 'digits=',
    'period=0', 'period=-1', 'period=1.5', 'period=NaN', 'period=30x', 'period=', 'period=9007199254740992', 'algorithm=MD5'])
  ('rejects %s', (option) => {
    expect(() => parseTotpUri(`otpauth://totp/test?secret=JBSWY3DPEHPK3PXP&${option}`)).toThrow()
  })
  it.each([6, 7, 8])('accepts %i digits with a positive integer period', (digits) => {
    expect(parseTotpUri(`otpauth://totp/test?secret=JBSWY3DPEHPK3PXP&digits=${digits}&period=1`).digits).toBe(digits)
  })
  it.each(['', '!@#', 'ABC0DEF'])('rejects invalid base32 %j', (secret) => {
    expect(() => generateTotp({ secret })).toThrow('base32')
  })
})
