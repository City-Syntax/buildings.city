"""Local path bootstrap for the simulation-service IDF generator."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SERVICE_ROOT = ROOT.parent

# Ladybug writes a log during import. Keep it in temp so the service app folder
# stays source-only.
LOCAL_HOME = Path(tempfile.gettempdir()) / "citysyntax-idf-generator-home"
os.environ.setdefault("HOME", str(LOCAL_HOME))
LOCAL_HOME.mkdir(parents=True, exist_ok=True)

SITE_PACKAGES = SERVICE_ROOT / ".venv" / "Lib" / "site-packages"
if SITE_PACKAGES.exists():
    sys.path.append(str(SITE_PACKAGES))

ENERGYPLUS_STUB = SERVICE_ROOT / "energyplus_stub" / "EnergyPlus-22-2-0"
if ENERGYPLUS_STUB.exists():
    try:
        from archetypal import settings

        settings.energyplus_location = str(ENERGYPLUS_STUB)
        settings.ep_version = "22-2-0"
    except Exception:
        # The generator can still export ZoneComponent JSON without archetypal.
        pass
