// Image and QR helpers shared by the host and the phone.

// Claude reads images best at ≤1568px on the long edge; bigger only costs
// tokens and transfer time.
const MAX_EDGE = 1568

/** Downscale a photo/File to a JPEG Blob. Respects EXIF orientation. */
export const shrinkPhoto = async (file, maxEdge = MAX_EDGE, quality = 0.85) => {
  const bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'})
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode photo'))), 'image/jpeg', quality))
}

export const blobToBase64 = blob => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).split(',')[1])
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(blob)
})

let qrLib = null
/** Renders `text` as a QR code into an <img> or returns a data URL. */
export const qrDataUrl = async text => {
  qrLib ??= (await import('https://esm.sh/qrcode@1.5.4')).default
  return qrLib.toDataURL(text, {margin: 1, width: 320, errorCorrectionLevel: 'M', color: {dark: '#14161f', light: '#ffffff'}})
}
