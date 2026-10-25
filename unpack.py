import gzip
import shutil
import os
import sys

def unpack_file(gz_filename, out_filename):
    if os.path.exists(out_filename):
        print(f"✓ {out_filename} already exists ({os.path.getsize(out_filename):,} bytes).")
        return
    if not os.path.exists(gz_filename):
        print(f"✗ {gz_filename} not found.")
        return
    print(f"Decompressing {gz_filename} -> {out_filename}...")
    with gzip.open(gz_filename, "rb") as f_in, open(out_filename, "wb") as f_out:
        shutil.copyfileobj(f_in, f_out)
    print(f"✓ Created {out_filename} ({os.path.getsize(out_filename):,} bytes).")

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(base_dir)
    print("Unpacking Majmu' al-Fatawa dataset files...")
    unpack_file("majmu_al_fatawa.db.gz", "majmu_al_fatawa.db")
    unpack_file("all_pages.jsonl.gz", "all_pages.jsonl")
    print("All files ready for use!")

if __name__ == "__main__":
    main()
