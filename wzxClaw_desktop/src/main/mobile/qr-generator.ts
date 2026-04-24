import QRCode from 'qrcode'

/**
 * Generate a QR code as a base64 data URL string.
 */
export async function generateQRCode(text: string): Promise<string> {
  return QRCode.toDataURL(text, { width: 256, margin: 2 })
}
