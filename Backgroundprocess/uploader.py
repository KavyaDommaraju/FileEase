import os
import sys
import zipfile
import gzip
import tarfile
import shutil
import logging
from datetime import datetime
import py7zr   # for .7z compression (install via: pip install py7zr)

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)

def compress_file(file_path, fmt="zip"):
    """Compress a file/folder into different formats."""
    if not os.path.exists(file_path):
        logging.error(f"File not found: {file_path}")
        return None

    base_name = os.path.basename(file_path)
    ts = datetime.now().strftime("%Y%m%d%H%M%S")

    # ---------- ZIP ----------
    if fmt == "zip":
        out_name = f"{base_name}-{ts}.zip"
        with zipfile.ZipFile(out_name, "w", zipfile.ZIP_DEFLATED) as zipf:
            if os.path.isdir(file_path):
                for root, _, files in os.walk(file_path):
                    for f in files:
                        full_path = os.path.join(root, f)
                        arcname = os.path.relpath(full_path, os.path.dirname(file_path))
                        zipf.write(full_path, arcname)
            else:
                zipf.write(file_path, os.path.basename(file_path))

    # ---------- GZIP ----------
    elif fmt == "gz":
        out_name = f"{base_name}-{ts}.gz"
        with open(file_path, "_
