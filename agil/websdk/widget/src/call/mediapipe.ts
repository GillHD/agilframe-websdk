/**
 * Dynamic loader for MediaPipe Tasks Vision from the CDN.
 *
 * The widget must not bundle MediaPipe (no new npm dependencies and a ~10 MB
 * wasm/model payload). It is imported lazily the first time background
 * segmentation or liveness detection is needed; when the CDN is unavailable the
 * caller degrades gracefully (see blur.ts / integrity.ts).
 */

export const MEDIAPIPE_VERSION = '0.10.14';
export const TASKS_VISION_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
export const TASKS_VISION_WASM = `${TASKS_VISION_URL}/wasm`;
export const SELFIE_SEGMENTER_MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite';
export const FACE_LANDMARKER_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export interface MaskLike {
  width: number;
  height: number;
  getAsFloat32Array(): Float32Array;
  getAsUint8Array(): Uint8Array;
  close?(): void;
}

export interface SegmentResultLike {
  confidenceMasks?: MaskLike[];
  categoryMask?: MaskLike;
}

export interface ImageSegmenterLike {
  segmentForVideo(input: unknown, timestampMs: number, callback: (result: SegmentResultLike) => void): void;
  close?(): void;
}

export interface BlendshapeCategoryLike {
  categoryName: string;
  score: number;
}

export interface FaceLandmarkerResultLike {
  faceBlendshapes: Array<{ categories: BlendshapeCategoryLike[] }>;
  faceLandmarks: Array<Array<{ x: number; y: number; z: number }>>;
}

export interface FaceLandmarkerLike {
  detectForVideo(input: unknown, timestampMs: number): FaceLandmarkerResultLike;
  close?(): void;
}

export interface TasksVisionModule {
  FilesetResolver: { forVisionTasks(path: string): Promise<unknown> };
  ImageSegmenter: {
    createFromOptions(
      fileset: unknown,
      options: {
        baseOptions: { modelAssetPath: string; delegate?: 'CPU' | 'GPU' };
        runningMode: 'IMAGE' | 'VIDEO';
        outputCategoryMask?: boolean;
        outputConfidenceMasks?: boolean;
      },
    ): Promise<ImageSegmenterLike>;
  };
  FaceLandmarker: {
    createFromOptions(
      fileset: unknown,
      options: {
        baseOptions: { modelAssetPath: string; delegate?: 'CPU' | 'GPU' };
        runningMode: 'IMAGE' | 'VIDEO';
        numFaces?: number;
        outputFaceBlendshapes?: boolean;
        outputFacialTransformationMatrixes?: boolean;
      },
    ): Promise<FaceLandmarkerLike>;
  };
}

let modulePromise: Promise<TasksVisionModule | null> | null = null;

/** Loads @mediapipe/tasks-vision once; resolves `null` when the CDN is blocked. */
export function loadTasksVision(): Promise<TasksVisionModule | null> {
  if (!modulePromise) {
    modulePromise = (async () => {
      try {
        const mod: unknown = await import(/* @vite-ignore */ TASKS_VISION_URL);
        const candidate = mod as Partial<TasksVisionModule>;
        if (!candidate.FilesetResolver) return null;
        return candidate as TasksVisionModule;
      } catch (error) {
        console.warn('[agil] MediaPipe tasks-vision is unavailable (CDN blocked?)', error);
        return null;
      }
    })();
  }
  return modulePromise;
}

export interface SegmenterHandle {
  segmenter: ImageSegmenterLike;
  degraded: boolean;
}

/** Creates a selfie segmenter; `null` when MediaPipe cannot be loaded. */
export async function createSelfieSegmenter(): Promise<ImageSegmenterLike | null> {
  const tasks = await loadTasksVision();
  if (!tasks) return null;
  try {
    const fileset = await tasks.FilesetResolver.forVisionTasks(TASKS_VISION_WASM);
    const options = {
      baseOptions: { modelAssetPath: SELFIE_SEGMENTER_MODEL, delegate: 'GPU' as const },
      runningMode: 'VIDEO' as const,
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    };
    try {
      return await tasks.ImageSegmenter.createFromOptions(fileset, options);
    } catch {
      // Headless/older GPUs may reject the GPU delegate; CPU still provides a person mask.
      return await tasks.ImageSegmenter.createFromOptions(fileset, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: 'CPU' as const },
      });
    }
  } catch (error) {
    console.warn('[agil] selfie segmenter failed to load', error);
    return null;
  }
}

/** Creates a face landmarker for the liveness challenge; `null` on failure. */
export async function createFaceLandmarker(): Promise<FaceLandmarkerLike | null> {
  const tasks = await loadTasksVision();
  if (!tasks) return null;
  try {
    const fileset = await tasks.FilesetResolver.forVisionTasks(TASKS_VISION_WASM);
    return await tasks.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_LANDMARKER_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
  } catch (error) {
    console.warn('[agil] face landmarker failed to load', error);
    return null;
  }
}
