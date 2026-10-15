// Persist images once per file; runtime quotations keep their original data URLs.
// These helpers only transform the wire format. Business validation stays in quotation-json.mjs.
const imageIdPattern = /^image-[1-9]\d*$/
const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)

export function decodeQuotationEnvelope(value) {
  if (!isRecord(value)) throw new Error('Quotation envelope must be an object.')
  if (value.schemaVersion !== undefined && ![1, 2, 3, 4].includes(value.schemaVersion)) throw new Error('Unsupported quotation schemaVersion.')
  if (value.schemaVersion !== 4) return structuredClone(value)
  if (!isRecord(value.images)) throw new Error('images must be an object for schemaVersion 4.')
  for (const [id, dataUrl] of Object.entries(value.images)) {
    if (!imageIdPattern.test(id)) throw new Error(`images.${id}: invalid image ID.`)
    if (typeof dataUrl !== 'string' || dataUrl.length === 0) throw new Error(`images.${id} must be a non-empty data URL string.`)
  }
  const expanded = structuredClone(value)
  const expandBranding = (quotation, path) => {
    if (!isRecord(quotation?.branding)) throw new Error(`${path}.branding must be an object.`)
    const branding = quotation.branding
    if (Object.hasOwn(branding, 'logoDataUrl')) throw new Error(`${path}.branding.logoDataUrl is not allowed in schemaVersion 4; use logoImageId.`)
    if (!Object.hasOwn(branding, 'logoImageId')) throw new Error(`${path}.branding.logoImageId is required.`)
    const id = branding.logoImageId
    if (id !== null && (typeof id !== 'string' || !imageIdPattern.test(id) || !Object.hasOwn(value.images, id))) {
      throw new Error(`${path}.branding.logoImageId must be null or reference an existing image.`)
    }
    // Preserve the old property position so legacy snapshot content remains stable.
    quotation.branding = { logoDataUrl: id === null ? '' : value.images[id], ...branding }
    delete quotation.branding.logoImageId
  }
  expandBranding(expanded.quotation, 'quotation')
  if (Array.isArray(expanded.revisions)) expanded.revisions.forEach((revision, index) => {
    if (isRecord(revision)) expandBranding(revision.quotation, `revisions[${index}].quotation`)
  })
  expanded.schemaVersion = 3
  delete expanded.images
  return expanded
}

export function encodeQuotationEnvelope(value) {
  const envelope = decodeQuotationEnvelope(value)
  const images = {}
  const ids = new Map()
  const storeBranding = (quotation, path) => {
    if (!isRecord(quotation?.branding) || typeof quotation.branding.logoDataUrl !== 'string') {
      throw new Error(`${path}.branding.logoDataUrl must be a string before encoding.`)
    }
    if (Object.hasOwn(quotation.branding, 'logoImageId')) throw new Error(`${path}.branding cannot contain both logoDataUrl and logoImageId.`)
    const dataUrl = quotation.branding.logoDataUrl
    let logoImageId = null
    if (dataUrl !== '') {
      logoImageId = ids.get(dataUrl)
      if (logoImageId === undefined) {
        logoImageId = `image-${ids.size + 1}`
        ids.set(dataUrl, logoImageId)
        images[logoImageId] = dataUrl
      }
    }
    quotation.branding = { logoImageId, ...quotation.branding }
    delete quotation.branding.logoDataUrl
  }
  storeBranding(envelope.quotation, 'quotation')
  envelope.revisions ??= []
  if (!Array.isArray(envelope.revisions)) throw new Error('revisions must be an array.')
  envelope.revisions.forEach((revision, index) => storeBranding(revision?.quotation, `revisions[${index}].quotation`))
  envelope.schemaVersion = 4
  envelope.images = images
  return envelope
}
