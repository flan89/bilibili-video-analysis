#!/usr/bin/env python3
"""经 setup --apply 授权后下载固定版本模型，并原子写入运行状态。"""
import argparse
import json
import os
import platform
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from modelscope.hub.snapshot_download import snapshot_download


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--state-file", required=True)
    args = parser.parse_args()

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    models_dir = Path(args.models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)
    prepared = {}
    for model in manifest["models"]:
        print(
            f"[setup] 准备模型 {model['id']}@{model['revision']}",
            flush=True,
        )
        model_path = snapshot_download(
            model["id"],
            revision=model["revision"],
            cache_dir=str(models_dir),
        )
        prepared[model["key"]] = {
            "id": model["id"],
            "revision": model["revision"],
            "path": str(Path(model_path).resolve()),
        }

    state = {
        "runtimeManifestVersion": manifest["runtimeManifestVersion"],
        "asrEnvironmentVersion": manifest["asrEnvironmentVersion"],
        "preparedAt": datetime.now(timezone.utc).isoformat(),
        "pythonVersion": platform.python_version(),
        "models": prepared,
    }
    state_file = Path(args.state_file)
    state_file.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix="runtime-", suffix=".json", dir=state_file.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
        os.replace(temp_name, state_file)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    print(json.dumps(state, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
