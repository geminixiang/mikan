#!/usr/bin/env python3
"""Measure tracked production src with cached scb-check==0.2.0; no installs.

  python3 scripts/measure-scb.py --ref b811b491d91d5b9aa53501b7fbf84759a9d25186
  python3 scripts/measure-scb.py --hotspots /tmp/mikan-scb-current-hotspots.json

Default: snapshot tracked worktree files, excluding test directories/names.
Outputs report.json, manifest.json, hotspots.json and an immutable input copy
in a new temporary directory. Exit 0 means measurement succeeded, NOT that
quality goals passed; the original scb CLI exit code is recorded in manifest.
--ref uses the named commit's file list AND contents, independent of worktree.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

VERSION = "0.2.0"
UV = ["uvx", "--offline", "--from", f"scb-check=={VERSION}"]
EXCLUDED_DIRS = {"test", "tests", "__tests__", "__snapshots__"}


def dump(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def worker(directory):
    from importlib.metadata import version
    from scb_check.config import Config
    from scb_check.pipeline import analyze
    from scb_check.reporting.score import compute_report

    assert version("scb-check") == VERSION
    root = (directory / "input").resolve()
    result = analyze(root, Config(exclude=(), base_dir=root), disable_sg=True)
    report = compute_report(result.flags).to_dict()
    assert report == json.loads((directory / "report.json").read_text()), "CLI/API mismatch"
    rows = [
        dict(file=str(f.file.relative_to(root)), name=f.name,
             line=f.start_line, end_line=f.end_line, sloc=f.sloc,
             cc=f.cyc_complexity, cognitive=f.cog_complexity,
             cc_mass=f.cc_mass(), cognitive_mass=f.cog_mass(),
             high_cc=f.is_high_cc(), high_cognitive=f.is_high_cog())
        for f in result.flags.findings.all_functions
    ]
    manifest = json.loads((directory / "manifest.json").read_text())
    dump(directory / "hotspots.json", dict(
        version=VERSION, commit=manifest["commit"], source=manifest["source"],
        report=report, mass_formula="complexity * sqrt(function SLOC)",
        high_cc_by_mass=sorted((r for r in rows if r["high_cc"]), key=lambda r: -r["cc_mass"]),
        high_cognitive_by_mass=sorted((r for r in rows if r["high_cognitive"]), key=lambda r: -r["cognitive_mass"]),
        all_by_cc=sorted(rows, key=lambda r: -r["cc"]),
        all_by_cognitive=sorted(rows, key=lambda r: -r["cognitive"]),
    ))
    dump(directory / "scanned-files.json", [
        dict(file=str(p.relative_to(root)), sloc=loc)
        for p, loc in result.flags.lines.total_loc_by_file
    ])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", help="Read committed paths and contents instead of worktree")
    parser.add_argument("--hotspots", type=Path, help="Also publish hotspot JSON at this path")
    parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        worker(args.worker)
        return
    repo = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())

    def git(*arguments):
        return subprocess.check_output(["git", "-C", str(repo), *arguments])

    commit = git("rev-parse", "--verify", f"{args.ref or 'HEAD'}^{{commit}}").decode().strip()
    paths = git("ls-tree", "-r", "--name-only", "-z", commit, "--", "src/") if args.ref else git("ls-files", "-z", "--", "src/")
    directory = Path(tempfile.mkdtemp(prefix="mikan-scb-")).resolve()
    root = directory / "input"
    root.mkdir()
    included, excluded, missing = [], [], []
    for name in sorted(set(os.fsdecode(p) for p in paths.split(b"\0") if p)):
        path = Path(name)
        if EXCLUDED_DIRS.intersection(path.parts[:-1]) or ".test." in path.name or ".spec." in path.name:
            excluded.append(name)
            continue
        source = repo / path
        if not args.ref and not source.exists():
            missing.append(name)
            continue
        if not args.ref and source.is_symlink():
            raise RuntimeError(f"Refusing source symlink: {name}")
        data = git("show", f"{commit}:{name}") if args.ref else source.read_bytes()
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        included.append(dict(path=name, sha256=hashlib.sha256(data).hexdigest(), bytes=len(data)))
    if not args.ref:
        changed = [entry["path"] for entry in included
                   if not (repo / entry["path"]).is_file()
                   or hashlib.sha256((repo / entry["path"]).read_bytes()).hexdigest() != entry["sha256"]]
        if changed:
            raise RuntimeError(f"Worktree changed during snapshot; retry: {changed}")
    manifest = dict(version=VERSION, commit=commit, source="commit" if args.ref else "worktree",
                    excluded_directories=sorted(EXCLUDED_DIRS), excluded_filename_substrings=[".test.", ".spec."],
                    included=included, excluded=excluded, tracked_missing=missing,
                    git_status=git("status", "--porcelain", "--", "src/").decode(),
                    note="total_loc is scanner SLOC, not physical lines; unsupported files remain in snapshot")
    # Explicit empty config prevents inherited user/temp-directory exclusions.
    config = directory / "scb-check.toml"
    config.write_text("exclude = []\n")
    command = UV + ["scb-check", "check", str(root), "--config", str(config),
                    "--disable-sg", "--output-format", "json"]
    with (directory / "report.json").open("w") as stdout, (directory / "stderr.log").open("w") as stderr:
        result = subprocess.run(command, cwd=directory, stdout=stdout, stderr=stderr)
    manifest.update(command=command, cli_exit_code=result.returncode,
                    cli_exit_meaning="0=no findings; 1=findings present (valid report); 2=analysis/config error")
    dump(directory / "manifest.json", manifest)
    print(directory, flush=True)
    if result.returncode not in (0, 1):
        raise RuntimeError(f"scb-check failed: see {directory / 'stderr.log'}")
    subprocess.run(UV + ["python", str(Path(__file__).resolve()), "--worker", str(directory)], cwd=directory, check=True)
    if args.hotspots:
        args.hotspots.write_bytes((directory / "hotspots.json").read_bytes())
    print((directory / "report.json").read_text())


if __name__ == "__main__":
    main()
