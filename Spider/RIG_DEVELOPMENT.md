# Black Widow Procedural Locomotion Rig — Development Notes

Milestone: prepare the existing black-widow Blender model as a clean, consistently
named, runtime-ready skeletal rig for procedural IK, and export it as GLB/glTF for
the **Bothria Silk Lab** Three.js experiment.

**No gameplay code, no web, no walk cycle** was built. This is the rig interface only.

---

## 1. Files

| File | Purpose |
|---|---|
| `black_widow.blend` | **Original, untouched.** Preserved as-is. |
| `black_widow_ORIGINAL_BACKUP.blend` | Byte copy of the original made before any work. |
| `black_widow_RIG_WORKING.blend` | Working rig source (restructured armature + mesh, plus the original scene extras). |
| `black_widow_procedural_rig.glb` | **The deliverable.** Clean skinned rig for Three.js. |
| `SPIDER_RIG_SPEC.json` | Machine-readable rig spec (axes, bone names, chains, reach, limits). |
| `RIG_DEVELOPMENT.md` | This document. |

Blender target: **4.5.3 LTS** (≥ 4.3 requested).

---

## 2. Original-file assessment

The original scene contained a single already-skinned spider plus a Follow-Path
walk setup:

- **1 armature** `Armature` — 56 generically-named bones (`Bone`, `Bone.001` …),
  parented to `Empty.008`, with a small accidental object offset
  (loc ≈ (0.374, 0.012, 0.099), rot ≈ 1.3°, scale 1).
- **1 spider mesh** `Black_widow_04` — 60,057 verts, skinned to all 56 bones
  (Armature modifier), 1 material + UV map, and a **15,000-strand hair particle
  system** (`FUR` density group).
- **Clutter (not part of the rig):** `Camera`, `Plane` (ground), 9 `Empty` objects
  each with a **Follow Path** constraint, 8 `BezierCircle` path curves, and 10
  animation actions driving the empties along the paths.
- **No IK constraints** on the armature itself; the animation lived on the empties.

### What was retained
- The mesh, its material/UVs, and the **existing skin weights** (preserved through
  bone renaming — Blender renames matching vertex groups automatically).
- The existing rest pose (it is already a good bent-leg stance — see §7).
- All 8 real leg chains, 2 pedipalps, and the chelicerae.

### What was replaced / removed
- All bones **renamed** to a semantic scheme (§4).
- **Added** structural + reference bones (root, waist, abdomen, references,
  foot tips, foot homes, spinnerets, pedipalp tips).
- **Abdomen weights** split off the root into a dedicated `Abdomen`/`Pedicel`.
- **Object transforms baked** to identity and the rig recentered on the origin.
- The Follow-Path empties, curves, ground plane, camera, and all 10 actions are
  **excluded from the GLB** (left in the working .blend as the artist's originals).
- The **fur particle system** is excluded from the GLB (glTF has no hair; would
  otherwise drag in a stray instance mesh).

---

## 3. Coordinate convention (documented, one convention throughout)

The model natively faces **−X**; this axis is used and documented rather than
re-oriented (re-orienting a working, skinned rig adds risk for no functional gain —
the runtime reads the axis from the spec).

| Direction | Blender (Z-up) | glTF / Three.js (Y-up) |
|---|---|---|
| Forward (head) | **−X** | **−X** |
| Up (dorsal) | **+Z** | **+Y** |
| Right | **+Y** | **−Z** |
| Left | **−Y** | **+Z** |

glTF export maps `(x, y, z)_blender → (x, z, −y)_gltf`.

> Note for Three.js: the model faces **−X**, *not* the engine default of −Z.
> Read `forward` from `SPIDER_RIG_SPEC.json`. To align to −Z, apply a −90° rotation
> about +Y to `SpiderRoot` (or the loaded scene) at runtime.

**Transforms applied:** armature and mesh are both `location (0,0,0)`,
`rotation (0,0,0)`, `scale (1,1,1)`. `SpiderRoot`'s head sits exactly at the world
origin; the body is centered around it (feet below, abdomen behind). The model will
not unexpectedly rotate or scale on export.

### Bone local axes (leg/pedipalp)
- **+Y** = along the limb (head→tail).
- **+Z** = dorsal-up (roll normalized by aligning local Z to global +Z).
- **X** = the primary hinge/bend axis.

Left/right corresponding bones have **mirror-symmetric** local frames: an equal
local rotation on a L/R pair produces mirrored motion.

---

## 4. Rig hierarchy

```
SpiderRoot                        (game global transform; at origin)
├── Thorax                        (cephalothorax = primary locomotion body)
│   ├── Head
│   │   ├── Fang_L_01 → Fang_L_02 → Fang_L_03
│   │   └── Fang_R_01
│   ├── Leg_L1_Coxa → Femur → Patella → Tibia → Metatarsus → (FootTip)
│   ├── Leg_L2_… (same 5-seg chain + FootTip)
│   ├── Leg_L3_… (same)
│   ├── Leg_L4_Coxa → Femur → Patella → Tibia → Metatarsus → Tarsus → (FootTip)
│   ├── Leg_R1_… / Leg_R2_… / Leg_R3_… (5-seg + FootTip)
│   ├── Leg_R4_… (6-seg + FootTip)
│   ├── Pedipalp_L_01 → 02 → 03 → 04 → (Pedipalp_L_Tip)
│   ├── Pedipalp_R_01 → 02 → 03 → 04 → (Pedipalp_R_Tip)
│   ├── HeadReference   SupportReference   BodyCenter
│   ├── ForwardReference   DorsalReference
│   └── FootHome_L1 … FootHome_L4   FootHome_R1 … FootHome_R4
└── Pedicel                       (flexible waist)
    └── Abdomen                   (lags / tilts independently)
        ├── Spinneret_Center
        ├── Spinneret_L
        └── Spinneret_R
```

- **58 deform bones**, **27 non-deform reference bones**, **85 total**.
- `Pedicel` is a child of `SpiderRoot` (a sibling of `Thorax`), per the required
  hierarchy, so the abdomen can lag the thorax. The runtime drives `Pedicel`/
  `Abdomen` to follow the body with lag/tilt/roll.
- Reference bones (`FootTip`, `FootHome`, `Spinneret_*`, `*Reference`, `BodyCenter`,
  the two `Pedipalp_*_Tip`, and `SpiderRoot` itself) are **deform-disabled** — they
  export as joint nodes but influence no vertices.

### Leg numbering
Front → rear: **1, 2, 3, 4**. `L` = left (−Y), `R` = right (+Y).
- L1/R1 front, L2/R2 mid-front, L3/R3 mid-rear, L4/R4 rear.
- Determined from coxa/foot X-position and confirmed by orthographic renders
  (front = the pedipalp/fang end).

### Leg chains
Every leg has the semantic chain **Coxa → Femur → Patella → Tibia → Metatarsus**
plus a **FootTip**. The two rear legs (**L4, R4**) additionally have a **Tarsus**
before the FootTip (the source geometry gives them one extra articulation). The
`FootTip` head sits at the true distal silk-contact point (the tip of the last
segment), never mid-segment.

---

## 5. Bone-axis convention & the roll fix (key deliverable)

The **most important correction.** In the source rig, left and right legs had
**identical roll values** (e.g. `Bone.007` = `Bone.030` = −1.5293). Because the
geometry is Y-mirrored, identical rolls mean the local axes are **not** true
mirrors — exactly the "mirrored legs twist in opposite conventions" failure.

Fix: every leg and pedipalp bone had its roll **recomputed** by aligning its local
Z axis to global +Z (`EditBone.align_roll((0,0,1))`). For Y-mirrored bones this
provably yields mirror-symmetric local frames. Changing roll does **not** move any
rest-pose vertex, so the existing skin is preserved.

**Validation (final rig):** for all 21 L/R leg-bone pairs, the deviation from a
perfect mirror is **≤ 0.0148** (≈ 0.85°), and that residual is due to real
left/right asymmetry baked into the source mesh, not to roll error. Body bones
(`SpiderRoot`, `Thorax`, `Head`, `Pedicel`, `Abdomen`, references) use roll 0 and
point along +X so their local Z is dorsal-up.

---

## 6. Skinning

- Bind preserved by renaming (weights follow bone names).
- **Abdomen articulation added:** the abdomen was rigidly weighted to the root. A
  smooth X-based ramp transferred those weights into a new `Abdomen` bone with a
  `Pedicel` hump across the waist (3,622 verts touched), keeping normalization
  intact. The abdomen now pitches/tilts on the pedicel without a hard hinge and
  without deforming the thorax (verified — see §8).
- **Influence cleanup:** the source had up to **11** influences/vertex (632 verts
  over 4). Clamped to **top-4 + renormalized** (FUR density group excluded).
  Result: **max 4 influences, 0 unweighted vertices**.
- Vertex groups match deform bone names; `Abdomen` and `Pedicel` groups added; the
  `FUR` group is dropped from the GLB.

### Known skinning limitations
- The very narrow leg tips can show minor automatic-weight softness at extreme
  bends; adequate for procedural locomotion but a manual weight polish pass could
  tighten the distal tarsus/metatarsus if desired.
- The abdomen/pedicel transfer is analytic (X-ramp), not hand-painted; it reads
  smoothly in tests but the waist blend width can be tuned if the abdomen feels
  slightly soft at large tilt.
- Fangs: `Fang_R` has a single bone vs. `Fang_L`'s three (source asymmetry).

---

## 7. Neutral pose

The **armature rest pose is the neutral procedural stance** (kept, to preserve the
skin bind — no separate clip needed).

- No leg is straight: rest knee angles ≈ **103–152°** (L1 134.8, L2 103.4, L3 104.8,
  L4 151.8; right side identical) → unambiguous preferred bend for IK.
- Thorax clears the foot plane by ≈ **0.11** units.
- Feet form a broad splayed arrangement; front legs reach forward, rear legs stay
  free for silk work; abdomen is clear of the thorax.
- Left/right balanced (mirror) but with the source's small natural asymmetry.

---

## 8. Test poses (validation only)

Driven via FK bone rotations and rendered (no clips saved, none exported):

1. All eight feet planted — the rest neutral stance renders correctly.
2. Front leg (L1) extended forward (`Coxa` yaw + `Femur` lift).
3. Mid leg (R2) lifted (`Femur`).
4. Rear legs (L4/R4) folded toward the spinneret region (`Femur` + `Tibia`).
5. **Thorax tilted ~40°** — body pitches, legs stay attached.
6. **Spider rotated upside-down** via `SpiderRoot` X-180° — whole body flips and the
   mesh follows; pure-FK rig cannot break at extreme orientation.
7. **Abdomen lagged/tilted** opposite the thorax — smooth pedicel deformation, no
   rubberiness, thorax unaffected.
8. One foot held while the thorax moves within reach — bones move independently.

All poses deformed cleanly with correct, mirror-symmetric leg motion.

---

## 9. Export instructions (reproducible)

Exported with Blender's glTF exporter, **armature + mesh only selected**:

- `export_format='GLB'`, `use_selection=True`, `export_yup=True`
- `export_apply=False` (keep the Armature modifier → real skinning)
- `export_skins=True`, `export_def_bones=False` (export **all** bones incl. refs)
- `export_animations=False`, `export_cameras=False`, `export_lights=False`
- Fur particle system **removed** on the export copy first (not saved back).

To re-export: open `black_widow_RIG_WORKING.blend`, run
`scratchpad/export_glb.py` (in the session temp dir), or reproduce with the settings
above.

### Verified in the exported GLB (re-parsed from the file)
- 1 armature (single scene root), 1 skinned mesh `Black_widow_04`, 1 material + 1
  embedded texture image. **87 nodes = 85 joints + mesh + root.**
- **0 cameras, 0 lights, 0 animations, 0 extensions** — nothing auto-plays.
- Scale 1,1,1; no unintended root rotation; geometry centered near origin.
- **All required bones survived** by exact name: SpiderRoot, Thorax, Pedicel,
  Abdomen, Head; all 8 `Leg_*_FootTip`; all 8 `FootHome_*`; all 3 `Spinneret_*`;
  both `Pedipalp_*_Tip`; the reference bones; `Leg_L4/R4_Tarsus`.

> The Blender glTF **importer** creates a stray placeholder `Icosphere` when
> re-importing this file for inspection. That mesh is **not in the GLB** (the file's
> JSON lists exactly one mesh); it is a Blender import-side artifact only.

---

## 10. Three.js integration notes

- Load the GLB; the scene root is the `Armature` node containing `SpiderRoot`.
- Drive **`SpiderRoot`** for the global body transform (position/orientation on the
  web). Read `forward = −X`, `up = +Y` from the spec.
- Solve your own IK: rotate the named joint bones (`Leg_*_Coxa … Metatarsus/Tarsus`)
  so each `Leg_*_FootTip` reaches your dynamically chosen contact. `FootTip` gives
  the end-effector world position.
- `FootHome_*` are **static neutral preferences** (parented to `Thorax`), not live
  targets — use them to bias where a comfortable, unconstrained foot wants to be.
- Move `Thorax` for body bob/lean; drive `Pedicel`/`Abdomen` for the lagging,
  tilting abdomen; `Spinneret_L/R/Center` world positions are your silk emit points.
- Use `recommended_joint_limits_deg` in the spec to reject impossible footholds
  (approximate; tune in engine). **No Blender constraints/IK/drivers are exported** —
  the skeleton is pure FK by design.
- Reach budget per leg is in the spec (`reach_units`): comfortable ≈ 0.72,
  max ≈ 0.97, min ≈ 0.32 model units.

---

## 11. Validation report (final rig)

| Metric | Value |
|---|---|
| Mesh objects | 1 (`Black_widow_04`, 60,057 verts) |
| Deform bones | 58 |
| Reference (non-deform) bones | 27 |
| Total bones | 85 |
| Leg chains found | 8 (L1–L4, R1–R4), each Coxa→Femur→Patella→Tibia→Metatarsus[→Tarsus for L4/R4]→FootTip |
| Missing required bones | none |
| FootTip bones | 8/8 present, at true distal tips |
| FootHome references | 8/8 present |
| Spinneret references | 3/3 present |
| Pedipalp tips | 2/2 present |
| Duplicate bone names | none (Blender enforces uniqueness) |
| Inconsistent bone rolls | none — L/R mirror deviation ≤ 0.85° (source asymmetry) |
| Vertices with no weight | 0 |
| Vertices with > 4 influences | 0 |
| Max influences per vertex | 4 |
| Invalid transforms | none — armature & mesh identity, scale 1 |
| GLB export status | **OK** — reloads with all names, no cameras/lights/anims |

---

## 12. Next milestone

- Build the Three.js locomotion controller: route/junction selection, foot-contact
  selection, planted-foot logic, body position/orientation solve, above/below/around
  strand rotation, weight feedback into the web sim, and the per-leg IK solver
  targeting `Leg_*_FootTip` under the reach/limit budget in the spec.
- Optional rig polish if needed later: hand-paint distal leg weights, tune the
  abdomen/pedicel blend width, and (if −Z-forward is preferred) bake a +Y −90°
  re-orientation into the export.
