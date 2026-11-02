"""Build TRADER_App.exe into this working folder (CSV journals)."""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STAGING = ROOT / "_exe_build"
WEB = STAGING / "web"
DIST = STAGING / "dist" / "TRADER_App"


def copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def main() -> int:
    if STAGING.exists():
        shutil.rmtree(STAGING)
    STAGING.mkdir(parents=True)
    WEB.mkdir(parents=True)

    shutil.copy2(ROOT / "index.html", WEB / "index.html")
    copy_tree(ROOT / "css", WEB / "css")
    copy_tree(ROOT / "js", WEB / "js")
    for name in ("hub_app.py", "excel_journal.py", "embedded_icons.py", "app.ico"):
        shutil.copy2(ROOT / name, STAGING / name)

    sep = ";" if sys.platform == "win32" else ":"
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--windowed", "--onedir",
        "--name", "TRADER_App",
        "--icon", str(STAGING / "app.ico"),
        "--distpath", str(STAGING / "dist"),
        "--workpath", str(STAGING / "build"),
        "--specpath", str(STAGING),
        f"--add-data={WEB}{sep}web",
        f"--add-data={STAGING / 'excel_journal.py'}{sep}.",
        f"--add-data={STAGING / 'embedded_icons.py'}{sep}.",
        "--hidden-import=excel_journal",
        "--hidden-import=embedded_icons",
        "--collect-all=webview",
        "--collect-all=openpyxl",
        "--collect-all=clr_loader",
        "--collect-all=pythonnet",
        str(STAGING / "hub_app.py"),
    ]
    print("Building…")
    subprocess.check_call(cmd, cwd=str(STAGING))

    if not DIST.is_dir():
        raise SystemExit(f"Missing build output: {DIST}")

    # Install into working folder
    dest_internal = ROOT / "_internal"
    if dest_internal.exists():
        shutil.rmtree(dest_internal)
    shutil.copy2(DIST / "TRADER_App.exe", ROOT / "TRADER_App.exe")
    copy_tree(DIST / "_internal", dest_internal)
    shutil.copy2(STAGING / "excel_journal.py", dest_internal / "excel_journal.py")

    # Cleanup staging
    shutil.rmtree(STAGING, ignore_errors=True)
    print("Installed TRADER_App.exe + _internal into working folder.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
