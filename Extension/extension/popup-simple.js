// ---------- UI refs ----------
const fileInput = document.getElementById("fileInput")
const selectFilesBtn = document.getElementById("selectFilesBtn")
const selectedBox = document.getElementById("selected")
const formatSel = document.getElementById("format")
const nameInput = document.getElementById("name")
const tsCheck = document.getElementById("ts")
const bar = document.getElementById("bar")
const statusEl = document.getElementById("status")
const createBtn = document.getElementById("create")
const resetBtn = document.getElementById("reset")

// ---------- State ----------
let pickedFiles = []

// ---------- Helpers ----------
const enc = new TextEncoder()
function fmtBytes(n) {
  const u = ["B", "KB", "MB", "GB"]
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${u[i]}`
}
function setStatus(msg, cls = "muted") {
  statusEl.className = cls
  statusEl.textContent = msg
}
function setProgress(p) {
  bar.style.width = `${Math.max(0, Math.min(100, p))}%`
}
function dosTimeDate(ms) {
  const d = new Date(ms)
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31)
  const date = (((d.getFullYear() - 1980) & 127) << 9) | ((d.getMonth() + 1) << 5) | (d.getDate() & 31)
  return { dosTime: time, dosDate: date }
}
function crc32Buf(buf) {
  const T =
    crc32Buf.T ||
    (crc32Buf.T = (() => {
      const t = new Uint32Array(256)
      for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[n] = c >>> 0
      }
      return t
    })())
  let crc = 0 ^ -1
  const a = new Uint8Array(buf)
  for (let i = 0; i < a.length; i++) crc = (crc >>> 8) ^ T[(crc ^ a[i]) & 0xff]
  return (crc ^ -1) >>> 0
}
function padTo(arr, block) {
  const pad = (block - (arr.length % block)) % block
  if (pad) arr.push(...new Array(pad).fill(0))
}
function downloadBlob(blob, name) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(a.href)
    a.remove()
  }, 0)
}

// ---------- UI logic ----------
selectFilesBtn.addEventListener("click", () => fileInput.click())
fileInput.addEventListener("change", () => {
  pickedFiles = Array.from(fileInput.files || [])
  if (pickedFiles.length === 0) {
    selectedBox.textContent = "No files selected."
    selectedBox.className = "list muted"
    return
  }
  const total = pickedFiles.reduce((s, f) => s + f.size, 0)
  const lines = pickedFiles.slice(0, 12).map((f) => `• ${f.name} (${fmtBytes(f.size)})`)
  const more = pickedFiles.length > 12 ? `\n… +${pickedFiles.length - 12} more` : ""
  selectedBox.textContent = `${pickedFiles.length} file(s) — ${fmtBytes(total)}\n` + lines.join("\n") + more
  selectedBox.className = "list"
})

// ---------- Archive builders (files only) ----------
// ZIP (store only)
async function buildZip(files) {
  const parts = [],
    central = []
  let offset = 0
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const fname = enc.encode(f.name)
    const ab = await f.arrayBuffer()
    const crc = crc32Buf(ab)
    const { dosTime, dosDate } = dosTimeDate(f.lastModified || Date.now())

    const local = new Uint8Array(30 + fname.length)
    const v1 = new DataView(local.buffer)
    v1.setUint32(0, 0x04034b50, true)
    v1.setUint16(4, 20, true)
    v1.setUint16(6, 0, true)
    v1.setUint16(8, 0, true) // store
    v1.setUint16(10, dosTime, true)
    v1.setUint16(12, dosDate, true)
    v1.setUint32(14, crc, true)
    v1.setUint32(18, ab.byteLength, true)
    v1.setUint32(22, ab.byteLength, true)
    v1.setUint16(26, fname.length, true)
    v1.setUint16(28, 0, true)
    local.set(fname, 30)
    parts.push(local, new Uint8Array(ab))

    const centralHeader = new Uint8Array(46 + fname.length)
    const v2 = new DataView(centralHeader.buffer)
    v2.setUint32(0, 0x02014b50, true)
    v2.setUint16(4, 20, true)
    v2.setUint16(6, 20, true)
    v2.setUint16(8, 0, true)
    v2.setUint16(10, 0, true)
    v2.setUint16(12, dosTime, true)
    v2.setUint16(14, dosDate, true)
    v2.setUint32(16, crc, true)
    v2.setUint32(20, ab.byteLength, true)
    v2.setUint32(24, ab.byteLength, true)
    v2.setUint16(28, fname.length, true)
    v2.setUint16(30, 0, true)
    v2.setUint16(32, 0, true)
    v2.setUint16(34, 0, true)
    v2.setUint16(36, 0, true)
    v2.setUint32(38, 0, true)
    v2.setUint32(42, offset, true)
    central.push(centralHeader)
    offset += local.length + ab.byteLength

    setProgress(((i + 1) / files.length) * 70)
  }
  const centralBlob = new Blob(central)
  const centralSize = (await centralBlob.arrayBuffer()).byteLength
  const end = new Uint8Array(22)
  const v3 = new DataView(end.buffer)
  v3.setUint32(0, 0x06054b50, true)
  v3.setUint16(4, 0, true)
  v3.setUint16(6, 0, true)
  v3.setUint16(8, central.length, true)
  v3.setUint16(10, central.length, true)
  v3.setUint32(12, centralSize, true)
  v3.setUint32(16, offset, true)
  v3.setUint16(20, 0, true)
  setProgress(90)
  return new Blob([...parts, centralBlob, end], { type: "application/zip" })
}

// TAR (ustar)
function oct(n, size) {
  const s = n.toString(8)
  return enc.encode(s.padStart(size - 1, "0") + "\0")
}
function put(buf, off, str) {
  buf.set(enc.encode(str), off)
}
function tarHeader(name, size, mtime, type = "0") {
  const b = new Uint8Array(512)
  put(b, 0, name)
  b.set(oct(0o644, 8), 100)
  b.set(oct(0, 8), 108)
  b.set(oct(0, 8), 116)
  b.set(oct(size, 12), 124)
  b.set(oct(mtime, 12), 136)
  for (let i = 148; i < 156; i++) b[i] = 0x20
  b[156] = type.charCodeAt(0)
  put(b, 257, "ustar")
  let sum = 0
  for (let i = 0; i < 512; i++) sum += b[i]
  b.set(oct(sum, 8), 148)
  return b
}
async function buildTar(files) {
  const out = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const name = f.name.length > 100 ? f.name.slice(0, 100) : f.name
    const ab = await f.arrayBuffer()
    const hdr = tarHeader(name, ab.byteLength, Math.floor((f.lastModified || Date.now()) / 1000), "0")
    out.push(hdr, new Uint8Array(ab))

    // Pad the file payload to the next 512-byte boundary by pushing a separate zero chunk.
    const padLen = (512 - (ab.byteLength % 512)) % 512
    if (padLen) out.push(new Uint8Array(padLen))

    setProgress(((i + 1) / files.length) * 80)
  }
  // Two 512-byte zero blocks mark end of archive.
  out.push(new Uint8Array(512), new Uint8Array(512))
  setProgress(100)
  return new Blob(out, { type: "application/x-tar" })
}
async function gzipBlob(blob) {
  if (typeof CompressionStream === "undefined")
    throw new Error("CompressionStream not available. Update Chrome for tar.gz or gz.")
  const stream = blob.stream().pipeThrough(new CompressionStream("gzip"))
  const buf = await new Response(stream).arrayBuffer()
  return new Blob([buf], { type: "application/gzip" })
}
async function buildGzSingle(file) {
  return gzipBlob(new Blob([await file.arrayBuffer()], { type: "application/octet-stream" }))
}

// ---------- Create ----------
async function createArchive() {
  try {
    if (pickedFiles.length === 0) return setStatus("No files selected.", "err")
    const fmt = formatSel.value
    const stemRaw =
      nameInput.value?.trim() || (pickedFiles.length === 1 ? pickedFiles[0].name.replace(/\.[^.]+$/, "") : "archive")
    const stem = stemRaw || "archive"
    const ts = tsCheck.checked ? `_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}` : ""

    setProgress(2)
    setStatus("Preparing…")
    let blob, filename

    if (fmt === "zip") {
      setStatus("Building ZIP…")
      blob = await buildZip(pickedFiles)
      filename = `${stem}${ts}.zip`
    } else if (fmt === "tar") {
      setStatus("Building TAR…")
      blob = await buildTar(pickedFiles)
      filename = `${stem}${ts}.tar`
    } else if (fmt === "tar.gz") {
      setStatus("Building TAR…")
      const tar = await buildTar(pickedFiles)
      setStatus("Compressing (gzip)…")
      blob = await gzipBlob(tar)
      filename = `${stem}${ts}.tar.gz`
    } else if (fmt === "gz") {
      if (pickedFiles.length !== 1) return setStatus("gz works with a single file only. Pick exactly one file.", "err")
      setStatus("Compressing (gzip)…")
      blob = await buildGzSingle(pickedFiles[0])
      filename = `${stem}${ts}.gz`
    } else {
      return setStatus("Unsupported format.", "err")
    }

    setStatus("Saving…")
    downloadBlob(blob, filename)
    setStatus(`Done → ${filename}`, "ok")
    setProgress(100)
  } catch (e) {
    console.error("[v0] createArchive error", e)
    setStatus(e?.message || "Failed to create archive.", "err")
    setProgress(0)
  }
}

createBtn.addEventListener("click", createArchive)
resetBtn.addEventListener("click", () => {
  pickedFiles = []
  fileInput.value = ""
  selectedBox.textContent = "No files selected."
  selectedBox.className = "list muted"
  setStatus("")
  setProgress(0)
})

// Prevent drag-and-drop behavior (folder feature removed)
;["dragenter", "dragover", "drop"].forEach((evt) =>
  document.addEventListener(evt, (e) => {
    e.preventDefault()
    e.stopPropagation()
  }),
)
