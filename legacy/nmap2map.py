#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nmap2map.py - turn nmap scan output into a single self-contained HTML network map.

No third-party packages. Standard library only. Runs on Python 3.6+.

Typical use:

    nmap -sS -sV -O -T4 --traceroute -oX scan.xml 10.0.0.0/24
    python3 nmap2map.py scan.xml -o network-map.html

Then open network-map.html in any browser. The file is fully self-contained
(no internet, no CDN, no fonts to fetch), so it is safe to hand off, email,
or drop into a report.

Input formats accepted:
    *.xml   nmap -oX   (preferred - has OS matches, service versions, traceroute)
    *.txt   nmap -oN   (fallback parser, best-effort)
    -       read from stdin

Layouts:
    --layout subnet   hosts clustered around their /24 (default)
    --layout trace    real topology built from --traceroute hop data
"""

from __future__ import print_function

import argparse
import html
import ipaddress
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET

__version__ = "1.0"

# --------------------------------------------------------------------------
# Palette. Deep instrument-panel slate, signal colors reserved for meaning.
# --------------------------------------------------------------------------

OS_COLORS = [
    ("Windows",        "#5aa9ff"),
    ("Linux / Unix",   "#f0a04b"),
    ("Apple",          "#b98cff"),
    ("Network device", "#3fd0a8"),
    ("Printer",        "#ff7fb2"),
    ("Hypervisor",     "#63e0f0"),
    ("Embedded / IoT", "#e3cf4a"),
    ("Unknown",        "#7b8797"),
]
OS_COLOR_MAP = dict(OS_COLORS)

# Services worth flagging on a baseline: cleartext, legacy, or high-value
# remote access. Nothing here is an exploit hint - it is an inventory flag.
NOTABLE_PORTS = {
    21:   "FTP (cleartext credentials)",
    23:   "Telnet (cleartext credentials)",
    69:   "TFTP (no authentication)",
    79:   "Finger (legacy)",
    111:  "rpcbind exposed",
    135:  "MSRPC exposed",
    139:  "NetBIOS / SMBv1 era",
    161:  "SNMP (check for public community)",
    389:  "LDAP (cleartext)",
    445:  "SMB exposed",
    512:  "rexec (legacy cleartext)",
    513:  "rlogin (legacy cleartext)",
    514:  "rsh (legacy cleartext)",
    1433: "MSSQL exposed",
    1521: "Oracle DB exposed",
    2049: "NFS exposed",
    3306: "MySQL exposed",
    3389: "RDP exposed",
    5432: "PostgreSQL exposed",
    5900: "VNC exposed",
    5901: "VNC exposed",
    6379: "Redis (often unauthenticated)",
    11211: "memcached (often unauthenticated)",
    27017: "MongoDB (often unauthenticated)",
}

ROLE_RULES = [
    ("Domain controller", lambda p: {88, 389, 445} <= p or {88, 464, 445} <= p),
    ("Hypervisor",        lambda p: 902 in p or 5989 in p),
    ("Printer",           lambda p: bool(p & {9100, 515, 631})),
    ("Database",          lambda p: bool(p & {1433, 1521, 3306, 5432, 27017, 6379})),
    ("Mail server",       lambda p: bool(p & {25, 110, 143, 465, 587, 993, 995})),
    ("DNS server",        lambda p: 53 in p),
    ("Web server",        lambda p: bool(p & {80, 443, 8080, 8443, 8000})),
    ("File / SMB",        lambda p: bool(p & {445, 139, 2049})),
    ("Remote desktop",    lambda p: bool(p & {3389, 5900})),
    ("SSH host",          lambda p: 22 in p),
]


# --------------------------------------------------------------------------
# Host record
# --------------------------------------------------------------------------

def new_host():
    return {
        "ip": "",
        "ipv6": "",
        "mac": "",
        "vendor": "",
        "hostnames": [],
        "state": "up",
        "reason": "",
        "latency": "",
        "distance": None,
        "ports": [],          # list of dicts
        "os_name": "",
        "os_accuracy": "",
        "os_family": "",
        "os_vendor": "",
        "os_type": "",
        "trace": [],          # list of {ttl, ip, host, rtt}
        "scripts": [],        # list of {id, output}
        "uptime": "",
    }


# --------------------------------------------------------------------------
# XML parser  (nmap -oX)
# --------------------------------------------------------------------------

def parse_xml(text, open_only=True, min_accuracy=0):
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise SystemExit("Could not parse XML: %s\n"
                         "If this is a text scan, run nmap with -oX, or pass "
                         "--format text." % exc)

    meta = {
        "args": root.get("args", ""),
        "start": root.get("startstr", ""),
        "version": root.get("version", ""),
    }
    fin = root.find("runstats/finished")
    if fin is not None:
        meta["elapsed"] = fin.get("elapsed", "")
        meta["end"] = fin.get("timestr", "")

    hosts = []
    for hnode in root.findall("host"):
        st = hnode.find("status")
        state = st.get("state", "unknown") if st is not None else "unknown"
        if state != "up":
            continue

        h = new_host()
        h["state"] = state
        if st is not None:
            h["reason"] = st.get("reason", "")

        for addr in hnode.findall("address"):
            kind = addr.get("addrtype", "")
            if kind == "ipv4":
                h["ip"] = addr.get("addr", "")
            elif kind == "ipv6":
                h["ipv6"] = addr.get("addr", "")
            elif kind == "mac":
                h["mac"] = addr.get("addr", "")
                h["vendor"] = addr.get("vendor", "")

        if not h["ip"] and h["ipv6"]:
            h["ip"] = h["ipv6"]
        if not h["ip"]:
            continue

        for hn in hnode.findall("hostnames/hostname"):
            name = hn.get("name", "")
            if name and name not in h["hostnames"]:
                h["hostnames"].append(name)

        times = hnode.find("times")
        if times is not None and times.get("srtt"):
            try:
                h["latency"] = "%.1f ms" % (int(times.get("srtt")) / 1000.0)
            except ValueError:
                pass

        dist = hnode.find("distance")
        if dist is not None and dist.get("value"):
            try:
                h["distance"] = int(dist.get("value"))
            except ValueError:
                pass

        up = hnode.find("uptime")
        if up is not None and up.get("lastboot"):
            h["uptime"] = up.get("lastboot")

        for p in hnode.findall("ports/port"):
            pstate = p.find("state")
            sstate = pstate.get("state", "") if pstate is not None else ""
            if open_only and not sstate.startswith("open"):
                continue
            svc = p.find("service")
            rec = {
                "port": int(p.get("portid", "0")),
                "proto": p.get("protocol", "tcp"),
                "state": sstate,
                "name": svc.get("name", "") if svc is not None else "",
                "product": svc.get("product", "") if svc is not None else "",
                "version": svc.get("version", "") if svc is not None else "",
                "extra": svc.get("extrainfo", "") if svc is not None else "",
                "tunnel": svc.get("tunnel", "") if svc is not None else "",
            }
            h["ports"].append(rec)
        h["ports"].sort(key=lambda r: (r["proto"], r["port"]))

        best = None
        for m in hnode.findall("os/osmatch"):
            try:
                acc = int(m.get("accuracy", "0"))
            except ValueError:
                acc = 0
            if acc < min_accuracy:
                continue
            if best is None or acc > best[0]:
                best = (acc, m)
        if best is not None:
            acc, m = best
            h["os_name"] = m.get("name", "")
            h["os_accuracy"] = str(acc)
            cls = m.find("osclass")
            if cls is not None:
                h["os_family"] = cls.get("osfamily", "")
                h["os_vendor"] = cls.get("vendor", "")
                h["os_type"] = cls.get("type", "")
        if not h["os_name"]:
            cls = hnode.find("os/osclass")
            if cls is not None:
                h["os_family"] = cls.get("osfamily", "")
                h["os_vendor"] = cls.get("vendor", "")
                h["os_type"] = cls.get("type", "")
                h["os_name"] = ("%s %s" % (cls.get("vendor", ""),
                                           cls.get("osfamily", ""))).strip()

        for tr in hnode.findall("trace"):
            for hop in tr.findall("hop"):
                h["trace"].append({
                    "ttl": int(hop.get("ttl", "0") or 0),
                    "ip": hop.get("ipaddr", ""),
                    "host": hop.get("host", ""),
                    "rtt": hop.get("rtt", ""),
                })
            h["trace"].sort(key=lambda x: x["ttl"])

        for s in hnode.findall("hostscript/script"):
            h["scripts"].append({
                "id": s.get("id", ""),
                "output": (s.get("output", "") or "").strip(),
            })

        hosts.append(h)

    return hosts, meta


# --------------------------------------------------------------------------
# Text parser  (nmap -oN) - best effort fallback
# --------------------------------------------------------------------------

RE_REPORT = re.compile(r"^Nmap scan report for (?:(\S+) \(([\d\.:a-fA-F]+)\)|([\d\.:a-fA-F]+))\s*$")
RE_PORT = re.compile(r"^(\d+)/(tcp|udp|sctp)\s+(\S+)\s+(\S+)(?:\s+(.*))?$")
RE_MAC = re.compile(r"^MAC Address:\s+([0-9A-Fa-f:]{17})\s*(?:\((.*)\))?")
RE_OSDET = re.compile(r"^(?:OS details|Aggressive OS guesses|Running):\s*(.+)$")
RE_LAT = re.compile(r"^Host is up.*?\(([\d\.]+)s latency\)")
RE_DIST = re.compile(r"^Network Distance:\s+(\d+) hop")
RE_HOP = re.compile(r"^(\d+)\s+([\d\.]+ ms|\.\.\.)\s+(\S+)(?:\s+\(([\d\.]+)\))?")


def parse_text(text, open_only=True, **_kw):
    hosts = []
    cur = None
    in_trace = False
    meta = {"args": "", "start": "", "version": ""}

    for raw in text.splitlines():
        line = raw.rstrip()
        m = re.match(r"^# Nmap (\S+) scan initiated (.+?) as: (.+)$", line)
        if m:
            meta["version"], meta["start"], meta["args"] = m.group(1), m.group(2), m.group(3)
            continue

        m = RE_REPORT.match(line)
        if m:
            if cur:
                hosts.append(cur)
            cur = new_host()
            in_trace = False
            if m.group(3):
                cur["ip"] = m.group(3)
            else:
                cur["hostnames"] = [m.group(1)]
                cur["ip"] = m.group(2)
            continue

        if cur is None:
            continue

        if line.startswith("TRACEROUTE"):
            in_trace = True
            continue
        if in_trace:
            m = RE_HOP.match(line.strip())
            if m:
                hop_ip = m.group(4) or m.group(3)
                cur["trace"].append({"ttl": int(m.group(1)), "ip": hop_ip,
                                     "host": m.group(3) if m.group(4) else "",
                                     "rtt": m.group(2)})
                continue
            if not line.strip():
                in_trace = False

        m = RE_LAT.match(line)
        if m:
            cur["latency"] = "%.1f ms" % (float(m.group(1)) * 1000)
            continue

        m = RE_MAC.match(line)
        if m:
            cur["mac"] = m.group(1)
            cur["vendor"] = m.group(2) or ""
            continue

        m = RE_DIST.match(line)
        if m:
            cur["distance"] = int(m.group(1))
            continue

        m = RE_OSDET.match(line)
        if m and not cur["os_name"]:
            cur["os_name"] = m.group(1).split(",")[0].strip()
            continue

        m = RE_PORT.match(line)
        if m:
            state = m.group(3)
            if open_only and not state.startswith("open"):
                continue
            cur["ports"].append({
                "port": int(m.group(1)), "proto": m.group(2), "state": state,
                "name": m.group(4), "product": (m.group(5) or "").strip(),
                "version": "", "extra": "", "tunnel": "",
            })
            continue

    if cur:
        hosts.append(cur)
    for h in hosts:
        h["ports"].sort(key=lambda r: (r["proto"], r["port"]))
    return hosts, meta


# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------

def classify(h):
    """Assign an OS bucket, a role guess, and any notable exposures."""
    blob = " ".join([h["os_name"], h["os_family"], h["os_vendor"],
                     h["os_type"], h["vendor"]]).lower()
    svc_blob = " ".join(p["name"] + " " + p["product"] for p in h["ports"]).lower()
    ports = set(p["port"] for p in h["ports"] if p["proto"] == "tcp")

    bucket = "Unknown"
    if any(k in blob for k in ("windows", "microsoft")):
        bucket = "Windows"
    elif any(k in blob for k in ("mac os", "macos", "os x", "apple", "ios", "darwin")):
        bucket = "Apple"
    elif any(k in blob for k in ("vmware", "esxi", "hyper-v", "xen", "proxmox", "kvm")):
        bucket = "Hypervisor"
    elif any(k in blob for k in ("printer", "jetdirect", "lexmark", "ricoh",
                                 "brother", "xerox", "canon")):
        bucket = "Printer"
    elif any(k in blob for k in ("cisco", "juniper", "mikrotik", "ubiquiti", "aruba",
                                 "fortinet", "palo alto", "netgear", "tp-link",
                                 "d-link", "arista", "router", "switch", "firewall",
                                 "ios-xe", "ios xe", "wap", "access point", "pfsense",
                                 "openwrt", "dd-wrt", "vyos", "sonicwall")):
        bucket = "Network device"
    elif any(k in blob for k in ("linux", "unix", "bsd", "solaris", "aix", "ubuntu",
                                 "debian", "centos", "red hat", "rhel", "fedora")):
        bucket = "Linux / Unix"
    elif any(k in blob for k in ("embedded", "webcam", "camera", "phone", "voip",
                                 "media device", "game console", "storage-misc",
                                 "specialized")):
        bucket = "Embedded / IoT"

    # Fall back to service fingerprints when no OS match came back.
    if bucket == "Unknown":
        if ports & {3389, 135, 139} and 445 in ports:
            bucket = "Windows"
        elif "jetdirect" in svc_blob or ports & {9100, 515, 631}:
            bucket = "Printer"
        elif "openssh" in svc_blob:
            bucket = "Linux / Unix"

    role = ""
    for name, test in ROLE_RULES:
        if test(ports):
            role = name
            break
    if not role and h["distance"] == 1 and h["ip"].endswith(".1"):
        role = "Likely gateway"

    flags = []
    for p in h["ports"]:
        note = NOTABLE_PORTS.get(p["port"])
        if note and p["proto"] == "tcp":
            flags.append("%d/%s - %s" % (p["port"], p["proto"], note))

    h["bucket"] = bucket
    h["role"] = role
    h["flags"] = flags
    h["open_count"] = len(h["ports"])
    return h


def sort_key(ip):
    try:
        return (0,) + tuple(int(x) for x in ip.split("."))
    except (ValueError, AttributeError):
        return (1, ip)


def subnet_of(ip, bits=24):
    try:
        net = ipaddress.ip_network(u"%s/%d" % (ip, bits), strict=False)
        return str(net)
    except ValueError:
        try:
            net = ipaddress.ip_network(u"%s/64" % ip, strict=False)
            return str(net)
        except ValueError:
            return "unknown"


# --------------------------------------------------------------------------
# Layout
# --------------------------------------------------------------------------

def node_radius(h):
    return 9 + min(13.0, 2.6 * math.sqrt(h["open_count"]))


def layout_subnet(hosts, bits=24):
    """Hosts on concentric rings around their subnet hub; hubs on a big ring."""
    groups = {}
    for i, h in enumerate(hosts):
        groups.setdefault(subnet_of(h["ip"], bits), []).append(i)

    keys = sorted(groups.keys(), key=lambda k: sort_key(k.split("/")[0]))

    clusters = []
    for k in keys:
        idxs = sorted(groups[k], key=lambda i: sort_key(hosts[i]["ip"]))
        rings = []
        remaining = len(idxs)
        r = 120.0
        while remaining > 0:
            cap = max(6, int((2 * math.pi * r) / 74.0))
            take = min(cap, remaining)
            rings.append((r, take))
            remaining -= take
            r += 82.0
        outer = rings[-1][0] if rings else 120.0
        clusters.append({"key": k, "idxs": idxs, "rings": rings,
                         "radius": outer + 58.0})

    nodes = []
    edges = []

    if len(clusters) == 1:
        centers = [(0.0, 0.0)]
        root = None
    else:
        total = sum(c["radius"] * 2.25 for c in clusters)
        R = max(total / (2 * math.pi), 340.0)
        centers = []
        for i, c in enumerate(clusters):
            ang = 2 * math.pi * i / len(clusters) - math.pi / 2
            centers.append((R * math.cos(ang), R * math.sin(ang)))
        root = {"id": "root", "kind": "root", "x": 0.0, "y": 0.0, "r": 26.0,
                "label": "scan", "sub": "%d subnets" % len(clusters),
                "color": "#e6edf6", "host": -1}
        nodes.append(root)

    for c, (cx, cy) in zip(clusters, centers):
        hub_id = "net:" + c["key"]
        nodes.append({"id": hub_id, "kind": "subnet", "x": cx, "y": cy, "r": 21.0,
                      "label": c["key"], "sub": "%d hosts" % len(c["idxs"]),
                      "color": "#9fb0c4", "host": -1})
        if root is not None:
            edges.append({"a": "root", "b": hub_id, "kind": "trunk"})

        pos = 0
        for ring_r, count in c["rings"]:
            for j in range(count):
                idx = c["idxs"][pos]
                pos += 1
                ang = 2 * math.pi * j / count - math.pi / 2
                h = hosts[idx]
                nid = "h:%d" % idx
                nodes.append({
                    "id": nid, "kind": "host",
                    "x": cx + ring_r * math.cos(ang),
                    "y": cy + ring_r * math.sin(ang),
                    "r": node_radius(h),
                    "label": ("." + h["ip"].split(".")[-1]) if "." in h["ip"] else h["ip"],
                    "sub": (h["hostnames"][0].split(".")[0] if h["hostnames"] else ""),
                    "color": OS_COLOR_MAP.get(h["bucket"], "#7b8797"),
                    "host": idx,
                })
                edges.append({"a": hub_id, "b": nid, "kind": "link"})
    return nodes, edges


def layout_trace(hosts):
    """Build real topology from --traceroute hop data. Depth = column."""
    have = [h for h in hosts if h["trace"]]
    if not have:
        return None, None

    by_ip = {}
    for i, h in enumerate(hosts):
        by_ip[h["ip"]] = i

    parent = {}
    children = {"root": []}
    label = {}

    def ensure(nid, lbl):
        if nid not in children:
            children[nid] = []
            label[nid] = lbl

    for i, h in enumerate(hosts):
        chain = []
        for hop in h["trace"]:
            if hop["ip"] and hop["ip"] != h["ip"]:
                chain.append(hop["ip"])
        prev = "root"
        for hop_ip in chain:
            if hop_ip in by_ip:
                nid = "h:%d" % by_ip[hop_ip]
            else:
                nid = "r:" + hop_ip
                ensure(nid, hop_ip)
            if nid not in parent:
                parent[nid] = prev
                children.setdefault(prev, []).append(nid)
            prev = nid
        nid = "h:%d" % i
        ensure(nid, h["ip"])
        if nid not in parent:
            parent[nid] = prev
            children.setdefault(prev, []).append(nid)

    for i, h in enumerate(hosts):
        nid = "h:%d" % i
        if nid not in parent:
            ensure(nid, h["ip"])
            parent[nid] = "root"
            children["root"].append(nid)

    order = []

    def walk(nid, depth):
        kids = children.get(nid, [])
        if not kids:
            order.append((nid, depth))
            return
        for k in kids:
            walk(k, depth + 1)
        order.append((nid, depth))

    walk("root", 0)

    slot = {}
    row = [0.0]

    def assign(nid, depth):
        kids = children.get(nid, [])
        if not kids:
            slot[nid] = row[0]
            row[0] += 1
            return slot[nid]
        ys = [assign(k, depth + 1) for k in kids]
        slot[nid] = sum(ys) / float(len(ys))
        return slot[nid]

    assign("root", 0)
    depth_of = {}
    for nid, d in order:
        depth_of[nid] = d

    nodes = [{"id": "root", "kind": "root", "x": 0.0, "y": slot["root"] * 62.0,
              "r": 24.0, "label": "scanner", "sub": "hop 0",
              "color": "#e6edf6", "host": -1}]
    edges = []
    for nid in children:
        if nid == "root":
            continue
        d = depth_of.get(nid, 1)
        y = slot.get(nid, 0.0) * 62.0
        x = d * 250.0
        if nid.startswith("h:"):
            idx = int(nid[2:])
            h = hosts[idx]
            nodes.append({"id": nid, "kind": "host", "x": x, "y": y,
                          "r": node_radius(h), "label": h["ip"],
                          "sub": (h["hostnames"][0].split(".")[0] if h["hostnames"] else ""),
                          "color": OS_COLOR_MAP.get(h["bucket"], "#7b8797"),
                          "host": idx})
        else:
            nodes.append({"id": nid, "kind": "router", "x": x, "y": y, "r": 15.0,
                          "label": label.get(nid, nid), "sub": "hop %d" % d,
                          "color": "#9fb0c4", "host": -1})
    for nid, par in parent.items():
        edges.append({"a": par, "b": nid,
                      "kind": "trunk" if not nid.startswith("h:") else "link"})
    return nodes, edges


# --------------------------------------------------------------------------
# Render
# --------------------------------------------------------------------------

def bounds(nodes, pad=90.0):
    xs = [n["x"] for n in nodes] or [0.0]
    ys = [n["y"] for n in nodes] or [0.0]
    rs = max([n["r"] for n in nodes] or [10.0])
    minx, maxx = min(xs) - rs - pad, max(xs) + rs + pad
    miny, maxy = min(ys) - rs - pad, max(ys) + rs + pad * 0.6
    return minx, miny, maxx - minx, maxy - miny


def build_svg(nodes, edges, hosts):
    pos = {}
    for n in nodes:
        pos[n["id"]] = n
    vx, vy, vw, vh = bounds(nodes)

    out = []
    out.append('<svg id="map" viewBox="%.1f %.1f %.1f %.1f" '
               'xmlns="http://www.w3.org/2000/svg" '
               'preserveAspectRatio="xMidYMid meet">' % (vx, vy, vw, vh))
    out.append('<g id="viewport">')

    out.append('<g id="edges">')
    for e in edges:
        a, b = pos.get(e["a"]), pos.get(e["b"])
        if not a or not b:
            continue
        cls = "edge trunk" if e["kind"] == "trunk" else "edge"
        out.append('<line class="%s" x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" '
                   'data-a="%s" data-b="%s"/>'
                   % (cls, a["x"], a["y"], b["x"], b["y"],
                      html.escape(e["a"], True), html.escape(e["b"], True)))
    out.append('</g>')

    out.append('<g id="nodes">')
    for n in nodes:
        idx = n["host"]
        flagged = idx >= 0 and hosts[idx]["flags"]
        cls = "node " + n["kind"] + (" flagged" if flagged else "")
        out.append('<g class="%s" data-id="%s" data-host="%d" transform="translate(%.1f,%.1f)" '
                   'tabindex="0" role="button" aria-label="%s">'
                   % (cls, html.escape(n["id"], True), idx, n["x"], n["y"],
                      html.escape(n["label"] + " " + n["sub"], True)))
        if idx >= 0:
            h = hosts[idx]
            tip = h["ip"]
            if h["hostnames"]:
                tip += "  " + h["hostnames"][0]
            tip += "\n%s%s\n%d open port%s" % (
                h["bucket"], "  |  " + h["role"] if h["role"] else "",
                h["open_count"], "" if h["open_count"] == 1 else "s")
            out.append('<title>%s</title>' % html.escape(tip))
        out.append('<circle class="halo" r="%.1f"/>' % (n["r"] + 9))
        if flagged:
            out.append('<circle class="ring" r="%.1f"/>' % (n["r"] + 4.5))
        out.append('<circle class="dot" r="%.1f" fill="%s"/>' % (n["r"], n["color"]))
        if n["kind"] in ("subnet", "root", "router"):
            out.append('<circle class="inner" r="%.1f"/>' % (n["r"] * 0.42))
        out.append('<text class="lbl" y="%.1f">%s</text>'
                   % (n["r"] + 15, html.escape(n["label"])))
        if n["sub"]:
            out.append('<text class="sub" y="%.1f">%s</text>'
                       % (n["r"] + 27, html.escape(n["sub"][:22])))
        out.append('</g>')
    out.append('</g></g></svg>')
    return "\n".join(out)


def summarize(hosts):
    svc = {}
    for h in hosts:
        for p in h["ports"]:
            key = p["name"] or ("%d/%s" % (p["port"], p["proto"]))
            svc[key] = svc.get(key, 0) + 1
    top = sorted(svc.items(), key=lambda kv: (-kv[1], kv[0]))[:8]
    buckets = {}
    for h in hosts:
        buckets[h["bucket"]] = buckets.get(h["bucket"], 0) + 1
    return {
        "hosts": len(hosts),
        "open_ports": sum(h["open_count"] for h in hosts),
        "flagged": sum(1 for h in hosts if h["flags"]),
        "subnets": len(set(subnet_of(h["ip"]) for h in hosts)),
        "top_services": top,
        "buckets": buckets,
    }


def render_html(hosts, nodes, edges, meta, title, layout_name):
    stats = summarize(hosts)
    payload = {
        "hosts": [{
            "ip": h["ip"], "ipv6": h["ipv6"], "mac": h["mac"], "vendor": h["vendor"],
            "hostnames": h["hostnames"], "latency": h["latency"],
            "distance": h["distance"], "os": h["os_name"], "acc": h["os_accuracy"],
            "bucket": h["bucket"], "role": h["role"], "flags": h["flags"],
            "uptime": h["uptime"],
            "ports": h["ports"], "scripts": h["scripts"],
            "trace": h["trace"],
        } for h in hosts],
        "legend": OS_COLORS,
        "meta": meta,
        "layout": layout_name,
    }
    data_json = json.dumps(payload, separators=(",", ":"))
    data_json = data_json.replace("</", "<\\/")

    legend_html = "".join(
        '<button class="lg" data-bucket="%s"><i style="background:%s"></i>'
        '<span>%s</span><b>%d</b></button>'
        % (html.escape(name, True), color, html.escape(name),
           stats["buckets"].get(name, 0))
        for name, color in OS_COLORS if stats["buckets"].get(name, 0))

    svc_html = "".join(
        '<li><span>%s</span><b>%d</b></li>' % (html.escape(k), v)
        for k, v in stats["top_services"])

    tpl = HTML_TEMPLATE
    for key, val in [
        ("{{TITLE}}", html.escape(title)),
        ("{{SVG}}", build_svg(nodes, edges, hosts)),
        ("{{DATA}}", data_json),
        ("{{LEGEND}}", legend_html),
        ("{{SERVICES}}", svc_html),
        ("{{N_HOSTS}}", str(stats["hosts"])),
        ("{{N_PORTS}}", str(stats["open_ports"])),
        ("{{N_SUBNETS}}", str(stats["subnets"])),
        ("{{N_FLAGGED}}", str(stats["flagged"])),
        ("{{ARGS}}", html.escape(meta.get("args", "") or "n/a")),
        ("{{WHEN}}", html.escape(meta.get("start", "") or "unknown")),
        ("{{LAYOUT}}", html.escape(layout_name)),
    ]:
        tpl = tpl.replace(key, val)
    return tpl


# --------------------------------------------------------------------------
# HTML shell
# --------------------------------------------------------------------------

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{TITLE}}</title>
<style>
  :root{
    --bg:#0b1017; --panel:#121a24; --panel2:#0f161f; --line:#1e2a38;
    --ink:#e6edf6; --dim:#8593a5; --accent:#3fd0a8; --warn:#ffb03a;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace;
  }
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{background:var(--bg);color:var(--ink);font-family:var(--mono);
       font-size:13px;line-height:1.45;overflow:hidden}
  .app{display:grid;grid-template-columns:1fr 348px;grid-template-rows:auto 1fr;height:100%}
  header{grid-column:1/-1;display:flex;align-items:center;gap:22px;flex-wrap:wrap;
         padding:12px 18px;background:var(--panel2);border-bottom:1px solid var(--line)}
  h1{font-size:14px;margin:0;letter-spacing:.14em;text-transform:uppercase;font-weight:600}
  h1 em{color:var(--accent);font-style:normal}
  .kpis{display:flex;gap:20px;margin-left:auto;flex-wrap:wrap}
  .kpi{display:flex;align-items:baseline;gap:7px}
  .kpi b{font-size:17px;font-weight:600}
  .kpi span{color:var(--dim);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase}
  .kpi.warn b{color:var(--warn)}
  .stage{position:relative;overflow:hidden;background:
    radial-gradient(circle at 50% 45%,#131c27 0%,var(--bg) 72%)}
  svg{width:100%;height:100%;display:block;cursor:grab;touch-action:none}
  svg.dragging{cursor:grabbing}
  .edge{stroke:#243244;stroke-width:1}
  .edge.trunk{stroke:#33465c;stroke-width:1.8}
  .node{cursor:pointer}
  .node .halo{fill:transparent}
  .node .dot{stroke:#0b1017;stroke-width:1.5;transition:opacity .15s}
  .node .inner{fill:#0b1017;opacity:.55}
  .node .ring{fill:none;stroke:var(--warn);stroke-width:1.6;
              stroke-dasharray:3 3;opacity:.9}
  .node .lbl{fill:var(--ink);font-size:11px;text-anchor:middle;pointer-events:none}
  .node .sub{fill:var(--dim);font-size:9.5px;text-anchor:middle;pointer-events:none}
  .node.subnet .lbl,.node.root .lbl,.node.router .lbl{fill:#cfdae8;font-size:11.5px;letter-spacing:.06em}
  .node:hover .dot,.node:focus .dot{stroke:var(--ink);stroke-width:2.5}
  .node:focus{outline:none}
  .node.sel .dot{stroke:var(--accent);stroke-width:3}
  .node.mute{opacity:.13}
  .edge.mute{opacity:.18}
  aside{background:var(--panel);border-left:1px solid var(--line);
        overflow-y:auto;padding:14px 16px 40px}
  .tools{position:absolute;top:12px;left:12px;display:flex;gap:8px;align-items:center}
  input[type=search]{background:var(--panel);border:1px solid var(--line);color:var(--ink);
    font-family:var(--mono);font-size:12px;padding:7px 10px;width:240px;border-radius:2px}
  input[type=search]:focus{outline:2px solid var(--accent);outline-offset:-1px}
  .btn{background:var(--panel);border:1px solid var(--line);color:var(--dim);
    font-family:var(--mono);font-size:11px;padding:7px 10px;cursor:pointer;border-radius:2px}
  .btn:hover{color:var(--ink);border-color:#31445a}
  .legend{position:absolute;bottom:12px;left:12px;display:flex;flex-wrap:wrap;gap:6px;max-width:62%}
  .lg{display:flex;align-items:center;gap:7px;background:rgba(18,26,36,.9);
    border:1px solid var(--line);padding:5px 9px;cursor:pointer;color:var(--dim);
    font-family:var(--mono);font-size:11px;border-radius:2px}
  .lg i{width:9px;height:9px;border-radius:50%;display:block}
  .lg b{color:var(--ink);font-weight:600}
  .lg.off{opacity:.35}
  .lg:hover{border-color:#31445a}
  h2{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);
     margin:20px 0 8px;font-weight:600}
  h2:first-child{margin-top:0}
  .ip{font-size:19px;letter-spacing:.02em;margin:0 0 2px}
  .names{color:var(--dim);word-break:break-all;margin-bottom:10px}
  table{width:100%;border-collapse:collapse}
  td{padding:3px 0;vertical-align:top}
  td.k{color:var(--dim);width:86px;padding-right:10px}
  .ports{width:100%;border-collapse:collapse;font-size:12px}
  .ports th{text-align:left;color:var(--dim);font-weight:500;font-size:10px;
    letter-spacing:.1em;text-transform:uppercase;padding:0 8px 5px 0;border-bottom:1px solid var(--line)}
  .ports td{padding:4px 8px 4px 0;border-bottom:1px solid #16202c;word-break:break-word}
  .ports td:first-child{color:var(--accent);white-space:nowrap}
  .flags{list-style:none;padding:0;margin:0}
  .flags li{border-left:2px solid var(--warn);padding:3px 0 3px 9px;margin-bottom:5px;color:#f3dcb2}
  .svc{list-style:none;padding:0;margin:0}
  .svc li{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #16202c}
  .svc span{color:var(--dim)}
  .empty{color:var(--dim)}
  .hint{color:var(--dim);font-size:11.5px;margin-top:10px}
  .scr{white-space:pre-wrap;background:var(--panel2);border:1px solid var(--line);
    padding:8px;font-size:11px;color:#b9c6d6;max-height:190px;overflow:auto;margin:0 0 8px}
  @media (max-width:900px){.app{grid-template-columns:1fr}aside{display:none}}
  @media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head>
<body>
<div class="app">
  <header>
    <h1><em>&#9679;</em> {{TITLE}}</h1>
    <div class="kpis">
      <div class="kpi"><b>{{N_HOSTS}}</b><span>hosts up</span></div>
      <div class="kpi"><b>{{N_SUBNETS}}</b><span>subnets</span></div>
      <div class="kpi"><b>{{N_PORTS}}</b><span>open ports</span></div>
      <div class="kpi warn"><b>{{N_FLAGGED}}</b><span>flagged</span></div>
    </div>
  </header>
  <div class="stage">
    {{SVG}}
    <div class="tools">
      <input type="search" id="q" placeholder="filter ip, name, service, os&hellip;" autocomplete="off">
      <button class="btn" id="reset">reset view</button>
      <button class="btn" id="csv">export csv</button>
    </div>
    <div class="legend">{{LEGEND}}</div>
  </div>
  <aside id="panel">
    <h2>scan</h2>
    <table><tr><td class="k">layout</td><td>{{LAYOUT}}</td></tr>
    <tr><td class="k">started</td><td>{{WHEN}}</td></tr>
    <tr><td class="k">command</td><td style="word-break:break-all">{{ARGS}}</td></tr></table>
    <h2>most common services</h2>
    <ul class="svc">{{SERVICES}}</ul>
    <p class="hint">Click any node for host detail. Drag to pan, scroll to zoom.
    Dashed amber rings mark hosts running cleartext, legacy, or high-value
    remote-access services.</p>
  </aside>
</div>
<script id="data" type="application/json">{{DATA}}</script>
<script>
(function(){
  var DATA = JSON.parse(document.getElementById('data').textContent);
  var svg = document.getElementById('map');
  var vp = document.getElementById('viewport');
  var panel = document.getElementById('panel');
  var nodes = [].slice.call(svg.querySelectorAll('.node'));
  var edges = [].slice.call(svg.querySelectorAll('.edge'));
  var homePanel = panel.innerHTML;
  var k = 1, tx = 0, ty = 0, sel = null;
  var offBuckets = {};

  function apply(){ vp.setAttribute('transform','translate('+tx+','+ty+') scale('+k+')'); }

  svg.addEventListener('wheel', function(e){
    e.preventDefault();
    var r = svg.getBoundingClientRect();
    var vb = svg.viewBox.baseVal;
    var sx = vb.width / r.width, sy = vb.height / r.height;
    var s = Math.max(sx, sy);
    var mx = (e.clientX - r.left - r.width/2) * s + vb.x + vb.width/2;
    var my = (e.clientY - r.top - r.height/2) * s + vb.y + vb.height/2;
    var f = e.deltaY < 0 ? 1.12 : 1/1.12;
    var nk = Math.min(9, Math.max(0.25, k*f));
    f = nk / k;
    tx = mx - (mx - tx) * f; ty = my - (my - ty) * f; k = nk;
    apply();
  }, {passive:false});

  var drag=null;
  svg.addEventListener('pointerdown', function(e){
    drag = {x:e.clientX, y:e.clientY, tx:tx, ty:ty};
    svg.classList.add('dragging'); svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', function(e){
    if(!drag) return;
    var r = svg.getBoundingClientRect(); var vb = svg.viewBox.baseVal;
    var s = Math.max(vb.width/r.width, vb.height/r.height);
    tx = drag.tx + (e.clientX-drag.x)*s; ty = drag.ty + (e.clientY-drag.y)*s; apply();
  });
  function endDrag(){ drag=null; svg.classList.remove('dragging'); }
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  document.getElementById('reset').onclick = function(){
    k=1; tx=0; ty=0; apply();
    document.getElementById('q').value=''; filter();
    if(sel){ sel.classList.remove('sel'); sel=null; }
    panel.innerHTML = homePanel;
  };

  function esc(s){ return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function detail(i){
    var h = DATA.hosts[i], out = [];
    out.push('<p class="ip">'+esc(h.ip)+'</p>');
    out.push('<p class="names">'+(h.hostnames.length?esc(h.hostnames.join(', ')):'no reverse dns')+'</p>');
    out.push('<h2>identity</h2><table>');
    function row(kk,v){ if(v) out.push('<tr><td class="k">'+kk+'</td><td>'+esc(v)+'</td></tr>'); }
    row('class', h.bucket);
    row('role', h.role);
    row('os', h.os + (h.acc? '  ('+h.acc+'%)' : ''));
    row('mac', h.mac);
    row('vendor', h.vendor);
    row('ipv6', h.ipv6);
    row('latency', h.latency);
    row('hops', h.distance);
    row('last boot', h.uptime);
    out.push('</table>');

    out.push('<h2>open ports ('+h.ports.length+')</h2>');
    if(h.ports.length){
      out.push('<table class="ports"><tr><th>port</th><th>service</th><th>version</th></tr>');
      h.ports.forEach(function(p){
        var v = [p.product, p.version, p.extra].filter(Boolean).join(' ');
        out.push('<tr><td>'+p.port+'/'+p.proto+'</td><td>'+esc(p.name||'?')+
                 '</td><td>'+esc(v||'&mdash;')+'</td></tr>');
      });
      out.push('</table>');
    } else { out.push('<p class="empty">none found</p>'); }

    if(h.flags.length){
      out.push('<h2>worth reviewing</h2><ul class="flags">');
      h.flags.forEach(function(f){ out.push('<li>'+esc(f)+'</li>'); });
      out.push('</ul>');
    }
    if(h.trace && h.trace.length){
      out.push('<h2>path</h2><table>');
      h.trace.forEach(function(t){
        out.push('<tr><td class="k">hop '+t.ttl+'</td><td>'+esc(t.ip||'*')+
                 (t.host?' ('+esc(t.host)+')':'')+'</td></tr>');
      });
      out.push('</table>');
    }
    if(h.scripts && h.scripts.length){
      out.push('<h2>host scripts</h2>');
      h.scripts.forEach(function(s){
        out.push('<p class="hint">'+esc(s.id)+'</p><pre class="scr">'+esc(s.output)+'</pre>');
      });
    }
    panel.innerHTML = out.join('');
    panel.scrollTop = 0;
  }

  nodes.forEach(function(n){
    function act(){
      var i = parseInt(n.getAttribute('data-host'),10);
      if(sel) sel.classList.remove('sel');
      if(i >= 0){ n.classList.add('sel'); sel = n; detail(i); }
      else { sel = null; panel.innerHTML = homePanel; }
    }
    n.addEventListener('click', function(e){ e.stopPropagation(); act(); });
    n.addEventListener('keydown', function(e){
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); act(); }
    });
  });

  function haystack(i){
    var h = DATA.hosts[i];
    return [h.ip, h.mac, h.vendor, h.os, h.bucket, h.role,
            h.hostnames.join(' '),
            h.ports.map(function(p){return p.port+' '+p.name+' '+p.product;}).join(' ')
           ].join(' ').toLowerCase();
  }

  function filter(){
    var q = document.getElementById('q').value.trim().toLowerCase();
    var visible = {};
    nodes.forEach(function(n){
      var i = parseInt(n.getAttribute('data-host'),10);
      var show = true;
      if(i >= 0){
        var h = DATA.hosts[i];
        if(offBuckets[h.bucket]) show = false;
        if(show && q && haystack(i).indexOf(q) < 0) show = false;
      }
      n.classList.toggle('mute', !show);
      if(show) visible[n.getAttribute('data-id')] = 1;
    });
    edges.forEach(function(e){
      var on = visible[e.getAttribute('data-a')] && visible[e.getAttribute('data-b')];
      e.classList.toggle('mute', !on);
    });
  }
  document.getElementById('q').addEventListener('input', filter);

  [].forEach.call(document.querySelectorAll('.lg'), function(b){
    b.onclick = function(){
      var key = b.getAttribute('data-bucket');
      offBuckets[key] = !offBuckets[key];
      b.classList.toggle('off', !!offBuckets[key]);
      filter();
    };
  });

  document.getElementById('csv').onclick = function(){
    var rows = [['ip','hostname','mac','vendor','class','role','os','os_accuracy',
                 'open_ports','ports','flags'].join(',')];
    DATA.hosts.forEach(function(h){
      function q(v){ return '"' + String(v==null?'':v).replace(/"/g,'""') + '"'; }
      rows.push([q(h.ip), q(h.hostnames.join(' ')), q(h.mac), q(h.vendor),
        q(h.bucket), q(h.role), q(h.os), q(h.acc), h.ports.length,
        q(h.ports.map(function(p){return p.port+'/'+p.proto+':'+(p.name||'?');}).join(' ')),
        q(h.flags.join(' | '))].join(','));
    });
    var blob = new Blob([rows.join('\n')], {type:'text/csv'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'network-inventory.csv';
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
  };

  svg.addEventListener('click', function(){
    if(sel){ sel.classList.remove('sel'); sel=null; panel.innerHTML = homePanel; }
  });
  apply();
})();
</script>
</body></html>
"""


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Build a self-contained HTML network map from nmap output.",
        epilog="example: nmap -sS -sV -O --traceroute -oX scan.xml 10.0.0.0/24 "
               "&& python3 %(prog)s scan.xml -o map.html")
    ap.add_argument("input", help="nmap XML (-oX) or normal (-oN) file, or - for stdin")
    ap.add_argument("-o", "--output", default="network-map.html", help="output HTML path")
    ap.add_argument("--format", choices=["auto", "xml", "text"], default="auto")
    ap.add_argument("--layout", choices=["subnet", "trace"], default="subnet",
                    help="subnet clusters (default) or traceroute topology")
    ap.add_argument("--bits", type=int, default=24,
                    help="prefix length used to group hosts (default 24)")
    ap.add_argument("--title", default="Network baseline")
    ap.add_argument("--all-ports", action="store_true",
                    help="include filtered/closed ports, not just open")
    ap.add_argument("--min-accuracy", type=int, default=0,
                    help="ignore OS matches below this accuracy percentage")
    ap.add_argument("--json", metavar="PATH", help="also write the parsed inventory as JSON")
    ap.add_argument("--version", action="version", version="nmap2map " + __version__)
    args = ap.parse_args(argv)

    if args.input == "-":
        text = sys.stdin.read()
    else:
        if not os.path.exists(args.input):
            raise SystemExit("No such file: %s" % args.input)
        with open(args.input, "r", errors="replace") as fh:
            text = fh.read()

    fmt = args.format
    if fmt == "auto":
        head = text.lstrip()[:400]
        fmt = "xml" if head.startswith("<?xml") or "<nmaprun" in head else "text"

    parser = parse_xml if fmt == "xml" else parse_text
    hosts, meta = parser(text, open_only=not args.all_ports,
                         min_accuracy=args.min_accuracy)

    if not hosts:
        raise SystemExit("No live hosts found in %s. Was the scan empty, or is "
                         "this the wrong output format?" % args.input)

    hosts = [classify(h) for h in hosts]
    hosts.sort(key=lambda h: sort_key(h["ip"]))

    layout_name = args.layout
    nodes = edges = None
    if args.layout == "trace":
        nodes, edges = layout_trace(hosts)
        if nodes is None:
            print("No traceroute data in this scan (add --traceroute to nmap); "
                  "falling back to subnet layout.", file=sys.stderr)
            layout_name = "subnet"
    if nodes is None:
        nodes, edges = layout_subnet(hosts, args.bits)

    out = render_html(hosts, nodes, edges, meta, args.title, layout_name)
    with open(args.output, "w") as fh:
        fh.write(out)

    if args.json:
        with open(args.json, "w") as fh:
            json.dump(hosts, fh, indent=2)

    flagged = sum(1 for h in hosts if h["flags"])
    print("%s  ->  %s" % (args.input, args.output))
    print("  %d hosts up, %d open ports, %d hosts with services worth reviewing"
          % (len(hosts), sum(h["open_count"] for h in hosts), flagged))
    if args.json:
        print("  inventory json: %s" % args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
