"""
Crypto TA Secrets TRADER App — portable desktop wrapper.

Closing the window stops the local server.

Ship builds serve the UI from bundled resources (inside the exe/_internal),
not from editable files next to the executable. Journals live in journals/
beside the exe as portable .csv files.
"""
from __future__ import annotations

import base64
import os
import shutil
import socket
import sys
import threading
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def app_root() -> Path:
    """Writable install folder (next to the .exe when frozen)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def ui_root() -> Path:
    """Folder that contains index.html / css / js / lib."""
    root = app_root()
    # Working copy / override: editable UI next to the exe wins over bundled web
    if (root / "index.html").is_file():
        return root
    if getattr(sys, "frozen", False):
        meipass = Path(getattr(sys, "_MEIPASS", root))
        bundled = meipass / "web"
        if (bundled / "index.html").is_file():
            return bundled
        if (meipass / "index.html").is_file():
            return meipass
    bundled = root / "web"
    if (bundled / "index.html").is_file():
        return bundled
    return root


ROOT = app_root()
UI_ROOT = ui_root()
PREFERRED_PORT = 8765
IS_FROZEN = getattr(sys, "frozen", False)
APP_TITLE = "Crypto TA Secrets TRADER App"


def ensure_app_icon() -> Path:
    """Materialize baked CryptoKnight ICO next to the app."""
    ico_path = ROOT / "app.ico"
    try:
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        meipass = Path(getattr(sys, "_MEIPASS", ROOT))
        if str(meipass) not in sys.path:
            sys.path.insert(0, str(meipass))
        from embedded_icons import ICO_BASE64

        data = base64.b64decode(ICO_BASE64)
        if (not ico_path.exists()) or ico_path.stat().st_size != len(data):
            ico_path.write_bytes(data)
    except Exception:
        pass
    return ico_path


def ensure_windows_shortcut(ico_path: Path) -> Path | None:
    if sys.platform != "win32":
        return None
    lnk = ROOT / "TRADER_App.lnk"
    try:
        if IS_FROZEN:
            target = str(Path(sys.executable).resolve())
            args = ""
            icon = f"{target},0"
            work = str(ROOT)
        else:
            pythonw = Path(sys.executable)
            if pythonw.name.lower() == "python.exe":
                candidate = pythonw.with_name("pythonw.exe")
                if candidate.exists():
                    pythonw = candidate
            target = str(pythonw)
            args = f'"{ROOT / "hub_app.py"}"'
            icon = f"{ico_path},0"
            work = str(ROOT)

        vbs = f'''
Set sh = CreateObject("WScript.Shell")
Set sc = sh.CreateShortcut("{str(lnk).replace(chr(92), chr(92)+chr(92))}")
sc.TargetPath = "{target.replace(chr(92), chr(92)+chr(92))}"
sc.Arguments = "{args.replace(chr(34), chr(34)+chr(34))}"
sc.WorkingDirectory = "{work.replace(chr(92), chr(92)+chr(92))}"
sc.IconLocation = "{icon.replace(chr(92), chr(92)+chr(92))}"
sc.Description = "{APP_TITLE}"
sc.Save
'''
        vbs_path = ROOT / "_make_shortcut.vbs"
        vbs_path.write_text(vbs, encoding="utf-8")
        os.system(f'cscript //nologo "{vbs_path}" >nul 2>&1')
        try:
            vbs_path.unlink(missing_ok=True)
        except OSError:
            pass
        return lnk if lnk.exists() else None
    except Exception:
        return None


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def choose_port() -> int:
    if port_is_free(PREFERRED_PORT):
        return PREFERRED_PORT
    for port in range(PREFERRED_PORT + 1, PREFERRED_PORT + 20):
        if port_is_free(port):
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def storage_dir() -> str:
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path.home() / ".local" / "share"
    path = base / "TRADER_App" / "webview"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def journal_dir() -> Path:
    path = ROOT / "journals"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_name(name: str) -> str:
    name = (name or "").strip().split("/")[-1].split("\\")[-1]
    if not name:
        return "journal.csv"
    if Path(name).suffix.lower() in {".sqlite", ".db", ".sqlite3"}:
        name = f"{Path(name).stem}.csv"
    if Path(name).suffix.lower() != ".csv":
        name = f"{name}.csv"
    return name


def sqlite_dir() -> Path:
    """Back-compat alias — journals now live in journals/ as CSV."""
    return journal_dir()


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, format, *args):  # noqa: A003
        return


def start_server(directory: Path, port: int) -> ThreadingHTTPServer:
    handler = partial(QuietHandler, directory=str(directory))
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def _msgbox(message: str, title: str = APP_TITLE, error: bool = True) -> None:
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(0, message, title, 0x10 if error else 0x40)
    except Exception:
        print(message, file=sys.stderr)


class Api:
    """Bridge used by js/db.js via window.pywebview.api."""

    def journal_path(self, file_name: str) -> str:
        return str(journal_dir() / _safe_name(file_name))

    def create_journal(self, file_name: str) -> str:
        return self.journal_path(file_name)

    def file_exists(self, path: str) -> bool:
        try:
            return Path(path).is_file()
        except Exception:
            return False

    def read_file(self, path: str) -> str | None:
        try:
            data = Path(path).read_bytes()
            return base64.b64encode(data).decode("ascii")
        except Exception:
            return None

    def write_file(self, path: str, b64: str) -> bool:
        try:
            p = Path(path)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(base64.b64decode(b64))
            return True
        except Exception:
            return False

    def open_file(self) -> str | None:
        import webview

        window = webview.active_window()
        if window is None:
            return None
        result = window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=(
                "CSV journal (*.csv)",
                "Excel CK Trading Journal (*.xlsx;*.xlsm)",
                "Legacy SQLite (*.sqlite;*.db;*.sqlite3)",
                "All files (*.*)",
            ),
        )
        if not result:
            return None
        return str(result[0])

    def link_journal(self) -> dict | None:
        """Pick an existing .csv from journals/, import Excel, or convert legacy SQLite."""
        import webview

        window = webview.active_window()
        if window is None:
            return None
        result = window.create_file_dialog(
            webview.OPEN_DIALOG,
            directory=str(journal_dir()),
            allow_multiple=False,
            file_types=(
                "CSV journal (*.csv)",
                "Excel CK Trading Journal (*.xlsx;*.xlsm)",
                "Legacy SQLite (*.sqlite;*.db;*.sqlite3)",
                "All files (*.*)",
            ),
        )
        if not result:
            return None
        src = Path(result[0])
        if not src.is_file():
            return None

        suffix = src.suffix.lower()
        if suffix == ".csv":
            # Point at the chosen CSV in place (do not copy) so edits save there
            return {
                "path": str(src.resolve()),
                "name": src.name,
                "imported": False,
                "source": str(src.resolve()),
            }

        if suffix in {".xlsx", ".xlsm"}:
            return self.import_excel_journal(str(src))

        if suffix in {".sqlite", ".db", ".sqlite3"}:
            try:
                from excel_journal import sqlite_to_csv
            except ImportError:
                meipass = Path(getattr(sys, "_MEIPASS", ROOT))
                for candidate in (ROOT, meipass):
                    if str(candidate) not in sys.path:
                        sys.path.insert(0, str(candidate))
                from excel_journal import sqlite_to_csv

            dest = journal_dir() / f"{src.stem}.csv"
            info = sqlite_to_csv(src, dest)
            return {
                "path": str(dest.resolve()),
                "name": dest.name,
                "imported": True,
                "source": src.name,
                "trade_count": info.get("trade_count", 0),
                "tradeCount": info.get("trade_count", 0),
            }

        raise ValueError(
            f"Unsupported journal file type: {src.suffix}\n"
            "Choose a .csv journal, or an Excel/.sqlite file to convert."
        )
    def import_excel_journal(self, excel_path: str | None = None) -> dict | None:
        import webview

        if not excel_path:
            window = webview.active_window()
            if window is None:
                return None
            result = window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=("Excel CK Trading Journal (*.xlsx;*.xlsm)", "All files (*.*)"),
            )
            if not result:
                return None
            excel_path = str(result[0])

        src = Path(excel_path)
        if not src.is_file():
            raise FileNotFoundError(f"Excel file not found: {src}")

        try:
            from excel_journal import excel_to_csv
        except ImportError:
            meipass = Path(getattr(sys, "_MEIPASS", ROOT))
            for candidate in (ROOT, meipass, meipass / "web"):
                if str(candidate) not in sys.path:
                    sys.path.insert(0, str(candidate))
            from excel_journal import excel_to_csv

        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        dest_name = f"{src.stem}_{stamp}.csv"
        dest = journal_dir() / dest_name
        info = excel_to_csv(src, dest)
        return {
            "path": str(dest),
            "name": dest.name,
            "imported": True,
            "source": src.name,
            "excel_name": src.name,
            "excel_path": str(src),
            "trade_count": info.get("trade_count", 0),
            "tradeCount": info.get("trade_count", 0),
        }


def main() -> int:
    global UI_ROOT
    UI_ROOT = ui_root()

    ico_path = ensure_app_icon()
    ensure_windows_shortcut(ico_path)
    journal_dir()

    try:
        import webview
    except ImportError:
        _msgbox(
            "Missing dependency: pywebview\n\n"
            "This portable build should include it. Re-copy the full ship folder."
        )
        return 1

    if not (UI_ROOT / "index.html").is_file():
        _msgbox(
            f"Bundled UI not found.\n\nLooked in:\n{UI_ROOT}\n\n"
            "Re-copy the full ship folder (TRADER_App.exe + _internal)."
        )
        return 1

    port = choose_port()
    httpd = start_server(UI_ROOT, port)
    url = f"http://127.0.0.1:{port}/index.html?v=plan2"
    title = APP_TITLE if port == PREFERRED_PORT else f"{APP_TITLE} (port {port})"
    icon_arg = str(ico_path) if ico_path.exists() else None
    api = Api()

    webview.create_window(
        title=title,
        url=url,
        js_api=api,
        width=1360,
        height=900,
        min_size=(900, 600),
        maximized=True,
        background_color="#F8F7F6",
    )

    try:
        webview.start(
            private_mode=False,
            storage_path=storage_dir(),
            icon=icon_arg,
        )
    finally:
        httpd.shutdown()
        httpd.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
