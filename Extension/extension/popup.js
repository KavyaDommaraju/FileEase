// Utility: CRC32 table
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(input) {
  let crc = 0xffffffff
  const view = input instanceof Uint8Array ? input : new Uint8Array(input)
  for (let i = 0; i < view.length; i++) {
    crc = CRC32_TABLE[(crc ^ view[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// Utility: DOS time/date from JS Date
function toDosDateTime(date = new Date()) {
  const yr = date.getFullYear()
  const dosYear = yr < 1980 ? 0 : yr - 1980
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const dosDate = (dosYear << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { dosTime, dosDate }
}

// Binary writer accumulating chunks
class BinWriter {
  constructor() {
    this.chunks = []
    this.length = 0
  }
  writeU8(v) {
    const b = new Uint8Array(1)
    b[0] = v & 0xff
    this._push(b)
  }
  writeU16(v) {
    const b = new Uint8Array(2)
    new DataView(b.buffer).setUint16(0, v, true)
    this._push(b)
  }
  writeU32(v) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, v >>> 0, true)
    this._push(b)
  }
  writeBytes(arr) {
    const b = arr instanceof Uint8Array ? arr : new Uint8Array(arr)
    this._push(b)
  }
  _push(b) {
    this.chunks.push(b)
    this.length += b.length
  }
  concat() {
    const out = new Uint8Array(this.length)
    let offset = 0
    for (const c of this.chunks) {
      out.set(c, offset)
      offset += c.length
    }
    return out
  }
}

// ZIP writer (store-only, no compression)
async function createZip(files, onProgress) {
  // files: Array<{ name: string, data: ArrayBuffer }>
  const writer = new BinWriter()
  const central = new BinWriter()
  const fileRecords = []
  let written = 0

  for (let idx = 0; idx < files.length; idx++) {
    const f = files[idx]
    const nameBytes = new TextEncoder().encode(f.name)
    const data = new Uint8Array(f.data)
    const crc = crc32(data)
    const uncompressedSize = data.byteLength
    const compressedSize = uncompressedSize // store-only
    const localHeaderOffset = writer.length
    const { dosTime, dosDate } = toDosDateTime(new Date())

    // Local file header
    writer.writeU32(0x04034b50) // signature
    writer.writeU16(20) // version needed to extract
    writer.writeU16(0) // general purpose bit flag
    writer.writeU16(0) // compression method = 0 (store)
    writer.writeU16(dosTime) // last mod time
    writer.writeU16(dosDate) // last mod date
    writer.writeU32(crc) // CRC-32
    writer.writeU32(compressedSize) // compressed size
    writer.writeU32(uncompressedSize) // uncompressed size
    writer.writeU16(nameBytes.length) // file name length
    writer.writeU16(0) // extra field length
    writer.writeBytes(nameBytes) // file name
    writer.writeBytes(data) // file data

    // Record for central directory
    fileRecords.push({
      nameBytes,
      crc,
      compressedSize,
      uncompressedSize,
      dosTime,
      dosDate,
      localHeaderOffset,
    })

    written++
    if (onProgress) onProgress(written / files.length)
  }

  const centralDirOffset = writer.length

  // Central directory entries
  for (const r of fileRecords) {
    central.writeU32(0x02014b50) // signature
    central.writeU16(20) // version made by
    central.writeU16(20) // version needed
    central.writeU16(0) // general purpose flag
    central.writeU16(0) // compression method = 0
    central.writeU16(r.dosTime) // time
    central.writeU16(r.dosDate) // date
    central.writeU32(r.crc) // CRC
    central.writeU32(r.compressedSize) // comp size
    central.writeU32(r.uncompressedSize) // uncomp size
    central.writeU16(r.nameBytes.length) // name length
    central.writeU16(0) // extra length
    central.writeU16(0) // comment length
    central.writeU16(0) // disk number start
    central.writeU16(0) // internal attrs
    central.writeU32(0) // external attrs
    central.writeU32(r.localHeaderOffset) // relative offset
    central.writeBytes(r.nameBytes) // file name
  }

  const centralDir = central.concat()
  const centralDirSize = centralDir.length

  // End of central directory
  const end = new BinWriter()
  end.writeU32(0x06054b50) // signature
  end.writeU16(0) // number of this disk
  end.writeU16(0) // number of the disk with the start of the central directory
  end.writeU16(fileRecords.length) // total entries on this disk
  end.writeU16(fileRecords.length) // total entries
  end.writeU32(centralDirSize) // size of central dir
  end.writeU32(centralDirOffset) // offset of central dir
  end.writeU16(0) // comment length

  // Concatenate everything
  writer.writeBytes(centralDir)
  writer.writeBytes(end.concat())
  return writer.concat()
}

// TAR writer (USTAR) and GZIP helpers
function asciiFill(buf, offset, str, max) {
  for (let i = 0; i < max; i++) {
    buf[offset + i] = i < str.length ? str.charCodeAt(i) & 0x7f : 0
  }
}
function octal(value, length) {
  // write octal ASCII with trailing NUL
  const s = value.toString(8).padStart(length - 1, "0")
  const out = new Uint8Array(length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  out[length - 1] = 0
  return out
}

function splitTarName(path) {
  // USTAR: name (100), prefix (155)
  if (new TextEncoder().encode(path).length <= 100) return { name: path, prefix: "" }
  const idx = path.lastIndexOf("/")
  if (idx > -1) {
    const prefix = path.slice(0, idx)
    const name = path.slice(idx + 1)
    return { name, prefix }
  }
  // fallback: truncate
  return { name: path.slice(-100), prefix: "" }
}

function makeTarHeader(path, size, mtimeSec = Math.floor(Date.now() / 1000)) {
  const buf = new Uint8Array(512)
  const dv = new DataView(buf.buffer)

  const { name, prefix } = splitTarName(path)

  // name
  asciiFill(buf, 0, name, 100)
  // mode, uid, gid
  buf.set(octal(0o644, 8), 100)
  buf.set(octal(0, 8), 108)
  buf.set(octal(0, 8), 116)
  // size
  buf.set(octal(size, 12), 124)
  // mtime
  buf.set(octal(mtimeSec, 12), 136)
  // checksum (placeholder spaces)
  for (let i = 148; i < 156; i++) buf[i] = 0x20
  // typeflag '0' (regular file)
  buf[156] = "0".charCodeAt(0)
  // linkname (empty)
  // magic + version
  asciiFill(buf, 257, "ustar", 5)
  buf[262] = 0 // NUL after "ustar"
  asciiFill(buf, 263, "00", 2)
  // uname/gname
  asciiFill(buf, 265, "user", 32)
  asciiFill(buf, 297, "group", 32)
  // devmajor/minor
  buf.set(octal(0, 8), 329)
  buf.set(octal(0, 8), 337)
  // prefix
  asciiFill(buf, 345, prefix, 155)

  // compute checksum
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]
  buf.set(octal(sum, 8), 148)
  return buf
}

function pad512(len) {
  const rem = len % 512
  return rem === 0 ? 0 : 512 - rem
}

async function createTar(entries, onProgress) {
  // entries: [{name, data(ArrayBuffer), mtime?}]
  const chunks = []
  let written = 0
  for (const e of entries) {
    const data = new Uint8Array(e.data)
    const header = makeTarHeader(e.name, data.length, Math.floor(Date.now() / 1000))
    chunks.push(header)
    chunks.push(data)
    const pad = pad512(data.length)
    if (pad) chunks.push(new Uint8Array(pad))
    written++
    if (onProgress) onProgress(written / entries.length)
  }
  // two 512-byte zero blocks to end archive
  chunks.push(new Uint8Array(512))
  chunks.push(new Uint8Array(512))

  // concat
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

async function gzipUint8(uint8) {
  if (typeof CompressionStream === "undefined") {
    throw new Error("Gzip not supported in this browser. Please update Chrome.")
  }
  const gzStream = new Blob([uint8]).stream().pipeThrough(new CompressionStream("gzip"))
  const arr = await new Response(gzStream).arrayBuffer()
  return new Uint8Array(arr)
}

// Helpers
function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1)} MB`
}

function withTimestamp(base) {
  const pad = (n) => n.toString().padStart(2, "0")
  const d = new Date()
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${base}_${ts}`
}

async function readAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(fr.result)
    fr.onerror = rej
    fr.readAsArrayBuffer(file)
  })
}

function getRelativeName(file) {
  // When picking a folder, Chrome provides webkitRelativePath; use it to preserve structure.
  return file.webkitRelativePath && file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name
}

// Helper to compute a top folder name for display
function topFolderFrom(paths) {
  if (!paths.length) return null
  const parts = paths.map((p) => p.split("/"))
  const min = Math.min(...parts.map((p) => p.length))
  const common = []
  for (let i = 0; i < min; i++) {
    const seg = parts[0][i]
    if (parts.every((p) => p[i] === seg)) common.push(seg)
    else break
  }
  // Show only the first common segment as "folder name"
  return common.length ? common[0] : null
}

// DOM
const fileInput = document.getElementById("fileInput")
const dirInput = document.getElementById("dirInput")
const fileList = document.getElementById("fileList")
const addTs = document.getElementById("addTs")
const archiveName = document.getElementById("archiveName")
const makeZipBtn = document.getElementById("makeZip")
const bar = document.getElementById("bar")
const status = document.getElementById("status")
const count = document.getElementById("count")
const fmtSelect = document.getElementById("format")

let picked = []
// Track whether a folder was selected and store a friendly folder name for UI
let pickedTopFolder = null

function renderList() {
  if (!picked.length) {
    fileList.textContent = "No files selected."
    count.textContent = ""
    return
  }
  const rels = picked.map((f) => getRelativeName(f))
  // Show top folder if applicable
  pickedTopFolder = topFolderFrom(rels)
  const lines = []
  if (pickedTopFolder) {
    lines.push(`${picked.length} files from ${pickedTopFolder}/`)
  } else {
    lines.push(`${picked.length} file${picked.length === 1 ? "" : "s"} selected`)
  }
  for (const f of picked.slice(0, 200)) {
    const rel = getRelativeName(f)
    lines.push(`${rel} (${fmtBytes(f.size)})`)
  }
  if (picked.length > 200) lines.push(`… and ${picked.length - 200} more`)
  fileList.textContent = lines.join("\n")
  count.textContent = `${picked.length} file${picked.length === 1 ? "" : "s"}`
}

function addFiles(list) {
  picked = picked.concat(Array.from(list))
  // De-duplicate by name + size + lastModified to prevent duplicates when clicking both pickers
  const seen = new Set()
  picked = picked.filter((f) => {
    const key = `${getRelativeName(f)}|${f.size}|${f.lastModified}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  renderList()
}

fileInput.addEventListener("change", (e) => {
  addFiles(e.target.files || [])
  fileInput.value = ""
})
dirInput.addEventListener("change", (e) => {
  addFiles(e.target.files || [])
  dirInput.value = ""
  renderList() // ensure folder name/count shows immediately
})

async function handleCreate() {
  if (!picked.length) {
    status.textContent = "Please select at least one file."
    return
  }
  const fmt = fmtSelect.value

  makeZipBtn.disabled = true
  status.textContent = "Reading files…"
  bar.style.width = "5%"

  // Read all files to memory
  const entries = []
  for (let i = 0; i < picked.length; i++) {
    const f = picked[i]
    const name = getRelativeName(f)
    const data = await readAsArrayBuffer(f)
    entries.push({ name, data })
    const p = Math.round(((i + 1) / picked.length) * 40) + 5
    bar.style.width = `${p}%`
  }

  let bytes
  let mime = "application/octet-stream"
  let ext = ""
  const progressPhase = (phaseBase) => (p) => {
    const base = 45
    const width = base + Math.round(p * 55)
    bar.style.width = `${width}%`
  }

  if (fmt === "zip") {
    status.textContent = "Creating ZIP…"
    bytes = await createZip(entries, progressPhase())
    mime = "application/zip"
    ext = ".zip"
  } else if (fmt === "tar") {
    status.textContent = "Creating TAR…"
    bytes = await createTar(entries, progressPhase())
    mime = "application/x-tar"
    ext = ".tar"
  } else if (fmt === "tar.gz") {
    // Ensure deterministic two-step: first TAR, then GZIP
    status.textContent = "Creating TAR…"
    const tarBytes = await createTar(entries, () => {})
    bar.style.width = "60%"
    status.textContent = "Compressing (gzip)…"
    bytes = await gzipUint8(tarBytes)
    mime = "application/gzip"
    ext = ".tar.gz"
  } else if (fmt === "gz") {
    if (entries.length !== 1) {
      status.textContent = "gz requires exactly one file. Pick a single file or use tar.gz for multiple."
      makeZipBtn.disabled = false
      return
    }
    status.textContent = "Compressing (gzip)…"
    const single = new Uint8Array(entries[0].data)
    bytes = await gzipUint8(single)
    mime = "application/gzip"
    ext = ".gz"
  } else {
    // Clearer guidance for 7z
    status.textContent = "7z requires a WASM runtime (JS7z). Reply 'Enable 7z now' and I’ll add the WASM bundle."
    makeZipBtn.disabled = false
    return
  }

  let base = (
    archiveName.value ||
    pickedTopFolder ||
    (picked.length === 1 ? picked[0].name.replace(/\.[^/.]+$/, "") : "archive")
  ).trim()
  if (!base) base = "archive"
  if (addTs.checked) base = withTimestamp(base)
  const outName = base.endsWith(ext) ? base : `${base}${ext}`

  status.textContent = `Saving ${outName}…`
  bar.style.width = "100%"

  const blob = new Blob([bytes], { type: mime })
  const url = URL.createObjectURL(blob)

  try {
    const chrome = window.chrome
    await chrome.downloads.download({
      url,
      filename: outName,
      saveAs: true,
    })
    status.textContent = "Done. Archive downloaded."
  } catch (e) {
    status.textContent = "Download API failed, opening in a new tab…"
    window.open(url, "_blank")
  } finally {
    makeZipBtn.disabled = false
    setTimeout(() => {
      bar.style.width = "0%"
      status.textContent = "Idle"
    }, 1200)
  }
}

makeZipBtn.addEventListener("click", () => {
  handleCreate().catch((err) => {
    console.error("[AutoZip] Error:", err)
    status.textContent = `Error: ${err.message || err}`
    makeZipBtn.disabled = false
  })
})
