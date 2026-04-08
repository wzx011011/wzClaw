import QRCode from 'qrcode'

/**
 * Generate a QR code as a base64-encoded PNG data URL.
 * The QR code contains the connection URL with auth token.
 */
export async function generateQRCode(url: string): Promise<string> {
  const dataUrl = await QRCode.toDataURL(url, {
    width: 256,
    margin: 2,
    color: {
      dark: '#ffffffFF',
      light: '#00000000'
    }
  })
  return dataUrl
}
