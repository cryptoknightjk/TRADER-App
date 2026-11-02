"""
Build a ship-ready portable folder next to the editable source app.

Output:
  ../CK CTS TRADER App - Ship/
    TRADER_App.exe
    _internal/     (runtime + bundled web UI)
    journals/      (CSV journals only)
    app.ico
    Start TRADER App.bat
    README.txt

The ship folder intentionally omits editable index.html / css / js.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PARENT = ROOT.parent
SHIP_NAME = "CK CTS TRADER App - Ship Ready v1.0"
SHIP = PARENT / SHIP_NAME
STAGING = ROOT / "_ship_staging"
WEB = STAGING / "web"
DIST = STAGING / "dist" / "TRADER_App"


def copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def stage_web() -> None:
    if WEB.exists():
        shutil.rmtree(WEB)
    WEB.mkdir(parents=True)

    shutil.copy2(ROOT / "index.html", WEB / "index.html")
    copy_tree(ROOT / "css", WEB / "css")
    copy_tree(ROOT / "js", WEB / "js")
    lib = ROOT / "lib"
    if lib.is_dir():
        copy_tree(lib, WEB / "lib")
    # Keep excel helper next to frozen imports as well
    shutil.copy2(ROOT / "excel_journal.py", STAGING / "excel_journal.py")
    shutil.copy2(ROOT / "embedded_icons.py", STAGING / "embedded_icons.py")
    shutil.copy2(ROOT / "hub_app.py", STAGING / "hub_app.py")
    shutil.copy2(ROOT / "app.ico", STAGING / "app.ico")


def run_pyinstaller() -> None:
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--windowed",
        "--onedir",
        "--name",
        "TRADER_App",
        "--icon",
        str(STAGING / "app.ico"),
        "--distpath",
        str(STAGING / "dist"),
        "--workpath",
        str(STAGING / "build"),
        "--specpath",
        str(STAGING),
        f"--add-data={WEB}{os_sep()}web",
        f"--add-data={STAGING / 'excel_journal.py'}{os_sep()}.",
        f"--add-data={STAGING / 'embedded_icons.py'}{os_sep()}.",
        "--hidden-import=excel_journal",
        "--hidden-import=embedded_icons",
        "--collect-all=webview",
        "--collect-all=openpyxl",
        "--collect-all=clr_loader",
        "--collect-all=pythonnet",
        str(STAGING / "hub_app.py"),
    ]
    print("Running:", " ".join(cmd))
    subprocess.check_call(cmd, cwd=str(STAGING))


def os_sep() -> str:
    return ";" if sys.platform == "win32" else ":"


def assemble_ship() -> None:
    if not DIST.is_dir():
        raise SystemExit(f"PyInstaller output missing: {DIST}")

    if SHIP.exists():
        shutil.rmtree(SHIP)
    SHIP.mkdir(parents=True)

    # Copy onedir output
    shutil.copy2(DIST / "TRADER_App.exe", SHIP / "TRADER_App.exe")
    copy_tree(DIST / "_internal", SHIP / "_internal")

    # Ensure excel_journal is present for imports that look beside MEIPASS
    ej_src = STAGING / "excel_journal.py"
    ej_dst = SHIP / "_internal" / "excel_journal.py"
    if ej_src.is_file():
        shutil.copy2(ej_src, ej_dst)

    # User data only (portable CSV journals)
    journals_dst = SHIP / "journals"
    journals_dst.mkdir(parents=True, exist_ok=True)
    src_journals = ROOT / "journals"
    if src_journals.is_dir():
        for item in src_journals.iterdir():
            if item.is_file() and item.suffix.lower() == ".csv":
                shutil.copy2(item, journals_dst / item.name)

    shutil.copy2(ROOT / "app.ico", SHIP / "app.ico")

    (SHIP / "Start TRADER App.bat").write_text(
        '@echo off\r\ncd /d "%~dp0"\r\nstart "" "%~dp0TRADER_App.exe"\r\n',
        encoding="utf-8",
    )

    # Branded shortcut
    try:
        import win32com.client  # type: ignore
    except Exception:
        win32com = None
    lnk = SHIP / "TRADER_App.lnk"
    try:
        # Prefer WScript via PowerShell-free COM through a tiny VBS
        vbs = SHIP / "_make_shortcut.vbs"
        exe = SHIP / "TRADER_App.exe"
        vbs.write_text(
            "\n".join([
                'Set sh = CreateObject("WScript.Shell")',
                f'Set sc = sh.CreateShortcut("{str(lnk).replace(chr(92), chr(92)+chr(92))}")',
                f'sc.TargetPath = "{str(exe).replace(chr(92), chr(92)+chr(92))}"',
                f'sc.WorkingDirectory = "{str(SHIP).replace(chr(92), chr(92)+chr(92))}"',
                f'sc.IconLocation = "{str(exe).replace(chr(92), chr(92)+chr(92))},0"',
                'sc.Description = "Crypto TA Secrets TRADER App"',
                "sc.Save",
            ]),
            encoding="utf-8",
        )
        subprocess.check_call(["cscript", "//nologo", str(vbs)], cwd=str(SHIP))
        vbs.unlink(missing_ok=True)
    except Exception as exc:
        print("Shortcut note:", exc)

    (SHIP / "README.txt").write_text(
        """Crypto TA Secrets TRADER App — Ship Ready v1.0 (Windows)
=======================================================

Portable build. No Python install required.

1. Copy this ENTIRE folder (zip / USB).
2. On the other PC, open TRADER_App.exe
   (or TRADER_App.lnk / Start TRADER App.bat)
3. Closing the window quits the app.

What is included
----------------
  TRADER_App.exe / TRADER_App.lnk
  _internal\\       — runtime + bundled UI
  journals\\        — portable CSV journals
  app.ico
  Start TRADER App.bat
  README.txt

Journals (CSV)
--------------
  journals\\default_journal.csv
  Create New Journal / Link Existing Journal write into journals\\
  Link Existing Journal can also:
    - point to any .csv journal
    - import Excel (.xlsx) → .csv
    - convert legacy .sqlite → .csv

Needs Windows 10/11 + WebView2 Runtime if the window is blank:
https://developer.microsoft.com/microsoft-edge/webview2/
""",
        encoding="utf-8",
    )


def assert_no_loose_ui() -> None:
    forbidden = ["index.html", "css", "js", "lib", "hub_app.py", "excel_journal.py"]
    bad = [name for name in forbidden if (SHIP / name).exists()]
    if bad:
        raise SystemExit(f"Ship folder still has editable leftovers: {bad}")
    web = SHIP / "_internal" / "web" / "index.html"
    if not web.is_file():
        # PyInstaller may nest add-data differently
        matches = list((SHIP / "_internal").rglob("index.html"))
        if not matches:
            raise SystemExit("Bundled index.html not found under _internal")
        print("Bundled UI at:", matches[0])
    else:
        print("Bundled UI at:", web)


def main() -> int:
    print("Staging web UI…")
    if STAGING.exists():
        shutil.rmtree(STAGING)
    STAGING.mkdir(parents=True)
    stage_web()
    print("Building with PyInstaller…")
    run_pyinstaller()
    print("Assembling ship folder…")
    assemble_ship()
    assert_no_loose_ui()
    print(f"\nShip package ready:\n  {SHIP}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
