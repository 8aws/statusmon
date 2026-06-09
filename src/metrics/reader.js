/**
 * src/metrics/reader.js
 * Host system metrics — reads from /host/proc (bind mount, read-only)
 * No external dependencies — pure Node.js fs
 */

'use strict';

const fs = require('fs');
const HOST_PROC = process.env.HOST_PROC || '/host/proc';

function readFile(rel) {
  return fs.readFileSync(`${HOST_PROC}/${rel}`, 'utf8');
}

// ─── CPU ──────────────────────────────────────────────────────────
// Parse a single "cpuN ..." line from /proc/stat
function parseCpuLine(line) {
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0,
         iowait = 0, irq = 0, softirq = 0, steal = 0] = parts;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { user, nice, system, idle, iowait, irq, softirq, steal, total };
}

function readCpuStat() {
  const stat = readFile('stat');
  const result = {};
  for (const line of stat.split('\n')) {
    if (!line.startsWith('cpu')) break;
    const name = line.split(/\s+/)[0]; // 'cpu', 'cpu0', 'cpu1' …
    result[name] = parseCpuLine(line);
  }
  return result;
}

function cpuPct(prev, curr) {
  const dTotal = curr.total - prev.total;
  if (dTotal <= 0) return 0;
  const dIdle  = curr.idle  - prev.idle;
  return Math.max(0, Math.min(100, +((1 - dIdle / dTotal) * 100).toFixed(1)));
}

// ─── Memory ───────────────────────────────────────────────────────
function readMemInfo() {
  const raw = readFile('meminfo');
  const kb = (key) => {
    const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? parseInt(m[1]) * 1024 : 0; // kB → bytes
  };
  const total     = kb('MemTotal');
  const free      = kb('MemFree');
  const available = kb('MemAvailable') || free;
  const buffers   = kb('Buffers');
  const cached    = kb('Cached');
  const swapTotal = kb('SwapTotal');
  const swapFree  = kb('SwapFree');
  const used      = total - available;
  const swapUsed  = swapTotal - swapFree;
  return {
    total, free, available, buffers, cached, used,
    usedPct:     total     > 0 ? +((used     / total)     * 100).toFixed(1) : 0,
    swapTotal, swapFree, swapUsed,
    swapUsedPct: swapTotal > 0 ? +((swapUsed / swapTotal) * 100).toFixed(1) : 0,
  };
}

// ─── Load average ─────────────────────────────────────────────────
function readLoadAvg() {
  const parts = readFile('loadavg').trim().split(/\s+/);
  return {
    avg1:  parseFloat(parts[0]),
    avg5:  parseFloat(parts[1]),
    avg15: parseFloat(parts[2]),
  };
}

// ─── Core count ───────────────────────────────────────────────────
function readCoreCount() {
  try {
    return (readFile('cpuinfo').match(/^processor\s*:/gm) || []).length || 1;
  } catch { return 1; }
}

// ─── Disk I/O ─────────────────────────────────────────────────────
// Include: whole disks and RAID arrays only (no partitions, no loop/dm/ram)
// sda, sdb … | md0, md1 … | nvme0n1 … | mmcblk0 …
const DISK_RE = /^(sd[a-z]+|md\d+|nvme\d+n\d+|mmcblk\d+)$/;

// /proc/diskstats columns (0-indexed after split):
// 0:major 1:minor 2:dev 3:reads 4:reads_merged 5:sectors_read 6:ms_read
// 7:writes 8:writes_merged 9:sectors_written 10:ms_write …
// 1 sector = 512 bytes
function readDiskStats() {
  const result = {};
  for (const line of readFile('diskstats').trim().split('\n')) {
    const p = line.trim().split(/\s+/);
    const dev = p[2];
    if (!DISK_RE.test(dev)) continue;
    result[dev] = {
      reads:          parseInt(p[3]),
      sectorsRead:    parseInt(p[5]),
      writes:         parseInt(p[7]),
      sectorsWritten: parseInt(p[9]),
    };
  }
  return result;
}

function diskRates(prev, curr, deltaMs) {
  const s = deltaMs / 1000;
  const result = {};
  for (const [dev, c] of Object.entries(curr)) {
    const p = prev[dev];
    if (!p) { result[dev] = { rps: 0, wps: 0, rkBs: 0, wkBs: 0 }; continue; }
    result[dev] = {
      rps:  +(Math.max(0, c.reads          - p.reads)          / s).toFixed(2),
      wps:  +(Math.max(0, c.writes         - p.writes)         / s).toFixed(2),
      rkBs: +(Math.max(0, c.sectorsRead    - p.sectorsRead)    * 512 / 1024 / s).toFixed(2),
      wkBs: +(Math.max(0, c.sectorsWritten - p.sectorsWritten) * 512 / 1024 / s).toFixed(2),
    };
  }
  return result;
}

// ─── Network ──────────────────────────────────────────────────────
// Exclude loopback, virtual, docker, bridge interfaces
const NET_SKIP = /^(lo|docker\d*|br-|veth|tunl?|sit\d*|dummy).*$/;

function readNetDev() {
  try {
    const result = {};
    const lines = readFile('net/dev').trim().split('\n').slice(2); // skip 2 header lines
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      const iface = p[0].replace(':', '');
      if (NET_SKIP.test(iface)) continue;
      result[iface] = {
        rxBytes:   parseInt(p[1]),
        rxPackets: parseInt(p[2]),
        txBytes:   parseInt(p[9]),
        txPackets: parseInt(p[10]),
      };
    }
    return result;
  } catch { return {}; }
}

function netRates(prev, curr, deltaMs) {
  const s = deltaMs / 1000;
  const result = {};
  for (const [iface, c] of Object.entries(curr)) {
    const p = prev[iface];
    if (!p) { result[iface] = { rxKBs: 0, txKBs: 0 }; continue; }
    result[iface] = {
      rxKBs: +(Math.max(0, c.rxBytes - p.rxBytes) / 1024 / s).toFixed(2),
      txKBs: +(Math.max(0, c.txBytes - p.txBytes) / 1024 / s).toFixed(2),
    };
  }
  return result;
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Take a raw snapshot of all counters (no rates — used to prime the delta).
 */
function takeSnapshot() {
  return {
    ts:   Date.now(),
    cpu:  readCpuStat(),
    mem:  readMemInfo(),
    load: readLoadAvg(),
    disk: readDiskStats(),
    net:  readNetDev(),
  };
}

/**
 * Compute a metrics object from two consecutive snapshots.
 * Returns null if deltaMs <= 0.
 */
function computeMetrics(prev, curr) {
  const deltaMs = curr.ts - prev.ts;
  if (deltaMs <= 0) return null;

  // CPU overall + per-core
  const coreKeys = Object.keys(curr.cpu).filter(k => k !== 'cpu');
  const cores = coreKeys.map(k => ({
    core: k,
    pct:  cpuPct(prev.cpu[k] || prev.cpu.cpu, curr.cpu[k]),
  }));

  return {
    ts:   curr.ts,
    cpu:  { pct: cpuPct(prev.cpu.cpu, curr.cpu.cpu), cores },
    mem:  curr.mem,   // absolute — use latest snapshot value
    load: curr.load,  // absolute
    disk: diskRates(prev.disk, curr.disk, deltaMs),
    net:  netRates(prev.net,  curr.net,  deltaMs),
  };
}

module.exports = { takeSnapshot, computeMetrics, readCoreCount };
