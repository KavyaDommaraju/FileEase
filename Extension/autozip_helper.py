import os, time, zipfile, tarfile, gzip, threading, traceback
import uiautomation as auto
import pythoncom
from tkinter import Tk, Toplevel, StringVar, BooleanVar, Label, Button, Radiobutton, Checkbutton, filedialog, messagebox
import keyboard

# ---------- Compression ----------
def compress(src_path, fmt="zip", keep=True, add_ts=False):
    if not os.path.exists(src_path):
        raise FileNotFoundError(src_path)

    parent = os.path.dirname(src_path)
    base = os.path.basename(src_path)

    def with_ts(name):
        if not add_ts: return name
        import datetime as dt
        return f"{name}_{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}"

    if fmt == "zip":
        out = os.path.join(parent, with_ts(base) + ".zip")
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            if os.path.isdir(src_path):
                for r, _, files in os.walk(src_path):
                    for f in files:
                        fp = os.path.join(r, f)
                        z.write(fp, os.path.relpath(fp, parent))
            else:
                z.write(src_path, arcname=os.path.basename(src_path))
        if not keep: os.remove(src_path)
        return out

    if fmt == "tar.gz":
        out = os.path.join(parent, with_ts(base) + ".tar.gz")
        with tarfile.open(out, "w:gz") as tar:
            tar.add(src_path, arcname=os.path.basename(src_path))
        if not keep: os.remove(src_path)
        return out

    if fmt == "gz":
        if os.path.isdir(src_path):
            raise ValueError(".gz can only be used for a single file")
        out = os.path.join(parent, with_ts(base) + ".gz")
        with open(src_path, "rb") as fin, gzip.open(out, "wb") as fout:
            fout.write(fin.read())
        if not keep: os.remove(src_path)
        return out

    if fmt == "7z":
        import py7zr
        out = os.path.join(parent, with_ts(base) + ".7z")
        with py7zr.SevenZipFile(out, "w") as z:
            if os.path.isdir(src_path):
                z.writeall(src_path, arcname=os.path.basename(src_path))
            else:
                z.write(src_path, arcname=os.path.basename(src_path))
        if not keep: os.remove(src_path)
        return out

    raise ValueError(f"Unsupported format: {fmt}")
    messagebox.showinfo("AutoZip", f"Archive created:\n{out_path}")


# ---------- File dialog helpers (write-only) ----------
def find_dialog_and_edit():
    """Find the foreground file dialog and its 'File name' edit control. We only WRITE to it."""
    try:
        fg = auto.GetForegroundControl()
        # climb to window
        dlg = fg
        while dlg and dlg.ControlTypeName not in ("WindowControl", "PaneControl"):
            dlg = dlg.GetParentControl()
        if not dlg:
            return None, None

        # common 'File name' = AutomationId 1148
        try:
            edit = dlg.EditControl(AutomationId="1148")
            if edit.Exists(0.2):
                return dlg, edit
        except Exception:
            pass

        # fallback: deepest EditControl in dialog
        stack = [dlg]
        last_edit = None
        while stack:
            n = stack.pop()
            try:
                if n.ControlTypeName == "EditControl":
                    last_edit = n
                stack.extend(n.GetChildren())
            except Exception:
                continue
        if last_edit: return dlg, last_edit
    except Exception:
        pass
    return None, None

def set_path_and_accept(dlg, edit, full_path):
    """Write only the archive filename into the 'File name' box and press Open/Enter."""
    filename = os.path.basename(full_path)
    folder = os.path.dirname(full_path)
    print("DEBUG: set_path_and_accept with full path =", full_path)
    print("DEBUG: filename =", filename)
    print("DEBUG: folder =", folder)

    try:
        vp = edit.GetValuePattern()
        vp.SetValue(filename)  # Only put the file name
        print("DEBUG: SetValue with filename worked")
    except Exception as e:
        print("DEBUG: SetValue failed:", e)
        try:
            edit.SetFocus()
            auto.SendKeys("^a"); time.sleep(0.1)
            auto.SendKeys(filename)
            print("DEBUG: Sent filename directly")
        except Exception as e2:
            print("DEBUG: SendKeys failed:", e2)

    # Press Enter / Click button
    try:
        for name in ("Open", "Upload", "Choose", "OK", "&Open", "&Upload"):
            btn = dlg.ButtonControl(Name=name)
            if btn.Exists(0.5):
                print("DEBUG: Found button", name)
                btn.Click()
                return
        auto.SendKeys("{Enter}")
        print("DEBUG: Pressed Enter")
    except Exception as e:
        print("DEBUG: Clicking button failed:", e)
        auto.SendKeys("{Enter}")

# ---------- GUI to choose file+format ----------
class ChooseAndZip:
    def __init__(self, dialog_title="Upload"):
        self.root = Tk(); self.root.withdraw()
        self.top = Toplevel(self.root)
        self.top.title("AutoZip")
        self.top.attributes("-topmost", True)
        self.path = StringVar(value="")
        self.fmt = StringVar(value="zip")
        self.keep = BooleanVar(value=True)
        self.ts = BooleanVar(value=False)

        Label(self.top, text=f"Upload dialog: {dialog_title}", padx=10, pady=6).grid(row=0, column=0, columnspan=3, sticky="w")

        Label(self.top, text="Selected source:").grid(row=1, column=0, padx=10, sticky="e")
        Label(self.top, textvariable=self.path, wraplength=420, anchor="w", justify="left").grid(row=1, column=1, columnspan=2, padx=10, pady=6, sticky="w")

        Button(self.top, text="Browse file…", width=14, command=self.pick_file).grid(row=2, column=1, sticky="w", padx=10)
        Button(self.top, text="Browse folder…", width=14, command=self.pick_folder).grid(row=2, column=2, sticky="w", padx=10)

        Label(self.top, text="Format:").grid(row=3, column=0, padx=10, pady=(10,0), sticky="e")
        col = 1
        for opt in ("zip", "7z", "tar.gz", "gz"):
            Radiobutton(self.top, text=opt, value=opt, variable=self.fmt).grid(row=3, column=col, sticky="w", padx=8, pady=(10,0))
            col += 1

        Checkbutton(self.top, text="Keep original", variable=self.keep).grid(row=4, column=1, sticky="w", padx=10, pady=(8,0))
        Checkbutton(self.top, text="Append timestamp", variable=self.ts).grid(row=4, column=2, sticky="w", padx=10, pady=(8,0))

        Button(self.top, text="Create archive", width=16, command=self.ok).grid(row=5, column=1, padx=10, pady=12, sticky="e")
        Button(self.top, text="Cancel", width=12, command=self.cancel).grid(row=5, column=2, padx=10, pady=12, sticky="w")

        self.result = None

    def pick_file(self):
        p = filedialog.askopenfilename(title="Choose a file")
        if p: self.path.set(p)

    def pick_folder(self):
        p = filedialog.askdirectory(title="Choose a folder")
        if p: self.path.set(p)

    def ok(self):
        p = self.path.get().strip()
        print("DEBUG: ok() called with path =", p)
        if not p or not os.path.exists(p):
            messagebox.showinfo("AutoZip", "Please choose a valid file or folder.")
            print("DEBUG: invalid path")
            return
        if self.fmt.get() == "gz" and os.path.isdir(p):
            messagebox.showinfo("AutoZip", ".gz can only be used for a single file.")
            print("DEBUG: invalid format for folder with .gz")
            return
        self.result = (p, self.fmt.get(), self.keep.get(), self.ts.get())
        print("DEBUG: self.result set to", self.result)
        self.top.destroy()
        self.root.quit()   # <--- IMPORTANT

    def cancel(self):
        self.result = None
        self.top.destroy()
        self.root.quit()   # <--- IMPORTANT


    def run(self):
        self.root.mainloop()
        return self.result

# ---------- Hotkey ----------
# ---------- Hotkey ----------
def handle_hotkey():
    def worker():
        try:
            # Initialize COM for this thread
            import pythoncom
            pythoncom.CoInitialize()

            dlg, edit = find_dialog_and_edit()
            if not dlg or not edit:
                messagebox.showinfo(
                    "AutoZip",
                    "❌ Could not detect upload dialog. Please open the file chooser first, then press Ctrl+Alt+Z."
                )
                print("DEBUG: Upload dialog not detected")
                return
            else:
                messagebox.showinfo("AutoZip", f"✅ Found dialog: {dlg.Name}")
                print(f"DEBUG: Found dialog: {dlg.Name}, edit control: {edit}")

            chooser = ChooseAndZip(dialog_title=dlg.Name or "Upload")
            res = chooser.run()
            print("DEBUG: chooser result =", res)

            if not res:
                print("DEBUG: chooser cancelled")
                return
            src, fmt, keep, ts = res
            print(f"DEBUG: Compressing {src} as {fmt}, keep={keep}, ts={ts}")

            try:
                out_path = compress(src, fmt=fmt, keep=keep, add_ts=ts)
                print("DEBUG: compress() returned", out_path)
            except Exception as e:
                messagebox.showerror(
                    "AutoZip",
                    f"Compression failed:\n{e}\n\n{traceback.format_exc(limit=1)}"
                )
                print("DEBUG: compress() failed", e)
                return

            if out_path and os.path.exists(out_path):
                messagebox.showinfo("AutoZip", f"✅ Archive created:\n{out_path}")
                print("DEBUG: Archive exists at", out_path)
            else:
                messagebox.showerror("AutoZip", f"❌ Archive NOT created:\n{out_path}")
                print("DEBUG: Archive missing at", out_path)

            set_path_and_accept(dlg, edit, out_path)
            print("DEBUG: set_path_and_accept called")

        finally:
            try:
                pythoncom.CoUninitialize()
            except Exception:
                pass

    threading.Thread(target=worker, daemon=True).start()

def main():
    print("AutoZip helper running.")
    print("Usage: open a web page's file picker, then press  Ctrl + Alt + Z")
    keyboard.add_hotkey("ctrl+alt+z", handle_hotkey)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("Exiting AutoZip helper...")
        pass   # <--- prevents IndentationError
if __name__ == "__main__":
    main()
