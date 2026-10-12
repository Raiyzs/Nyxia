#!/usr/bin/env node
// Extracts animations from Nyxia3dV2.glb into a slim nyxia-anims.glb
// Output contains only: nodes (names + hierarchy + rest TRS), animations, accessors, bufferViews, buffer
'use strict';
const fs   = require('fs');
const path = require('path');

const src = path.join(__dirname, '3d avatar/Nyxia3dV2.glb');
const dst = path.join(__dirname, '3d avatar/nyxia-anims.glb');

const buf = fs.readFileSync(src);
if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error('Not a GLB');

const jsonLen  = buf.readUInt32LE(12);
const gltf     = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));

const binStart = 20 + jsonLen;
const binLen   = buf.readUInt32LE(binStart);
const binary   = buf.slice(binStart + 8, binStart + 8 + binLen);

// Collect accessor indices used by animations
const usedAcc = new Set();
for (const anim of gltf.animations || []) {
  for (const s of anim.samplers) { usedAcc.add(s.input); usedAcc.add(s.output); }
}

// Collect bufferView indices used by those accessors
const usedBV = new Set();
for (const ai of usedAcc) {
  const acc = gltf.accessors[ai];
  if (acc.bufferView != null) usedBV.add(acc.bufferView);
}

// Collect node indices used by animation channels, plus every ancestor, so
// the slim file keeps the full bone hierarchy and rest transforms. The VRM
// retargeter (src/mixamo-vrm-retarget.js) needs world-space rest rotations,
// which only exist when parents and their translation/rotation/scale survive.
const parentOf = {};
gltf.nodes.forEach((n, i) => (n.children || []).forEach(c => { parentOf[c] = i; }));
const usedNode = new Set();
for (const anim of gltf.animations || []) {
  for (const ch of anim.channels) {
    let n = ch.target?.node;
    while (n != null && !usedNode.has(n)) { usedNode.add(n); n = parentOf[n]; }
  }
}

// Build new binary: only the anim bufferViews, aligned to 4 bytes
const sortedBVs = [...usedBV].sort((a, b) => a - b);
const bvRemap   = {};   // old BV index → new BV index
const newBVs    = [];
const parts     = [];
let offset = 0;

for (const oldIdx of sortedBVs) {
  const bv    = gltf.bufferViews[oldIdx];
  const slice = binary.slice(bv.byteOffset, bv.byteOffset + bv.byteLength);
  const pad   = (4 - (slice.length % 4)) % 4;
  const chunk = Buffer.concat([slice, Buffer.alloc(pad)]);
  bvRemap[oldIdx] = newBVs.length;
  newBVs.push({ buffer: 0, byteOffset: offset, byteLength: bv.byteLength });
  parts.push(chunk);
  offset += chunk.length;
}
const newBin = Buffer.concat(parts);

// Remap accessors
const sortedAccs = [...usedAcc].sort((a, b) => a - b);
const accRemap   = {};
const newAccs    = [];
for (const oldIdx of sortedAccs) {
  const acc = { ...gltf.accessors[oldIdx] };
  if (acc.bufferView != null) acc.bufferView = bvRemap[acc.bufferView];
  accRemap[oldIdx] = newAccs.length;
  newAccs.push(acc);
}

// Remap nodes (names, hierarchy and rest TRS — no mesh/skin refs)
const sortedNodes = [...usedNode].sort((a, b) => a - b);
const nodeRemap   = {};
sortedNodes.forEach((oldIdx, i) => { nodeRemap[oldIdx] = i; });
const newNodes = sortedNodes.map(oldIdx => {
  const n = gltf.nodes[oldIdx];
  const out = { name: n.name };
  if (n.translation) out.translation = n.translation;
  if (n.rotation)    out.rotation    = n.rotation;
  if (n.scale)       out.scale       = n.scale;
  if (n.matrix)      out.matrix      = n.matrix;
  const children = (n.children || []).filter(c => usedNode.has(c)).map(c => nodeRemap[c]);
  if (children.length) out.children = children;
  return out;
});
const rootNodes = sortedNodes.filter(i => parentOf[i] == null || !usedNode.has(parentOf[i])).map(i => nodeRemap[i]);

// Remap animations
const newAnims = gltf.animations.map(anim => ({
  name: anim.name,
  samplers: anim.samplers.map(s => ({
    input:  accRemap[s.input],
    output: accRemap[s.output],
    ...(s.interpolation ? { interpolation: s.interpolation } : {})
  })),
  channels: anim.channels.map(ch => ({
    sampler: ch.sampler,
    target: {
      node: nodeRemap[ch.target.node],
      path: ch.target.path
    }
  }))
}));

// Build new GLTF JSON — include a scene so three.js loads the nodes
const newGltf = {
  asset:  gltf.asset,
  scene:  0,
  scenes: [{ nodes: rootNodes }],
  nodes:       newNodes,
  accessors:   newAccs,
  bufferViews: newBVs,
  buffers:     [{ byteLength: newBin.length }],
  animations:  newAnims
};

const jsonStr  = JSON.stringify(newGltf);
const jsonPad  = (4 - (jsonStr.length % 4)) % 4;
const jsonBuf  = Buffer.concat([Buffer.from(jsonStr), Buffer.alloc(jsonPad, 0x20)]);

const totalLen = 12 + 8 + jsonBuf.length + 8 + newBin.length;
const out      = Buffer.alloc(totalLen);
out.writeUInt32LE(0x46546C67, 0);
out.writeUInt32LE(2,          4);
out.writeUInt32LE(totalLen,   8);
out.writeUInt32LE(jsonBuf.length, 12);
out.writeUInt32LE(0x4E4F534A,    16);
jsonBuf.copy(out, 20);
const b = 20 + jsonBuf.length;
out.writeUInt32LE(newBin.length, b);
out.writeUInt32LE(0x004E4942,   b + 4);
newBin.copy(out, b + 8);

fs.writeFileSync(dst, out);
const kb = (out.length / 1024).toFixed(1);
console.log(`Written: ${dst}`);
console.log(`Size: ${kb} KB  (was ${(fs.statSync(src).size/1024/1024).toFixed(0)} MB)`);
console.log(`Animations: ${newAnims.length} — ${newAnims.map(a=>a.name).join(', ')}`);
