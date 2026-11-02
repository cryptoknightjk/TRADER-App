Crypto TA Secrets TRADER App — Working copy (Windows)
=======================================================

Journals use portable CSV files (not SQLite).

How to launch
-------------
  Double-click  TRADER_App.lnk     (recommended shortcut)
  or            TRADER_App.exe

Needs Windows 10/11. If the window is blank, install WebView2 Runtime:
https://developer.microsoft.com/microsoft-edge/webview2/

Journals (journals folder)
--------------------------
  journals\default_journal.csv
  journals\<name>.csv

Link Existing Journal can point to any .csv, import Excel (.xlsx),
or convert a legacy .sqlite into .csv.

Keep together
-------------
  TRADER_App.exe
  TRADER_App.lnk
  _internal\
  journals\
  index.html, css\, js\     (live UI used by this working copy)
  excel_journal.py, hub_app.py, embedded_icons.py, app.ico
  build_local_exe.py        (rebuild the .exe after code changes)
  build_ship.py             (optional ship package)
