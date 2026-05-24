// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCRFD face detection postprocessing.
 *
 * The detection.onnx in InsightFace's buffalo_l bundle is SCRFD-10G with
 * three feature pyramid levels (strides 8, 16, 32) and 2 anchors per
 * position. The ONNX export emits nine flat tensors of shape `[N, C]`
 * (already reshaped/permuted from NCHW by the exporter):
 *
 *   For each stride s with feature map h_s × w_s and 2 anchors:
 *     score_s : [h_s*w_s*2, 1]   — anchor scores (sigmoid-activated)
 *     bbox_s  : [h_s*w_s*2, 4]   — LTRB distance preds in stride units
 *     kps_s   : [h_s*w_s*2, 10]  — 5 keypoint (x,y) preds in stride units
 *
 * For a 640×640 input, the row counts are 12800/3200/800 for s=8/16/32.
 * Row order is anchor-major within each (y, x) spatial cell:
 *   row i = ((y * w + x) * 2) + a  for anchor a ∈ {0, 1}.
 *
 * Decode is "distance-from-anchor-center" — preds (in stride units) are
 * LTRB offsets from the anchor center; multiplying by stride recovers
 * pixel coords. We then NMS across all levels.
 */

export interface RawFaceDetection {
    /** [x1, y1, x2, y2] in INPUT-IMAGE pixel space (640×640 letterboxed). */
    bbox: [number, number, number, number]
    /** 0..1 detector confidence. */
    confidence: number
    /** 5 landmarks (eyes, nose, mouth corners) in input-image pixel space. */
    landmarks: Array<[number, number]>
}

const NUM_ANCHORS_PER_POSITION = 2

/**
 * Decode the flat (N, C) SCRFD outputs for one stride into raw detections.
 * Inputs are already extracted from the tensor data arrays.
 */
export function decodeStride(
    stride: number,
    score: Float32Array,
    bbox: Float32Array,
    kps: Float32Array,
    inputSize: number,
    scoreThreshold: number,
): RawFaceDetection[] {
    const sideCells = Math.round(inputSize / stride)
    const detections: RawFaceDetection[] = []
    const rows = score.length
    if (rows !== bbox.length / 4 || rows !== kps.length / 10) {
        throw new Error(
            `decodeStride: shape mismatch — score=${rows}, bbox=${bbox.length / 4}, kps=${kps.length / 10}`,
        )
    }
    if (rows !== sideCells * sideCells * NUM_ANCHORS_PER_POSITION) {
        throw new Error(
            `decodeStride: stride ${stride} expected ${sideCells * sideCells * NUM_ANCHORS_PER_POSITION} rows, got ${rows}`,
        )
    }
    for (let row = 0; row < rows; row++) {
        const s = score[row]!
        if (s < scoreThreshold) continue
        const cellIdx = Math.floor(row / NUM_ANCHORS_PER_POSITION)
        const y = Math.floor(cellIdx / sideCells)
        const x = cellIdx % sideCells
        // Anchor center in input-image pixels. SCRFD anchors are placed at
        // the top-left corner of each stride cell (NOT the cell center) —
        // mirroring the InsightFace reference implementation. We use
        // x*stride, y*stride here without the +0.5 offset.
        const cx = x * stride
        const cy = y * stride
        const b = row * 4
        const l = bbox[b]! * stride
        const t = bbox[b + 1]! * stride
        const r = bbox[b + 2]! * stride
        const bb = bbox[b + 3]! * stride
        const x1 = cx - l
        const y1 = cy - t
        const x2 = cx + r
        const y2 = cy + bb
        const k = row * 10
        const landmarks: Array<[number, number]> = []
        for (let p = 0; p < 5; p++) {
            const kx = kps[k + 2 * p]! * stride + cx
            const ky = kps[k + 2 * p + 1]! * stride + cy
            landmarks.push([kx, ky])
        }
        detections.push({ bbox: [x1, y1, x2, y2], confidence: s, landmarks })
    }
    return detections
}

/**
 * Hard non-maximum suppression by IoU. Returns kept detections in
 * descending confidence order.
 */
export function nms(dets: RawFaceDetection[], iouThreshold: number): RawFaceDetection[] {
    const sorted = [...dets].sort((a, b) => b.confidence - a.confidence)
    const kept: RawFaceDetection[] = []
    const suppressed = new Set<number>()
    for (let i = 0; i < sorted.length; i++) {
        if (suppressed.has(i)) continue
        kept.push(sorted[i]!)
        const [ax1, ay1, ax2, ay2] = sorted[i]!.bbox
        const aArea = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1)
        for (let j = i + 1; j < sorted.length; j++) {
            if (suppressed.has(j)) continue
            const [bx1, by1, bx2, by2] = sorted[j]!.bbox
            const ix1 = Math.max(ax1, bx1)
            const iy1 = Math.max(ay1, by1)
            const ix2 = Math.min(ax2, bx2)
            const iy2 = Math.min(ay2, by2)
            const iw = Math.max(0, ix2 - ix1)
            const ih = Math.max(0, iy2 - iy1)
            const inter = iw * ih
            const bArea = Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1)
            const union = aArea + bArea - inter
            if (union > 0 && inter / union > iouThreshold) suppressed.add(j)
        }
    }
    return kept
}
