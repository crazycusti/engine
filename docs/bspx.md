# BSPX Support in QuakeShack

The QuakeShack engine supports a subset of the **BSPX** extension format, an unofficial standard to embed additional lumps (data chunks) into Quake 1 `BSP29` as well as `BSP2` map files without breaking backward compatibility.

These extended limits and specific features are enabled by modern Map Compilers (such as `ericw-tools`).

## Supported BSPX Lumps

The following lumps are recognized and utilized by the engine when available in the `.bsp` file. Note that some features are fully supported while others have experimental or limited usage due to engine constraints mapping them.

| State | Lump Name | Purpose | Support Level | Description |
|---|-----------|---------|---------------|-------------|
| ✅ | `RGBLIGHTING` | Colored Lightmaps | **Full** | Replaces the standard grayscale Quake lightmaps with 3-byte RGB variants for rich colored static lighting. |
| ⚠️ | `LIGHTINGDIR` | Deluxemaps / Directional Lighting | **Limited** (Materials Only) | Stores light direction vectors (normals) alongside lightmaps. This is primarily used for **per-pixel lighting** on supported materials (e.g., PBR materials using `.qsmat.json`), allowing normal maps to respond realistically to static baked lighting. Standard texture surfaces do not currently use deluxemaps. |
| ✅ | `LIGHTGRID_OCTREE` | Dynamic Entity Lighting | **Full** | A sparse voxel octree structure containing baked ambient lighting data. This allows cleanly and smoothly lighting dynamically moving objects (like players, monsters, and items) anywhere in the map based on the static lights compiled into the layout. |
| ⚠️ | `BRUSHLIST` | Brush-Based Collision | **Limited** / **Experimental** | Contains original brush plane data. When present, QuakeShack uses a Quake 2-based `Pmove` (Player Move) code path for **non-hull-based collision detection**, providing smoother physics compared to the original Quake 1 node/cliphull logic. Currently experimental and depends entirely on structural/BSP geometry rather than specific clip brushes. |

## Compiling maps with BSPX support
To take advantage of these features, you should compile your maps using tools capable of producing BSPX lumps, such as [ericw-tools](https://github.com/ericwa/ericw-tools).

For example, generating `LIGHTINGDIR` and `RGBLIGHTING` with `light`:
```bash
light -extra -deluxe -bspx <mapname>
```
