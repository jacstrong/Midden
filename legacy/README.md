# Legacy prototypes

These are the two single-shot prototypes Midden v2 grew from. They are kept here as
parity oracles while the new packages are built and will be removed once the new
tool covers everything they do.

- `midden_attack_timeline.html` — the original single-file attack timeline tool.
  Open it in a browser. State lives in memory; save/load via `.json` case files.
- `nmap2map.py` — standard-library Python CLI that turns nmap `-oX`/`-oN` output
  into a self-contained HTML network map. `python3 nmap2map.py scan.xml --json out.json`
  is used by the core package's parser parity tests.
