// Shared Mixamo (Nyxia3dV2.glb) → VRM humanoid retargeting.
// Used by desktop-avatar.html (live overlay) and vrm-viewer.html (standalone
// test viewer) so both play the same 42 nyxia-anims.glb clips on a VRM rig.
//
// How it works (the standard three-vrm Mixamo recipe, generalised to any rig):
//
//   1. The SOURCE scene (nyxia-anims.glb — it must carry the bone hierarchy and
//      rest transforms, which `extract-anims.js` now preserves) is posed by a
//      THREE.AnimationMixer at SAMPLE_FPS and every mapped bone's WORLD rotation
//      is read back. Sampling world transforms means unmapped in-between bones
//      (twist bones, extra spine segments) still contribute their motion.
//
//   2. Each bone's world-space delta from its own rest pose becomes the VRM
//      normalized bone's local rotation. three-vrm's normalized bones all rest
//      at world identity, so their local quaternion IS a world-aligned rotation
//      relative to the parent. World-space deltas are therefore the only frame
//      that transfers correctly:
//
//        local(b) = R(p)⁻¹ · rest(Sp) · anim(Sp)⁻¹ · anim(Sb) · rest(Sb)⁻¹ · R(b)
//
//      (Sb / Sp: source bone and its nearest mapped source ancestor; rest/anim:
//      world rotations; R: rest correction from step 3.)
//
//      The previous version applied deltas in the source bone's own LOCAL rest
//      frame (q_rest⁻¹ · q_anim). In Nyxia3dV2 that frame is rotated ~180° for
//      the spine chain and ~120° for the arms, so every clip that bent the
//      torso (fold_arms, complain_01, cast_a_spell…) collapsed forward and the
//      head spun — the "bad mocap" was really a wrong coordinate frame.
//
//   3. Rest-pose mismatch (source rests arms-down, VRM rests in T-pose) is
//      solved per bone with a world-space correction R that rotates the VRM's
//      rest bone direction onto the source's rest bone direction. It is derived
//      from the two skeletons' joint positions — no hand-tuned angles.

// Nyxia3dV2.glb bone name → VRM humanoid bone name
const MIXAMO_TO_VRM = {
  Hip:         'hips',
  Waist:       'spine',
  Spine01:     'chest',
  NeckTwist01: 'neck',
  Head:        'head',
  L_Clavicle:  'leftShoulder',
  L_Upperarm:  'leftUpperArm',
  L_Forearm:   'leftLowerArm',
  L_Hand:      'leftHand',
  R_Clavicle:  'rightShoulder',
  R_Upperarm:  'rightUpperArm',
  R_Forearm:   'rightLowerArm',
  R_Hand:      'rightHand',
  L_Thigh:     'leftUpperLeg',
  L_Calf:      'leftLowerLeg',
  L_Foot:      'leftFoot',
  R_Thigh:     'rightUpperLeg',
  R_Calf:      'rightLowerLeg',
  R_Foot:      'rightFoot',
};
const VRM_TO_MIXAMO = Object.fromEntries(Object.entries(MIXAMO_TO_VRM).map(([m, v]) => [v, m]));

// VRM humanoid parent chain, restricted to the bones we map.
const VRM_PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  leftShoulder: 'chest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightShoulder: 'chest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg',
};

// The bone each one "points at" — defines its rest direction for the rest
// correction. Bones without an entry (hips, head, hands, feet) use identity
// (hips) or inherit their parent's correction.
const CHAIN_CHILD = {
  spine: 'chest', chest: 'neck', neck: 'head',
  leftShoulder: 'leftUpperArm', leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand',
  rightShoulder: 'rightUpperArm', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand',
  leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot',
  rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot',
};

const SAMPLE_FPS = 30;

// buildRetargeter(THREE) → retargetMixamoToVRM(clips, vrm, srcScene)
// THREE is passed in rather than imported here because callers load it via
// a dynamic `import('three')` against their own importmap.
function buildRetargeter(THREE) {
  const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _qp = new THREE.Quaternion();
  const _v = new THREE.Vector3();

  return function retargetMixamoToVRM(clips, vrm, srcScene) {
    if (!srcScene) throw new Error('[retarget] srcScene (the nyxia-anims.glb scene) is required');

    // ── Source side: mapped nodes + rest world transforms ──────────────
    const srcNodes = {};
    srcScene.traverse(n => { if (MIXAMO_TO_VRM[n.name] && !srcNodes[n.name]) srcNodes[n.name] = n; });
    const hasHierarchy = Object.values(srcNodes).some(n => n.parent && n.parent !== srcScene);
    if (!hasHierarchy) {
      console.error('[retarget] nyxia-anims.glb has no bone hierarchy — re-run `node extract-anims.js`. Clips will be wrong.');
    }

    // VRM 0.x models face -Z (VRM 1.0 and Mixamo face +Z). three-vrm's own
    // Mixamo sample flips x/z of every quaternion for 0.x; rotating the source
    // scene 180° about Y before sampling achieves the same in one line.
    const srcRotY = srcScene.rotation.y;
    if (vrm.meta?.metaVersion === '0') srcScene.rotation.y += Math.PI;

    const restSnapshot = [];
    srcScene.traverse(n => restSnapshot.push([n, n.position.clone(), n.quaternion.clone(), n.scale.clone()]));
    const restoreRest = () => { for (const [n, p, q, s] of restSnapshot) { n.position.copy(p); n.quaternion.copy(q); n.scale.copy(s); } };

    srcScene.updateMatrixWorld(true);
    const srcRestQ = {}, srcRestP = {};
    for (const [m, n] of Object.entries(srcNodes)) {
      srcRestQ[m] = n.getWorldQuaternion(new THREE.Quaternion());
      srcRestP[m] = n.getWorldPosition(new THREE.Vector3());
    }

    // ── VRM side: normalized bones (see note below) + rest positions ───
    // Target the NORMALIZED humanoid bones, not raw: VRMHumanoid.update()
    // copies normalizedHumanBones → rawHumanBones every frame, so animating raw
    // bones directly gets overwritten back to bind pose on the next frame.
    const vrmNodes = {}, vrmRestP = {};
    for (const [m, v] of Object.entries(MIXAMO_TO_VRM)) {
      const node = srcNodes[m] && vrm.humanoid.getNormalizedBoneNode?.(v);
      if (node) vrmNodes[v] = node;
    }
    for (const [v, node] of Object.entries(vrmNodes)) {
      node.updateWorldMatrix(true, false);
      vrmRestP[v] = node.getWorldPosition(new THREE.Vector3());
    }
    console.log(`[retarget] bone map: ${Object.keys(vrmNodes).length}/${Object.keys(MIXAMO_TO_VRM).length} bones mapped`);

    const vrmParentOf = v => { let p = VRM_PARENT[v]; while (p && !vrmNodes[p]) p = VRM_PARENT[p]; return p; };
    const chainChildOf = v => { let c = CHAIN_CHILD[v]; while (c && !vrmNodes[c]) c = CHAIN_CHILD[c]; return c; };

    // Rest correction R per VRM bone: rotates the VRM rest bone direction onto
    // the source rest bone direction (world space).
    const R = {};
    const restCorrection = v => {
      if (R[v]) return R[v];
      const c = chainChildOf(v), p = vrmParentOf(v);
      let q;
      if (c) {
        const vrmDir = vrmRestP[c].clone().sub(vrmRestP[v]).normalize();
        const srcDir = srcRestP[VRM_TO_MIXAMO[c]].clone().sub(srcRestP[VRM_TO_MIXAMO[v]]).normalize();
        q = new THREE.Quaternion().setFromUnitVectors(vrmDir, srcDir);
      } else if (p) {
        q = restCorrection(p).clone();
      } else {
        q = new THREE.Quaternion();
      }
      R[v] = q;
      return q;
    };
    const Rinv = {};
    for (const v of Object.keys(vrmNodes)) { restCorrection(v); Rinv[v] = R[v].clone().invert(); }

    // Hips translation: scale the source's world-space hip offset by the
    // ratio of standing heights (hips above feet) so crouches and bounces
    // keep their proportion on the VRM.
    const hipsNode = vrmNodes.hips;
    const floorY = (P, l, r, h) => Math.min(P[l]?.y ?? P[h].y, P[r]?.y ?? P[h].y);
    const srcHipH = srcRestP.Hip ? srcRestP.Hip.y - floorY(srcRestP, 'L_Foot', 'R_Foot', 'Hip') : 0;
    const vrmHipH = hipsNode ? vrmRestP.hips.y - floorY(vrmRestP, 'leftFoot', 'rightFoot', 'hips') : 0;
    const hipScale = srcHipH > 1e-6 && vrmHipH > 1e-6 ? vrmHipH / srcHipH : 1;

    // ── Sample every clip on the source rig, write VRM-space tracks ────
    const mixer = new THREE.AnimationMixer(srcScene);
    const animQ = {};
    for (const m of Object.keys(srcNodes)) animQ[m] = new THREE.Quaternion();

    const out = clips.map(clip => {
      restoreRest();
      const action = mixer.clipAction(clip);
      action.play();

      const n = Math.max(2, Math.ceil(clip.duration * SAMPLE_FPS) + 1);
      const times = new Float32Array(n);
      const rot = {};
      for (const v of Object.keys(vrmNodes)) rot[v] = new Float32Array(n * 4);
      const pos = hipsNode && srcNodes.Hip ? new Float32Array(n * 3) : null;

      for (let i = 0; i < n; i++) {
        const t = Math.min(clip.duration, i / SAMPLE_FPS);
        times[i] = t;
        action.time = t;
        mixer.update(0);
        srcScene.updateMatrixWorld(true);
        for (const [m, node] of Object.entries(srcNodes)) node.getWorldQuaternion(animQ[m]);

        for (const [v, buf] of Object.entries(rot)) {
          const m = VRM_TO_MIXAMO[v], p = vrmParentOf(v);
          // local(b) = R(p)⁻¹ · rest(Sp) · anim(Sp)⁻¹ · anim(Sb) · rest(Sb)⁻¹ · R(b)
          _q.copy(animQ[m]).multiply(_qi.copy(srcRestQ[m]).invert());
          if (p) {
            const mp = VRM_TO_MIXAMO[p];
            _q.premultiply(_qp.copy(animQ[mp]).invert()).premultiply(srcRestQ[mp]).premultiply(Rinv[p]);
          }
          _q.multiply(R[v]);
          // Hemisphere continuity: q and -q are the same rotation, but the
          // keyframe interpolator slerps the long way round if neighbours sit on
          // opposite sides of the double cover. Keep each sample in the same
          // hemisphere as the previous one.
          if (i > 0) {
            const o = (i - 1) * 4;
            if (buf[o] * _q.x + buf[o + 1] * _q.y + buf[o + 2] * _q.z + buf[o + 3] * _q.w < 0) {
              _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
            }
          }
          buf[i * 4] = _q.x; buf[i * 4 + 1] = _q.y; buf[i * 4 + 2] = _q.z; buf[i * 4 + 3] = _q.w;
        }

        if (pos) {
          srcNodes.Hip.getWorldPosition(_v).sub(srcRestP.Hip).multiplyScalar(hipScale).add(hipsNode.position);
          pos[i * 3] = _v.x; pos[i * 3 + 1] = _v.y; pos[i * 3 + 2] = _v.z;
        }
      }
      action.stop();
      mixer.uncacheClip(clip);

      const tracks = [];
      for (const [v, buf] of Object.entries(rot)) {
        tracks.push(new THREE.QuaternionKeyframeTrack(`${vrmNodes[v].name}.quaternion`, times, buf));
      }
      if (pos) tracks.push(new THREE.VectorKeyframeTrack(`${hipsNode.name}.position`, times, pos));
      return new THREE.AnimationClip(clip.name, clip.duration, tracks);
    });

    restoreRest();
    srcScene.rotation.y = srcRotY;
    srcScene.updateMatrixWorld(true);
    return out;
  };
}

// buildRestIdleClip(THREE, vrm) → a static "arms hanging naturally" AnimationClip.
// Needs no Mixamo source data at all — a T-pose→natural-hang vector trick baked
// into a standalone 2-keyframe clip. Works on any loaded VRM, which is what
// makes it useful for index.html: that window loads a VRM with zero baked
// animation clips and would otherwise sit in bind T-pose.
const ARM_NATURAL_DIR = {
  L_Upperarm: [ 0.42, -0.90, 0.08],
  R_Upperarm: [-0.42, -0.90, 0.08],
};
// Forearm gets its own, more inward target — a slight elbow bend reads as a
// relaxed arm; a rigid straight arm either clips the torso or crosses the hip.
const FOREARM_NATURAL_DIR = {
  L_Upperarm: [ 0.18, -0.96, 0.18],
  R_Upperarm: [-0.18, -0.96, 0.18],
};
const ARM_REST_CHAINS = {
  L_Upperarm: ['leftUpperArm',  'leftLowerArm'],
  R_Upperarm: ['rightUpperArm', 'rightLowerArm'],
};
const ARM_HAND_BONE = { L_Upperarm: 'leftHand', R_Upperarm: 'rightHand' };

function buildRestIdleClip(THREE, vrm, opts) {
  const { name = 'rest_idle', duration = 4 } = opts || {};
  const armOffsets = {}; // vrm bone name -> [x,y,z,w]
  const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _pc = new THREE.Vector3();
  const _parentWorldQ = new THREE.Quaternion();
  for (const [mixName, [upperBone, lowerBone]] of Object.entries(ARM_REST_CHAINS)) {
    const shoulder = vrm.humanoid.getNormalizedBoneNode?.(upperBone);
    const elbow    = vrm.humanoid.getNormalizedBoneNode?.(lowerBone);
    const hand     = vrm.humanoid.getNormalizedBoneNode?.(ARM_HAND_BONE[mixName]);
    if (!shoulder || !elbow || !hand) continue;
    shoulder.updateWorldMatrix(true, false);
    elbow.updateWorldMatrix(true, false);
    hand.updateWorldMatrix(true, false);
    shoulder.getWorldPosition(_pa); elbow.getWorldPosition(_pb); hand.getWorldPosition(_pc);
    const upperBindDir = _pb.clone().sub(_pa).normalize();
    const lowerBindDir = _pc.clone().sub(_pb).normalize();
    const naturalDir   = new THREE.Vector3(...ARM_NATURAL_DIR[mixName]).normalize();

    // setFromUnitVectors gives a WORLD-space rotation; the bone's rest local
    // quaternion is identity, but its PARENT (shoulder/chest) is not at world
    // identity, so this world delta has to be conjugated into the bone's local
    // frame (parent^-1 * worldDelta * parent) before it can be assigned to
    // node.quaternion.
    shoulder.parent.getWorldQuaternion(_parentWorldQ);
    const shoulderParentQ = _parentWorldQ.clone();
    const upperWorldDelta = new THREE.Quaternion().setFromUnitVectors(upperBindDir, naturalDir);
    const upperLocal = shoulderParentQ.clone().invert().multiply(upperWorldDelta).multiply(shoulderParentQ);
    armOffsets[upperBone] = [upperLocal.x, upperLocal.y, upperLocal.z, upperLocal.w];

    // The elbow's ACTUAL parent at playback is the upper arm's NEW orientation
    // (newShoulderWorldQ), so that's the left-side conjugation. But the elbow's
    // bind world quat (the "starting point" the world-space delta rotates away
    // from) is P, the same as the shoulder's own bind world quat — both sit at
    // identity local rotation in bind pose. Solving
    // newShoulderWorldQ · lowerLocal = D2 · P  for lowerLocal gives an
    // asymmetric conjugation (left side ≠ right side).
    const forearmNaturalDir = new THREE.Vector3(...FOREARM_NATURAL_DIR[mixName]).normalize();
    const newShoulderWorldQ = shoulderParentQ.clone().multiply(upperLocal);
    const lowerWorldDelta = new THREE.Quaternion().setFromUnitVectors(lowerBindDir, forearmNaturalDir);
    const lowerLocal = newShoulderWorldQ.clone().invert().multiply(lowerWorldDelta).multiply(shoulderParentQ);
    armOffsets[lowerBone] = [lowerLocal.x, lowerLocal.y, lowerLocal.z, lowerLocal.w];
  }

  const RESTING_BONES = ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand'];
  const tracks = [];
  for (const boneName of RESTING_BONES) {
    const node = vrm.humanoid.getNormalizedBoneNode?.(boneName);
    if (!node) continue;
    const q = armOffsets[boneName] || [0, 0, 0, 1];
    tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, [0, duration], [...q, ...q]));
  }
  return new THREE.AnimationClip(name, duration, tracks);
}

module.exports = { MIXAMO_TO_VRM, VRM_PARENT, CHAIN_CHILD, buildRetargeter, buildRestIdleClip };
