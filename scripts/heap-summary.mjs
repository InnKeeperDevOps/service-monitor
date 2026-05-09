// Parse V8 .heapsnapshot files and report the top object classes by total
// retained self_size. Also diffs counts between two snapshots.
//
// Usage:
//   node heap-summary.mjs <snap.heapsnapshot>
//   node heap-summary.mjs <a.heapsnapshot> <b.heapsnapshot>   # diff a → b
import fs from "node:fs";

function parse(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  const nodeFields = raw.snapshot.meta.node_fields;
  const nodeFieldCount = nodeFields.length;
  const idxType = nodeFields.indexOf("type");
  const idxName = nodeFields.indexOf("name");
  const idxSize = nodeFields.indexOf("self_size");
  const types = raw.snapshot.meta.node_types[0]; // first field's type list
  const nodes = raw.nodes;
  const strings = raw.strings;
  const total = raw.snapshot.node_count;

  const byClass = new Map(); // name → { count, bytes }
  let totalBytes = 0;
  for (let i = 0; i < total; i++) {
    const off = i * nodeFieldCount;
    const type = types[nodes[off + idxType]];
    const name = strings[nodes[off + idxName]] ?? "(noname)";
    const size = nodes[off + idxSize];
    const key = `${type}:${name}`;
    const cur = byClass.get(key) ?? { count: 0, bytes: 0 };
    cur.count += 1;
    cur.bytes += size;
    byClass.set(key, cur);
    totalBytes += size;
  }
  return { byClass, totalBytes, nodeCount: total };
}

function fmtBytes(n) {
  if (n > 1048576) return (n / 1048576).toFixed(2) + " MiB";
  if (n > 1024) return (n / 1024).toFixed(1) + " KiB";
  return n + " B";
}

const a = process.argv[2];
const b = process.argv[3];
if (!a) {
  console.error("Usage: node heap-summary.mjs <snapshot> [other-snapshot]");
  process.exit(1);
}
const A = parse(a);
console.log(`File: ${a}`);
console.log(`  nodes=${A.nodeCount}  total_self_size=${fmtBytes(A.totalBytes)}`);

const top = [...A.byClass.entries()].sort((x, y) => y[1].bytes - x[1].bytes).slice(0, 25);
console.log(`  top 25 classes by retained self_size:`);
for (const [k, v] of top) {
  console.log(`    ${fmtBytes(v.bytes).padStart(12)}  count=${String(v.count).padStart(7)}  ${k}`);
}

if (b) {
  const B = parse(b);
  console.log(`\nFile: ${b}`);
  console.log(`  nodes=${B.nodeCount}  total_self_size=${fmtBytes(B.totalBytes)}`);
  console.log(`\nDiff ${a} → ${b}:`);
  console.log(`  Δ nodes = ${B.nodeCount - A.nodeCount}`);
  console.log(`  Δ bytes = ${fmtBytes(B.totalBytes - A.totalBytes)} (signed: ${B.totalBytes - A.totalBytes})`);
  const allKeys = new Set([...A.byClass.keys(), ...B.byClass.keys()]);
  const diffs = [];
  for (const k of allKeys) {
    const av = A.byClass.get(k) ?? { count: 0, bytes: 0 };
    const bv = B.byClass.get(k) ?? { count: 0, bytes: 0 };
    diffs.push({ k, dCount: bv.count - av.count, dBytes: bv.bytes - av.bytes });
  }
  diffs.sort((x, y) => Math.abs(y.dBytes) - Math.abs(x.dBytes));
  console.log(`  top 25 deltas (signed bytes):`);
  for (const d of diffs.slice(0, 25)) {
    if (d.dBytes === 0 && d.dCount === 0) continue;
    const sign = d.dBytes >= 0 ? "+" : "−";
    console.log(`    ${sign}${fmtBytes(Math.abs(d.dBytes)).padStart(11)}  Δcount=${String(d.dCount).padStart(7)}  ${d.k}`);
  }
}
