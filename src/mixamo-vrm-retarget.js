// Shared Mixamo (Nyxia3dV2.glb) → VRM humanoid retargeting.
// Used by desktop-avatar.html (live overlay) and vrm-viewer.html (standalone
// test viewer) so both play the same 42 nyxia-anims.glb clips on a VRM rig.

// Nyxia3dV2.glb bone name → VRM humanoid bone name (girl_character2*.vrm)
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

// Retargeting: q_vrm = q_src_rest_inv * q_src_anim
// Converts absolute bone rotations into delta-from-rest, making them coordinate-system agnostic.
// The VRM starts from its own identity rest pose and gets the same relative rotation applied.
// Rest rotations extracted from Nyxia3dV2.glb nodes.
const SRC_REST = {
  Hip:         [ 0.324243,-0.324243,-0.126084, 0.879679],
  Waist:       [-0.115333,-0.885280,-0.302947, 0.333467],
  Spine01:     [-0.000001,-0.000000,-0.000000, 1.000000],
  NeckTwist01: [-0.000000,-0.000000, 0.000000, 1.000000],
  Head:        [ 0.000004, 0.000004, 0.000000, 1.000000],
  L_Clavicle:  [ 0.615907,-0.781169, 0.063245, 0.080215],
  L_Upperarm:  [ 0.035483,-0.001175,-0.179511, 0.983115],
  L_Forearm:   [ 0.022997, 0.001068, 0.100903, 0.994630],
  L_Hand:      [ 0.000000,-0.000000,-0.000000, 1.000000],
  R_Clavicle:  [ 0.628747, 0.770867,-0.064586, 0.079185],
  R_Upperarm:  [ 0.003038, 0.000105, 0.180386, 0.983591],
  R_Forearm:   [ 0.064823,-0.002970,-0.100920, 0.992776],
  R_Hand:      [-0.000000,-0.000004, 0.000001, 1.000000],
  L_Thigh:     [ 0.999469,-0.027281, 0.000181, 0.017812],
  L_Calf:      [-0.255699, 0.019532, 0.037713, 0.965823],
  L_Foot:      [ 0.871717,-0.056425,-0.024633, 0.486126],
  R_Thigh:     [ 0.987060,-0.008572,-0.001391, 0.160115],
  R_Calf:      [-0.001979, 0.000036, 0.018037, 0.999835],
  R_Foot:      [ 0.812036,-0.020339,-0.006436, 0.583218],
};

// Per-clip, time-windowed corrective nudges — for isolated pose-vs-clothing
// clashes that only occur in a brief slice of one specific clip. Unlike
// ARM_REST_OFFSET (always-on, every clip), these blend in/out around a
// [start,end] window so the rest of the clip is untouched.
const CLIP_TIME_CORRECTIONS = {
  frustrated_01: [
    // Right hand rests on the hip ~t2.8-3.7s; the sleeve cuff pokes through
    // the raised skirt pleat there. Nudge the forearm to lift the wrist
    // clear of the pleat without changing the rest of the gesture.
    { bone: 'R_Forearm', start: 2.8, end: 3.7, fade: 0.2, axis: [0, 1, 0], angleDeg: 55 },
  ],
};

function correctionWeight(c, time) {
  if (time < c.start - c.fade || time > c.end + c.fade) return 0;
  if (time < c.start) return smoothstep(c.start - c.fade, c.start, time);
  if (time > c.end) return 1 - smoothstep(c.end, c.end + c.fade, time);
  return 1;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function axisAngleQuat(axis, angleRad) {
  const half = angleRad / 2, s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

function qMul(a, b) {
  return [
    a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
    a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
    a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
    a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2]
  ];
}

// The source rig (Nyxia3dV2.glb) rests with arms down; the VRM rests in
// T-pose (arms out) — a plain delta-from-rest (SRC_REST_INV above) only
// cancels correctly when both rigs share a rest direction, which is true
// for legs/spine but not arms: with near-zero delta (idle barely moves the
// source arm from its own rest), the VRM is left at ITS rest, i.e. T-pose.
// ARM_REST_OFFSET is a per-bone constant, computed once from the loaded
// VRM's own T-pose bone directions, that rotates the upper arm/forearm from
// T-pose down to a natural hanging pose. It's left-multiplied onto the
// retargeted delta so idle settles into that hang, and animated clips swing
// the arm starting from there instead of from T-pose.
const ARM_NATURAL_DIR = {
  L_Upperarm: [ 0.42, -0.90, 0.08],
  R_Upperarm: [-0.42, -0.90, 0.08],
};
// Forearm gets its own, more inward target — a straight rigid arm forces a
// tradeoff between "elbow clears the torso" and "hand doesn't cross the
// midline" (both scale together with one direction). A real relaxed arm has
// a slight elbow bend: upper arm swings out for clearance, forearm curls
// back toward the hip. Same [x,y,z] world-direction convention as above.
const FOREARM_NATURAL_DIR = {
  L_Upperarm: [ 0.18, -0.96, 0.18],
  R_Upperarm: [-0.18, -0.96, 0.18],
};
const ARM_REST_CHAINS = {
  L_Upperarm: ['leftUpperArm',  'leftLowerArm'],
  R_Upperarm: ['rightUpperArm', 'rightLowerArm'],
};
const ARM_HAND_BONE = { L_Upperarm: 'leftHand', R_Upperarm: 'rightHand' };

// buildRetargeter(THREE) → retargetMixamoToVRM(clips, vrm)
// THREE is passed in rather than imported here because callers load it via
// a dynamic `import('three')` against their own importmap.
function buildRetargeter(THREE) {
  const SRC_REST_INV = {};
  for (const [k, q] of Object.entries(SRC_REST)) SRC_REST_INV[k] = [-q[0],-q[1],-q[2], q[3]];

  return function retargetMixamoToVRM(clips, vrm) {
    // Target the NORMALIZED humanoid bones, not raw: VRMHumanoid.update()
    // copies normalizedHumanBones → rawHumanBones every frame (autoUpdateHumanBones,
    // true by default) — animating raw bones directly gets silently overwritten
    // back to bind pose on the very next frame, which is why the model sat frozen
    // in its T-pose bind no matter what the mixer played.
    const boneMap = {};
    for (const [mixName, vrmBoneName] of Object.entries(MIXAMO_TO_VRM)) {
      const node = vrm.humanoid.getNormalizedBoneNode?.(vrmBoneName);
      if (node) boneMap[mixName] = node.name;
    }
    console.log(`[retarget] bone map: ${Object.keys(boneMap).length}/${Object.keys(MIXAMO_TO_VRM).length} bones mapped`);

    // Build per-bone rest-offset quaternions from the live VRM's own T-pose.
    const ARM_REST_OFFSET = {};
    const _pa = new THREE.Vector3(), _pb = new THREE.Vector3();
    for (const [mixName, [fromBone, toBone]] of Object.entries(ARM_REST_CHAINS)) {
      const a = vrm.humanoid.getNormalizedBoneNode?.(fromBone);
      const b = vrm.humanoid.getNormalizedBoneNode?.(toBone);
      if (!a || !b) continue;
      a.updateWorldMatrix(true, false); b.updateWorldMatrix(true, false);
      a.getWorldPosition(_pa); b.getWorldPosition(_pb);
      const tPoseDir  = _pb.clone().sub(_pa).normalize();
      const naturalDir = new THREE.Vector3(...ARM_NATURAL_DIR[mixName]).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(tPoseDir, naturalDir);
      ARM_REST_OFFSET[mixName] = [q.x, q.y, q.z, q.w];
    }

    return clips.map(clip => {
      const tracks = [];
      for (const track of clip.tracks) {
        const dot = track.name.lastIndexOf('.');
        const boneName = track.name.slice(0, dot);
        const prop     = track.name.slice(dot + 1);
        const nodeName = boneMap[boneName];
        if (!nodeName) continue;
        // Skip position tracks — VRM bones stay at their rest positions
        if (prop === 'position') continue;
        const t = track.clone();
        t.name = `${nodeName}.${prop}`;
        // Apply delta-from-rest: q_vrm = q_src_rest_inv * q_src_anim
        if (prop === 'quaternion' && SRC_REST_INV[boneName]) {
          const ri = SRC_REST_INV[boneName];
          const offset = ARM_REST_OFFSET[boneName];
          const corrections = (CLIP_TIME_CORRECTIONS[clip.name] || []).filter(c => c.bone === boneName);
          // Hemisphere continuity: q and -q are the same rotation, but Three.js's
          // keyframe interpolator doesn't know that — if adjacent keyframes end up
          // on opposite sides of that double-cover (common after this per-sample
          // remap), it slerps the "long way around" and the limb whips through a
          // ~360° flip between two poses that were never actually far apart. Since
          // negating a quaternion doesn't change the pose it represents, flipping
          // the sign back into the same hemisphere as the previous keyframe fixes
          // the interpolation path without changing any sampled pose.
          let prev = null;
          for (let i = 0; i < t.values.length; i += 4) {
            const q = [t.values[i], t.values[i+1], t.values[i+2], t.values[i+3]];
            let r = qMul(ri, q);
            if (offset) r = qMul(offset, r);
            for (const c of corrections) {
              const w = correctionWeight(c, t.times[i / 4]);
              if (w > 0) r = qMul(r, axisAngleQuat(c.axis, THREE.MathUtils.degToRad(c.angleDeg) * w));
            }
            if (prev && (r[0]*prev[0] + r[1]*prev[1] + r[2]*prev[2] + r[3]*prev[3]) < 0) {
              r = [-r[0], -r[1], -r[2], -r[3]];
            }
            prev = r;
            t.values[i]=r[0]; t.values[i+1]=r[1]; t.values[i+2]=r[2]; t.values[i+3]=r[3];
          }
        }
        tracks.push(t);
      }
      return new THREE.AnimationClip(clip.name, clip.duration, tracks);
    });
  };
}

// buildRestIdleClip(THREE, vrm) → a static "arms hanging naturally" AnimationClip.
// Needs no Mixamo source data at all — same T-pose→natural-hang vector trick as
// ARM_REST_OFFSET above, just baked into a standalone 2-keyframe clip instead of
// composed onto an animated track. Works on any loaded VRM (girl_character2*.vrm
// or vrm_girl.vrm), which is what makes it useful for index.html too: that window
// loads a VRM with zero baked animation clips and has been stuck in bind T-pose
// with nothing to fall back on.
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
    // node.quaternion — assigning it directly (as ARM_REST_OFFSET does, composed
    // on top of a real animated delta) is close enough to pass unnoticed, but
    // as the ENTIRE rotation for a static pose the error was obvious: arms
    // stayed pinned near T-pose instead of swinging down.
    shoulder.parent.getWorldQuaternion(_parentWorldQ);
    const shoulderParentQ = _parentWorldQ.clone();
    const upperWorldDelta = new THREE.Quaternion().setFromUnitVectors(upperBindDir, naturalDir);
    const upperLocal = shoulderParentQ.clone().invert().multiply(upperWorldDelta).multiply(shoulderParentQ);
    armOffsets[upperBone] = [upperLocal.x, upperLocal.y, upperLocal.z, upperLocal.w];

    // Forearm gets its OWN target (FOREARM_NATURAL_DIR, a bit more inward) —
    // a slight elbow bend, not a rigid straight arm. Leaving the forearm's
    // local rotation at identity does NOT mean "continue straight": identity
    // means "keep whatever bend bind pose already had", which combines
    // unpredictably (even crossing to the other side of the body) once the
    // upper arm is rotated far from T-pose.
    //
    // The elbow's ACTUAL parent at playback is the upper arm's NEW orientation
    // (newShoulderWorldQ), so that's the left-side conjugation. But the elbow's
    // bind world quat (needed as the "starting point" the world-space delta D2
    // rotates away from) is P, the same as the shoulder's own bind world quat —
    // both upper arm and forearm sit at identity local rotation in bind pose, so
    // world_bind(elbow) = P, not newShoulderWorldQ. Solving
    // newShoulderWorldQ · lowerLocal = D2 · P  for lowerLocal gives an asymmetric
    // conjugation (left side ≠ right side) — using newShoulderWorldQ on both
    // sides (symmetric, like the upper arm's own formula) was the bug that sent
    // the forearm swinging up behind her instead of continuing down.
    const forearmNaturalDir = new THREE.Vector3(...FOREARM_NATURAL_DIR[mixName]).normalize();
    const newShoulderWorldQ = shoulderParentQ.clone().multiply(upperLocal);
    const lowerWorldDelta = new THREE.Quaternion().setFromUnitVectors(lowerBindDir, forearmNaturalDir);
    const lowerLocal = newShoulderWorldQ.clone().invert().multiply(lowerWorldDelta).multiply(shoulderParentQ);
    armOffsets[lowerBone] = [lowerLocal.x, lowerLocal.y, lowerLocal.z, lowerLocal.w];
  }

  // Upper arms + forearms both get an explicit natural-hang target (straight
  // arm, no bend); hands hold their own bind rest.
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

module.exports = { MIXAMO_TO_VRM, SRC_REST, buildRetargeter, buildRestIdleClip };
