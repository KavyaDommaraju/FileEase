/* eslint-disable no-undef */
// Minimal, dependency-free archive creator for ZIP, TAR, TAR.GZ, and GZ.
// 7z requires a WASM bundle (not shipped by default).

const $ = (id) => document.getElementById(id)

const state = {
  // Array of {file: File, path: string} where path is relative path inside archive
  items: [],
  // If a directory was chosen, this holds the top-level folder name for display
  rootFolderName: null,
}

function setStatus(text) {
  $("status").textContent = text
}

function setError(msg) {
  $("error").textContent = msg || ""
}

function setProgress(pct) {
  $("bar").style.width = `${Math.max(0, Math.min(100, pct))}%`
}

function bytesToSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function renderSelection() {
  const box = $("selection")
  if (!state.items.length) {
    box.textContent = "No files selected"
    return
  }
  const first = state.items[0]
  const totalSize = state.items.reduce((s, it) => s + (it.file.size || 0), 0)
  const lines = []
  if (state.rootFolderName) {
    lines.push(`${state.items.length} files from ${state.rootFolderName}/  (${bytesToSize(totalSize)})`)
  } else {
    lines.push(`${state.items.length} file(s) selected  (${bytesToSize(totalSize)})`)
  }
  for (const it of state.items.slice(0, 10)) {
    lines.push(`• ${it.path}  (${bytesToSize(it.file.size)})`)
  }
  if (state.items.length > 10) lines.push(`… and ${state.items.length - 10} more`)
  box.textContent = lines.join("\n")
}

function getCommonRoot(paths) {
  if (paths.length === 0) return ""
  const parts = paths.map((p) => p.split("/"))
  const minLen = Math.min(...parts.map((a) => a.length))
  const root = []
  for (let i = 0; i < minLen; i++) {
    const seg = parts[0][i]
    if (parts.every((a) => a[i] === seg)) root.push(seg)
    else break
  }
  return root.join("/")
}

// File pickers
$("btnFiles").addEventListener("click", () => $("fileInput").click())

// Falls back to hidden input with webkitdirectory if not available or if user cancels.
$("btnFolder").addEventListener("click", async () => {
  setError("")
  // Try showDirectoryPicker first (more reliable on many managed installs)
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const dir = await window.showDirectoryPicker()
      const items = []
      async function walk(handle, prefix = "") {
        for await (const [name, entry] of handle.entries()) {
          if (entry.kind === "file") {
            const file = await entry.getFile()
            items.push({ file, path: prefix ? `${prefix}/${name}` : name })
          } else if (entry.kind === "directory") {
            await walk(entry, prefix ? `${prefix}/${name}` : name)
          }
        }
      }
      await walk(dir, "")
      if (!items.length) {
        setError("The selected folder is empty.")
        state.items = []
        state.rootFolderName = null
        renderSelection()
        return
      }
      state.items = items
      state.rootFolderName = dir.name
      renderSelection()
      return
    } catch (err) {
      // User cancelled or API blocked; fall back to webkitdirectory
      console.log("[v0] showDirectoryPicker fallback:", err?.name || err)
    }
  }
  // Fallback: open the legacy directory picker
  $("dirInput").click()
})

$("fileInput").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || [])
  state.items = files.map((f) => ({ file: f, path: f.name }))
  state.rootFolderName = null
  renderSelection()
})

// Drag-and-drop folder support as a robust fallback
const drop = $("dropZone")

function preventDefaults(e) {
  e.preventDefault()
  e.stopPropagation()
}
;["dragenter", "dragover"].forEach((evt) =>
  drop.addEventListener(evt, (e) => {
    preventDefaults(e)
    drop.classList.add("dragover")
  }),
)
;["dragleave", "drop"].forEach((evt) =>
  drop.addEventListener(evt, (e) => {
    preventDefaults(e)
    drop.classList.remove("dragover")
  }),
)

drop.addEventListener("drop", async (e) => {
  setError("")
  const items = Array.from(e.dataTransfer?.items || [])
  if (!items.length) return

  // Walk DataTransferItem entries recursively
  async function entryToItems(entry, prefix = "") {
    const out = []
    if (!entry) return out
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej))
      out.push({ file, path: prefix ? `${prefix}/${file.name}` : file.name })
    } else if (entry.isDirectory) {
      const reader = entry.createReader()
      async function readAll() {
        const batch = await new Promise((res) => reader.readEntries(res))
        if (!batch.length) return
        for (const ent of batch) {
          const child = await entryToItems(ent, prefix ? `${prefix}/${entry.name}` : entry.name)
          out.push(...child)
        }
        await readAll()
      }
      await readAll()
    }
    return out
  }

  // Collect all entries
  const all = []
  for (const i of items) {
    const entry = i.webkitGetAsEntry ? i.webkitGetAsEntry() : null
    if (!entry) continue
    const arr = await entryToItems(entry, "")
    all.push(...arr)
  }

  if (!all.length) {
    setError("Nothing was dropped or your browser blocked folder reading. Try Select folder… or Select files…")
    return
  }

  // Determine a root folder name if only one top-level directory was dropped
  const roots = new Set(all.map((it) => it.path.split("/")[0]))
  state.rootFolderName = roots.size === 1 ? Array.from(roots)[0] : null
  state.items = all
  renderSelection()
})

$("dirInput").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || [])
  if (files.length === 0) {
    setError(
      "No files returned. Your browser/device may block directory access. Use drag-and-drop above or click “Select files…”.",
    )
    state.items = []
    state.rootFolderName = null
    renderSelection()
    return
  }
  // Build relative paths using webkitRelativePath (Chrome) or fallback to name
  const rels = files.map((f) => (f.webkitRelativePath || f.name).replaceAll("\\", "/"))
  const root = getCommonRoot(rels)
  const top = root.split("/")[0] || null
  state.items = files.map((f, idx) => {
    const rel = rels[idx]
    const trimmed = root ? rel.slice(root.length).replace(/^\/+/, "") : rel
    return { file: f, path: trimmed || f.name }
  })
  state.rootFolderName = top
  renderSelection()
})

// Utilities
async function readAsUint8(file) {
  const buf = await file.arrayBuffer()
  return new Uint8Array(buf)
}

function textEncoder(str) {
  return new TextEncoder().encode(str)
}

function pad(n, size) {
  const padLen = (size - (n % size)) % size
  return padLen
}

// CRC32 for ZIP (IEEE)
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(data) {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ZIP (store-only)
async function createZip(items) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const it of items) {
    const nameBytes = textEncoder(it.path)
    const data = await readAsUint8(it.file)
    const crc = crc32(data)
    const compData = data // store-only

    const localHeader = new Uint8Array(30 + nameBytes.length)
    const dv = new DataView(localHeader.buffer)
    dv.setUint32(0, 0x04034b50, true) // local file header signature
    dv.setUint16(4, 20, true) // version needed
    dv.setUint16(6, 0, true) // flags
    dv.setUint16(8, 0, true) // compression = 0
    dv.setUint16(10, 0, true) // mod time
    dv.setUint16(12, 0, true) // mod date
    dv.setUint32(14, crc, true)
    dv.setUint32(18, compData.length, true)
    dv.setUint32(22, data.length, true)
    dv.setUint16(26, nameBytes.length, true)
    dv.setUint16(28, 0, true) // extra len
    localHeader.set(nameBytes, 30)

    localParts.push(localHeader, compData)

    const central = new Uint8Array(46 + nameBytes.length)
    const dvc = new DataView(central.buffer)
    dvc.setUint32(0, 0x02014b50, true) // central header signature
    dvc.setUint16(4, 20, true) // version made
    dvc.setUint16(6, 20, true) // version needed
    dvc.setUint16(8, 0, true) // flags
    dvc.setUint16(10, 0, true) // compression = 0
    dvc.setUint16(12, 0, true) // time
    dvc.setUint16(14, 0, true) // date
    dvc.setUint32(16, crc, true)
    dvc.setUint32(20, compData.length, true)
    dvc.setUint32(24, data.length, true)
    dvc.setUint16(28, nameBytes.length, true)
    dvc.setUint16(30, 0, true) // extra
    dvc.setUint16(32, 0, true) // comment
    dvc.setUint16(34, 0, true) // disk start
    dvc.setUint16(36, 0, true) // int attrs
    dvc.setUint32(38, 0, true) // ext attrs
    dvc.setUint32(42, offset, true) // local header offset
    central.set(nameBytes, 46)

    centralParts.push(central)

    // advance offset for this file: header + name + data
    offset += localHeader.length + compData.length
  }

  const centralOffset = offset
  const centralSize = centralParts.reduce((s, p) => s + p.length, 0)
  const end = new Uint8Array(22)
  const dve = new DataView(end.buffer)
  dve.setUint32(0, 0x06054b50, true) // EOCD signature
  dve.setUint16(4, 0, true) // disk
  dve.setUint16(6, 0, true) // disk start
  dve.setUint16(8, items.length, true)
  dve.setUint16(10, items.length, true)
  dve.setUint32(12, centralSize, true)
  dve.setUint32(16, centralOffset, true)
  dve.setUint16(20, 0, true)

  const all = [...localParts, ...centralParts, end]
  const size = all.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(size)
  let pos = 0
  for (const part of all) {
    out.set(part, pos)
    pos += part.length
  }
  return new Blob([out], { type: "application/zip" })
}

// TAR (ustar, store-only)
function makeTarHeader(path, size, isDir = false) {
  const buf = new Uint8Array(512)
  function write(str, start, len) {
    const b = textEncoder(str)
    buf.set(b.slice(0, len), start)
  }
  write(path, 0, 100)
  write(isDir ? "0000777" : "0000644", 100, 8) // mode
  write("0000000", 108, 8) // uid
  write("0000000", 116, 8) // gid
  const sizeOct = size.toString(8).padStart(11, "0")
  write(sizeOct + "\0", 124, 12)
  write("00000000000", 136, 12) // mtime
  write("        ", 148, 8) // checksum (spaces)
  buf[156] = isDir ? 53 /* '5' */ : 48 /* '0' */
  write("ustar\0", 257, 6)
  write("00", 263, 2)

  // compute checksum
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]
  const chk = sum.toString(8).padStart(6, "0")
  for (let i = 0; i < 6; i++) buf[148 + i] = chk.charCodeAt(i)
  buf[148 + 6] = 0 // NUL
  buf[148 + 7] = 0x20 // space
  return buf
}

async function createTar(items) {
  const parts = []
  const writtenDirs = new Set() // moved here from function property so it resets every run
  for (const it of items) {
    const path = it.path.replaceAll("\\", "/")
    const segs = path.split("/")
    for (let i = 0; i < segs.length - 1; i++) {
      const d = segs.slice(0, i + 1).join("/") + "/"
      if (!writtenDirs.has(d)) {
        parts.push(makeTarHeader(d, 0, true))
        parts.push(new Uint8Array(0))
        const padLen = pad(0, 512)
        if (padLen) parts.push(new Uint8Array(padLen))
        writtenDirs.add(d)
      }
    }
    const data = await readAsUint8(it.file)
    parts.push(makeTarHeader(path, data.length, false))
    parts.push(data)
    const padLen = pad(data.length, 512)
    if (padLen) parts.push(new Uint8Array(padLen))
  }
  // 2 empty 512-byte blocks at the end
  parts.push(new Uint8Array(512))
  parts.push(new Uint8Array(512))

  const size = parts.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(size)
  let pos = 0
  for (const part of parts) {
    out.set(part, pos)
    pos += part.length
  }
  return new Blob([out], { type: "application/x-tar" })
}

// GZIP using CompressionStream
async function gzipBlob(inputBlob) {
  if (typeof CompressionStream === "undefined") {
    throw new Error("Gzip not supported in this browser. Please update Chrome to a recent version.")
  }
  const cs = new CompressionStream("gzip")
  const stream = inputBlob.stream().pipeThrough(cs)
  const resp = new Response(stream)
  return await resp.blob()
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
    a.remove()
  }, 100)
}

$("create").addEventListener("click", async () => {
  setError("")
  if (!state.items.length) return setError("Please select at least one file or a folder.")

  const fmt = $("format").value
  const withTs = $("ts").checked
  const base = $("name").value.trim() || state.rootFolderName || state.items[0]?.file?.name?.split(".")[0] || "archive"
  const stamp = withTs
    ? `-${new Date()
        .toISOString()
        .replace(/[-:.TZ]/g, "")
        .slice(0, 15)}`
    : ""

  try {
    $("create").disabled = true
    setProgress(10)

    if (fmt === "zip") {
      setStatus("Creating ZIP…")
      const blob = await createZip(state.items)
      setProgress(95)
      downloadBlob(blob, `${base}${stamp}.zip`)
      setStatus("ZIP ready")
    } else if (fmt === "tar") {
      setStatus("Building TAR…")
      const tar = await createTar(state.items)
      setProgress(70)
      downloadBlob(tar, `${base}${stamp}.tar`)
      setStatus("TAR ready")
    } else if (fmt === "tar.gz") {
      setStatus("Building TAR…")
      const tar = await createTar(state.items)
      setProgress(50)
      setStatus("Compressing (gzip)…")
      const gz = await gzipBlob(tar)
      setProgress(95)
      downloadBlob(gz, `${base}${stamp}.tar.gz`)
      setStatus("TAR.GZ ready")
    } else if (fmt === "gz") {
      if (state.items.length !== 1) {
        throw new Error("GZ can only contain a single file. Select exactly one file or use TAR.GZ for multiple.")
      }
      setStatus("Compressing (gzip)…")
      const data = await readAsUint8(state.items[0].file)
      const gz = await gzipBlob(new Blob([data], { type: "application/octet-stream" }))
      setProgress(95)
      const nm = state.items[0].path.replace(/\.gz$/i, "")
      downloadBlob(gz, `${base || nm}${stamp}.gz`)
      setStatus("GZ ready")
    }
    setProgress(100)
  } catch (err) {
    console.error("[v0] create archive error:", err)
    setError(err?.message || String(err))
    setStatus("Error")
    setProgress(0)
  } finally {
    $("create").disabled = false
  }
})
