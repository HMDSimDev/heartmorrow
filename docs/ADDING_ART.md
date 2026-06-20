# Adding art / assets

All art is **local**. You upload images; the server stores them under the controlled
uploads directory and records metadata in SQLite. Nothing is sent to any remote service.

## Uploading

- In the **Character editor**, the Portrait and each Expression use an **AssetPicker**:
  click **⬆ Upload image** to add a new image, or pick an existing one.
- Allowed types: PNG, JPEG, WebP, GIF, AVIF. Max size 8 MiB.
- Uploaded files are served read-only at `/uploads/<generated-name>` (proxied by Vite in dev).

## How it's stored safely

- The on-disk filename is **server-generated** (`asset_<uuid>.<ext>`) — the client's
  filename is never used for the path.
- `asset-service.safeUploadsPath` additionally rejects any resolved path that escapes the
  uploads directory.
- MIME type is validated against an allow-list; size is capped.

## Assigning art

- A character has a `portraitAssetId` and an `expressionAssets` map
  (`{ "happy": assetId, "sad": assetId, ... }`).
- During a date, the structured evaluator returns an `expression` key; the UI shows the
  matching expression image if one is assigned, else the portrait, else an initials
  placeholder.
- Shop items may also reference an `assetId`.

## AI-generated art (intentionally NOT enabled)

`apps/server/src/media/art-provider.ts` defines a `MediaProvider` interface with:

- `LocalAssetProvider` — the only active provider (resolves `/uploads/...` URLs).
- `GeneratedArtProvider` — a **disabled stub**. Its `generate()` throws. Comments mark
  exactly where to plug in a local image backend (e.g. Stable Diffusion / ComfyUI) later:
  set `canGenerate = true`, call your backend **server-side**, save bytes via
  `asset-service.saveUploadedAsset`, and add an opt-in route + UI toggle + an
  "AI-generated" label. No image API is contacted today.
