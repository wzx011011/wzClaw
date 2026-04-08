import { describe, it, expect, vi } from 'vitest'
import { generateQRCode } from '../qr-generator'

// Mock qrcode
vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,fakeQRbase64')
  }
}))

describe('generateQRCode', () => {
  it('returns base64 data URL', async () => {
    const result = await generateQRCode('https://example.com?token=abc')

    expect(result).toBe('data:image/png;base64,fakeQRbase64')
  })

  it('passes correct options to QRCode', async () => {
    const QRCode = (await import('qrcode')).default
    await generateQRCode('https://test.com')

    expect(QRCode.toDataURL).toHaveBeenCalledWith('https://test.com', {
      width: 256,
      margin: 2,
      color: {
        dark: '#ffffffFF',
        light: '#00000000'
      }
    })
  })
})
