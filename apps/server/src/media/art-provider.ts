/**
 * Media/art provider abstraction.
 *
 * `LocalAssetProvider` is the only working provider: it resolves public URLs
 * for files the user uploaded into the controlled uploads directory.
 *
 * `GeneratedArtProvider` is an INTENTIONALLY DISABLED stub. It documents where
 * an AI image-generation backend (e.g. a local Stable Diffusion / ComfyUI
 * endpoint, or a hosted image API) would plug in later. It must NOT call any
 * image-generation API today.
 */

export const ASSET_URL_PREFIX = '/uploads';

export interface MediaGenerationRequest {
  prompt: string;
  kind: 'portrait' | 'expression' | 'background' | 'item' | 'other';
  characterId?: string;
}

export interface GeneratedMedia {
  /** Path relative to the uploads directory of the newly stored image. */
  relativePath: string;
  mimeType: string;
}

export interface MediaProvider {
  readonly id: string;
  /** Whether this provider can synthesize new images. */
  readonly canGenerate: boolean;
  /** Build a browser-usable URL for a stored relative asset path. */
  publicUrl(relativePath: string): string;
  /** Generate an image. Throws if `canGenerate` is false. */
  generate(request: MediaGenerationRequest): Promise<GeneratedMedia>;
}

export class LocalAssetProvider implements MediaProvider {
  readonly id = 'local';
  readonly canGenerate = false;

  publicUrl(relativePath: string): string {
    const clean = relativePath.replace(/^\/+/, '');
    return `${ASSET_URL_PREFIX}/${clean}`;
  }

  generate(): Promise<GeneratedMedia> {
    return Promise.reject(
      new Error('LocalAssetProvider cannot generate art. Upload a local image instead.'),
    );
  }
}

/**
 * DISABLED stub. Left here so a future contributor can wire up image
 * generation without redesigning the asset pipeline.
 *
 * To enable (future work):
 *   1. Set `canGenerate = true`.
 *   2. In `generate()`, call your image backend (e.g. POST to a local
 *      Stable Diffusion / ComfyUI server). Keep all network access SERVER-SIDE.
 *   3. Save the returned bytes via `asset-service.saveUploadedAsset(...)` and
 *      return the stored relative path.
 *   4. Expose an opt-in route + a Settings toggle, and surface a clear
 *      "AI-generated" label in the UI.
 */
export class GeneratedArtProvider implements MediaProvider {
  readonly id = 'generated-stub';
  readonly canGenerate = false;

  publicUrl(relativePath: string): string {
    const clean = relativePath.replace(/^\/+/, '');
    return `${ASSET_URL_PREFIX}/${clean}`;
  }

  generate(_request: MediaGenerationRequest): Promise<GeneratedMedia> {
    // Intentionally NOT implemented. No image API is contacted.
    return Promise.reject(
      new Error('AI art generation is not enabled in this build (GeneratedArtProvider is a stub).'),
    );
  }
}

/** The active provider. Local-only by default. */
export const mediaProvider: MediaProvider = new LocalAssetProvider();
