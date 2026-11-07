# 1sms.store — cinematic commerce + AI 2D→3D

A Next.js App Router starter for a premium dark-mode storefront with a scroll-scrubbed Three.js object study, interactive GLB viewer, WhatsApp ordering, admin product-image upload, and a separate AI model-generation worker.

> This is a deployable application foundation, not a fully provisioned live store. Production operation requires your database, Redis, object storage/CDN, provider API key, real admin password, domain, and operational monitoring. Payment methods are intentionally presentation-only until a payment provider and verified webhooks are configured.

## Architecture

```text
Browser / Next.js
 ├─ Server-rendered product catalog (PostgreSQL via Prisma)
 ├─ Client store / cart (Zustand)
 ├─ Scroll scene (GSAP ScrollTrigger → progress ref → R3F useFrame)
 ├─ Product GLB viewer (R3F + Drei OrbitControls + KTX2Loader)
 └─ Admin (httpOnly signed session)
       │ multipart image upload
       ▼
 Next.js API ── S3/R2 private source image
       │
       ├─ PostgreSQL GenerationJob
       └─ BullMQ queue (Redis)
                    │
                    ▼
              Worker process
               1. Read source image
               2. Optional remove.bg background removal
               3. Sharp rotate/resize/normalize
               4. Meshy Image-to-3D task
               5. Poll task status / honor Retry-After
               6. Download temporary GLB immediately
               7. glTF Transform: Draco + KTX2
               8. Upload optimized GLB to S3/R2
               9. Persist CDN URL + READY status on Product
```

### Why a worker is separate

Image-to-3D is asynchronous and can take minutes. It must not run inside a web request or a short-lived serverless route. The API enqueues a durable job; a long-running worker performs polling, model processing and publishing. Run the web app and worker as separate processes/services.

## Project layout

```text
app/
  api/admin/login/route.ts
  api/admin/products/[productId]/generate-3d/route.ts
  api/admin/jobs/[jobId]/route.ts
  api/products/route.ts
  admin/page.tsx
  globals.css
  layout.tsx
  page.tsx
components/
  AdminGenerator.tsx
  CartDrawer.tsx
  CustomCursor.tsx
  LenisProvider.tsx
  ProductViewer.tsx
  ScrollExperience.tsx
  Storefront.tsx
lib/
  auth/admin.ts
  db.ts
  image-preprocess.ts
  providers/meshy.ts
  queue.ts
  storage.ts
  store.ts
  types.ts
prisma/
  schema.prisma
  seed.ts
workers/
  3d.worker.ts
  process-3d.ts
```

## Local development

Requirements: Node.js 22+, PostgreSQL, Redis, an S3-compatible bucket (Cloudflare R2, AWS S3, MinIO), and a Meshy API key.

1. Install dependencies:

   ```bash
   npm install
   cp .env.example .env
   ```

2. Generate an admin password hash. This uses Node's built-in scrypt:

   ```bash
   node -e "const c=require('crypto'); const p=process.argv[1]; const salt=c.randomBytes(32).toString('hex'); const hash=c.scryptSync(p,salt,64).toString('hex'); console.log({salt,hash})" 'YOUR-LONG-ADMIN-PASSWORD'
   ```

   Put the returned values in `ADMIN_PASSWORD_SALT` and `ADMIN_PASSWORD_HASH`. Set `AUTH_SECRET` to a separate random secret with at least 32 characters. Never commit `.env`.

3. Configure:
   - `DATABASE_URL`: PostgreSQL connection string.
   - `REDIS_URL`: Redis connection string.
   - `S3_*`: bucket credentials and endpoint.
   - `S3_PUBLIC_BASE_URL`: HTTPS CDN origin serving the model objects.
   - `MESHY_API_KEY`: provider credential.
   - `REMOVE_BG_API_KEY`: optional background removal; without it, Sharp normalizes the image but does not remove the background.
   - `NEXT_PUBLIC_STORE_WHATSAPP`: WhatsApp number with country code, digits only, e.g. `9647xxxxxxxxx`. Add this to `.env` (it is a public contact number, not a secret).

4. Migrate and seed:

   ```bash
   npx prisma migrate dev --name init
   npm run db:seed
   ```

5. Start Redis and run two processes:

   ```bash
   npm run dev
   npm run worker
   ```

6. Visit `/` for the storefront and `/admin` for the protected generation console.

## AI 2D→3D flow

`POST /api/admin/products/:productId/generate-3d` accepts multipart form data with field `image`. Allowed types: JPEG, PNG and WebP; max 20 MB. It stores the input privately, creates a `GenerationJob`, and enqueues BullMQ work.

The worker:
- Uses a short-lived signed source-image URL when submitting to Meshy.
- Calls `POST https://api.meshy.ai/openapi/v1/image-to-3d`.
- Polls `GET https://api.meshy.ai/openapi/v1/image-to-3d/:id`, honors `Retry-After`, and handles `PENDING`, `IN_PROGRESS`, `SUCCEEDED`, `FAILED`.
- Downloads the returned GLB before its provider URL expires.
- Runs:

  ```bash
  gltf-transform optimize input.glb output.glb \
    --compress draco --texture-compress ktx2 --texture-size 1024
  ```

- Stores immutable model assets under a product-scoped key and writes `Product.modelUrl`, `Product.modelKey`, and `READY`.

The Meshy adapter is isolated in `lib/providers/meshy.ts`. Add a Tripo adapter implementing the same `create`/`getTask` interface and select it using a server-side provider config to change providers later.

## 3D viewer and scroll choreography

- `ScrollExperience.tsx`: GSAP ScrollTrigger scrubs a normalized progress value across a 360vh sticky scene. React Three Fiber's `useFrame` uses the progress to rotate the object and bring separated pieces together. This avoids DOM layout thrashing and keeps the animation deterministic in either scroll direction.
- `ProductViewer.tsx`: `OrbitControls` supports inertial 360-degree rotation, zoom and pan. Drei `Html` anchors display specification hotspots. Material swatches update material color without downloading the model again.
- KTX2: `ProductViewer` configures `KTX2Loader` with `/basis/`. The postinstall/build helper copies Three.js Basis transcoder assets to `public/basis`.

## Production hardening checklist

- **Admin authentication:** the starter uses a signed, HTTP-only, SameSite=Strict admin cookie and scrypt password verification. Add rate limiting, audit events, MFA and preferably an external identity provider before public production use.
- **Authorization:** the generation endpoint is admin-only. Add per-user roles if other merchant staff need access.
- **Image safety:** validate actual file signatures (implemented), virus-scan uploads, apply pixel limits and rate limits, and store originals privately.
- **Worker operations:** deploy the worker in a persistent container/process. Add dead-letter handling, concurrency limits, job dashboards, retries with backoff and alerting. Never rely on an ephemeral serverless runtime for the worker.
- **Asset processing:** the CLI operation requires its runtime dependencies and Basis/KTX2 encoder binaries. Test representative generated GLBs in your target browsers and devices. Keep an original/uncompressed fallback and only publish a compressed asset after validation.
- **CDN:** configure immutable caching, HTTPS, CORS for your domain and lifecycle rules for temporary uploads. Do not expose provider-signed temporary URLs as permanent product URLs.
- **Database:** use managed PostgreSQL, automated backups, migrations and connection pooling.
- **Payments:** current checkout composes a WhatsApp order only. For card/Apple Pay/Google Pay, integrate a supported payment processor, create server-side payment intents, verify webhook signatures and reconcile orders. Never trust totals received from the browser.
- **Shipping and tax:** free-shipping threshold in the cart is a UI example (50,000 IQD); confirm your actual shipping policy and calculate server-side.
- **Social proof:** the UI deliberately does not fabricate verified reviews. Populate `Review` only after validating a completed order.
- **Performance:** test on real low/mid-tier Android devices; cap DPR, lazy-load the viewer, use static image fallbacks, profile GPU memory, and respect `prefers-reduced-motion`. A locked 60 FPS cannot be guaranteed across all mobile GPUs.
- **Observability:** add structured logs, Sentry/OpenTelemetry, provider spend alerts and quotas.

## API summary

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/products` | Public published catalog |
| POST | `/api/admin/login` | Set admin session cookie |
| DELETE | `/api/admin/login` | Clear admin session |
| POST | `/api/admin/products/:id/generate-3d` | Upload image and queue generation |
| GET | `/api/admin/jobs/:jobId` | Admin-only generation progress |

## Notes about image-to-3D quality

A single image does not contain hidden/back-side geometry. An AI-generated 3D reconstruction is an estimate, not a dimensionally accurate CAD model. For products whose exact shape, branding, labels or dimensions matter, use multi-view imagery or a manually authored/verified model before publishing. An admin approval step is recommended before setting a generated asset live.

## References

- Meshy Image-to-3D API: https://docs.meshy.ai/en/api/image-to-3d
- Meshy task lifecycle and polling: https://docs.meshy.ai/en/api/task-lifecycle
- glTF Transform optimization CLI: https://gltf-transform.dev/cli
- React Three Fiber Canvas: https://r3f.docs.pmnd.rs/api/canvas
- GSAP ScrollTrigger: https://gsap.com/docs/v3/Plugins/ScrollTrigger/
- Lenis React integration: https://github.com/darkroomengineering/lenis/tree/main/packages/react
