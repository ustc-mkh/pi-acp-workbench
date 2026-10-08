"""Export resource curves from two service-soak runs (requires matplotlib)."""
import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, required=True)
args = parser.parse_args()
fig, axes = plt.subplots(2, 2, figsize=(12, 6.5), sharex="col", constrained_layout=True)
summary = {}
for column, (name, title) in enumerate([
    ("soak", "Scheduled restart recovery"),
    ("soak-continuous", "Same processes throughout"),
]):
    directory = args.root / name
    samples = [json.loads(line) for line in (directory / "samples.jsonl").read_text().splitlines()]
    result = json.loads((directory / "result.json").read_text()) if (directory / "result.json").exists() else None
    entry = {"complete": bool(result and result.get("passed")), "lastElapsedSeconds": samples[-1]["elapsedSeconds"]}
    if result:
        entry["counters"] = result["counters"]
        entry["elapsedSeconds"] = result["elapsedSeconds"]
    entry["resources"] = {}
    times = [sample["elapsedSeconds"] / 60 for sample in samples]
    for kind, color in [("service", "#1764b4"), ("relay", "#d26714")]:
        rows = [sample[kind] for sample in samples]
        idle = [sample[kind] for sample in samples if sample["phase"] in ["idle", "final"]]
        axes[0, column].plot(times, [row["rssKiB"] / 1024 for row in rows], color=color, lw=1.3, label=kind)
        axes[1, column].plot(times, [row["fd"] for row in rows], color=color, lw=0.7, alpha=0.8, label=kind)
        pids = list(dict.fromkeys(row["pid"] for row in rows))
        entry["resources"][kind] = {
            "pids": pids,
            "rssMinKiB": min(row["rssKiB"] for row in rows),
            "rssMaxKiB": max(row["rssKiB"] for row in rows),
            "rssFinalKiB": rows[-1]["rssKiB"],
            "fdMax": max(row["fd"] for row in rows),
            "fdFinal": rows[-1]["fd"],
            "idleFdMax": max(row["fd"] for row in idle) if idle else None,
            "workersMax": max(len(row["workers"]) for row in rows),
        }
    for i in range(1, len(samples)):
        if samples[i]["service"]["pid"] != samples[i - 1]["service"]["pid"]:
            for row in axes:
                row[column].axvline(times[i], color="#527e52", ls=":", lw=1)
    axes[0, column].set_title(title + (" (complete)" if entry["complete"] else " (running)"))
    axes[0, column].legend(loc="upper right")
    axes[1, column].set_xlabel("Elapsed time (minutes)")
    axes[1, column].set_ylim(0, 32)
    axes[1, column].set_yticks([0, 8, 16, 24, 32])
    for row in axes:
        row[column].set_xlim(0, 120)
        row[column].set_xticks([0, 30, 60, 90, 120])
        row[column].grid(alpha=0.2)
    summary[name] = entry
axes[0, 0].set_ylabel("Resident memory (MiB)")
axes[1, 0].set_ylabel("Open file descriptors")
fig.suptitle("Rust service acceptance: real daemons, mock ACP/Bot, 2 workers maximum")
fig.savefig(args.root / "resource-curves.png", dpi=180)
fig.savefig(args.root / "resource-curves.svg")
(args.root / "resource-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, separators=(",", ":")))
