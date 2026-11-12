# 1sms.store — cinematic commerce + AI 2D→3D

A Next.js App Router store with a premium dark-mode storefront, scroll-scrubbed Three.js object study, interactive GLB viewer, database-backed WhatsApp orders, protected product and inventory management, order operations, image uploads, and a separate AI model-generation worker.

> This is a deployable application foundation, not a fully provisioned live store. Production operation requires your database, shared Redis, object storage/CDN, provider API key, real admin password, domain, trusted client-IP header, and operational monitoring. Checkout records WhatsApp orders and indicates cash on delivery; no electronic payment gateway is connected.

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
  api/admin/orders/
  api/admin/products/
  api/orders/route.ts
  api/admin/products/[productId]/generate-3d/route.ts
  api/admin/jobs/[jobId]/route.ts
  api/products/route.ts
  admin/page.tsx
  globals.css
  layout.tsx
  page.tsx
components/
  AdminDashboard.tsx
  AdminGenerator.tsx
  CartDrawer.tsx
  CustomCursor.tsx
  LenisProvider.tsx
  LazyScrollExperience.tsx
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
   pnpm install
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
   pnpm exec prisma migrate dev --name init
   pnpm run db:seed
   ```

5. Start Redis and run two processes:

   ```bash
   pnpm run dev
   pnpm run worker
   ```

6. Visit `/` for the storefront and `/admin` for the protected product, inventory, order, and 3D operations dashboard.

## Automated checks

Run `pnpm test` for API and service tests. The suite mocks Prisma transaction behavior, the shared Redis rate-limit store, S3 requests, and Meshy HTTP calls; a 3D worker lifecycle test runs with database, storage, provider, and optimizer adapters mocked. The suite does not require live credentials or services. These mocks do not replace PostgreSQL concurrency/rollback tests or staging checks against the actual Redis, S3, and Meshy accounts.

JSON request bodies are streamed with explicit byte caps before parsing: 2 KiB for admin login, 4 KiB for order status changes, 8 KiB for product writes, and 16 KiB for checkout. Image uploads are capped at 10 MiB plus multipart overhead; 3D source uploads are capped at 20 MiB plus overhead and the file itself is checked again. Configure the hosting proxy's multipart request limit to at most 21 MiB.

## Orders and inventory

The cart submits customer details and product IDs with quantities to `POST /api/orders` with a UUID `Idempotency-Key`. The browser persists only the key in session storage, not the customer details. The server reloads published product prices, validates available inventory, reserves stock, and creates an order with an immutable line snapshot in one database transaction. A unique database constraint prevents concurrent duplicates; replaying the same key and payload returns the prior result, while reusing the key with different data returns `409`. The server compares a hash of normalized customer fields and product IDs/quantities against the saved order snapshot; no extra payload fingerprint or PII is stored.

The admin dashboard reads recent orders from `GET /api/admin/orders` and advances them through the supported fulfillment states with `PATCH /api/admin/orders/:orderId`. Cancelling an eligible order restores its reserved quantities transactionally. A WhatsApp order still pending more than 30 minutes after `createdAt` changes to `EXPIRED` and returns its stock in the same transaction. The conditional status update means a confirmation, cancellation, or competing expiry run can win only once.

### Order expiry scheduler

The application exposes `GET` and `POST /api/cron/expire-orders`; both methods require a bearer secret and reject request bodies. This supports Vercel Cron's `GET` request while preserving `POST` for external schedulers. **No schedule is enabled by this repository.** For Vercel, configure `CRON_SECRET`; Vercel sends it as the bearer token. Other schedulers may use `ORDER_EXPIRY_CRON_SECRET`. If both variables are set, they must match or the route fails closed with `503`. Use a random value of at least 32 bytes in the hosting secret manager. Never put it in a URL, browser code, or request logs. Missing configuration returns `503`; an invalid token returns `401`.

Each invocation checks up to 25 oldest eligible orders and reports `checked`, `expired`, `skipped`, `failed`, and `hasMore`. Alert on nonzero `failed`; if `hasMore` is true, invoke another bounded run or let the next scheduled minute continue the backlog. Verify the scheduler's HTTPS target, secret delivery, and monitoring during deployment.

`prisma/migrations/0_init/migration.sql` establishes the schema represented by Git HEAD before Phase 4. The following additive migration at `prisma/migrations/20261111120000_order_idempotency_and_expiry_index/migration.sql` remains unchanged and adds a nullable idempotency key for historical-order compatibility, its unique index, and the `(status, createdAt)` expiry lookup index. A new empty database receives both migrations through `prisma migrate deploy`. For an existing database, compare its schema and migration history first; mark a baseline as applied only after confirming that its SQL already matches the database, and never execute the baseline DDL over existing tables.

Both migrations were applied successfully to a newly created, isolated Stage 7 PostgreSQL test database in this worktree. They have not been applied to Neon or production. Production migration remains subject to the approved baseline review and backup process.

Product creation, editing, publishing, inventory changes, and image uploads are handled by the admin product endpoints under `/api/admin/products`. Uploaded catalog images are validated and optimized to WebP before publishing.

## AI 2D→3D flow

`POST /api/admin/products/:productId/generate-3d` accepts multipart form data with field `image`. Allowed types: JPEG, PNG and WebP; max 20 MB. It stores the input privately, creates a `GenerationJob`, and enqueues BullMQ work.

The original and normalized generation images stay private and are read with short-lived signed URLs. Only the finished model is published through the configured asset/CDN URL; catalog images are published separately through the product image upload endpoint.

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

- **Admin authentication:** the application uses a signed, HTTP-only, SameSite=Strict admin cookie, scrypt password verification, and Redis-backed rate limits. Add audit events, MFA, and preferably an external identity provider before public production use.
- **Rate limiting:** configure a shared production Redis URL and `RATE_LIMIT_TRUSTED_IP_HEADER`. The trusted reverse proxy must remove any client-supplied value and write exactly one canonical client IP to that header. Supported values are `x-real-ip`, `cf-connecting-ip`, and a normalized single-IP `x-forwarded-for`. Limits are 120 storefront/catalog/admin API requests per minute, 5 checkouts per 10 minutes, 5 admin login attempts per 15 minutes, 15 admin image uploads per hour, and 3 3D generations per hour per IP. Redis uses an atomic Lua counter with a fixed window; IPs are HMAC-hashed before becoming Redis keys. If Redis or trusted-IP configuration is unavailable in production, limited routes fail closed with `503`. Development without Redis skips throttling and never uses a process-local counter.
- **Authorization:** the generation endpoint is admin-only. Add per-user roles if other merchant staff need access.
- **Image safety:** actual file signatures, streamed request-size limits, image pixel limits, and rate limits are implemented. 3D source and normalized inputs use private no-store storage; product images and completed models are public CDN assets. Add malware scanning and lifecycle rules for abandoned private uploads.
- **Image privacy:** if `REMOVE_BG_API_KEY` is configured, the source image is sent to remove.bg for preprocessing. The normalized image is sent to Meshy via a signed URL that expires within 15 minutes. Confirm those vendors' privacy terms before enabling either external processing service.
- **Worker operations:** deploy the worker in a persistent container/process. Add dead-letter handling, concurrency limits, job dashboards, retries with backoff and alerting. Never rely on an ephemeral serverless runtime for the worker.
- **Asset processing:** the CLI operation requires its runtime dependencies and Basis/KTX2 encoder binaries. Test representative generated GLBs in your target browsers and devices. Keep an original/uncompressed fallback and only publish a compressed asset after validation.
- **CDN:** configure immutable caching, HTTPS, CORS for your domain and lifecycle rules for temporary uploads. Do not expose provider-signed temporary URLs as permanent product URLs.
- **Database:** use managed PostgreSQL, automated backups, migrations and connection pooling.
- **Payments:** only cash on delivery is configured. Checkout records an order and opens WhatsApp; there is no card, Apple Pay, Google Pay, payment SDK, payment-intent endpoint, or payment webhook. For electronic payment, integrate a supported processor, create server-side payment intents, verify webhook signatures, and reconcile orders. Never trust totals received from the browser.
- **Shipping and tax:** free-shipping threshold in the cart is a UI example (50,000 IQD); confirm your actual shipping policy and calculate server-side.
- **Social proof:** the UI deliberately does not fabricate verified reviews. Populate `Review` only after validating a completed order.
- **Performance:** test on real low/mid-tier Android devices; cap DPR, lazy-load the viewer, use static image fallbacks, profile GPU memory, and respect `prefers-reduced-motion`. A locked 60 FPS cannot be guaranteed across all mobile GPUs.
- **Observability:** add structured logs, Sentry/OpenTelemetry, provider spend alerts and quotas.

## API summary

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/products` | Public published catalog |
| GET | `/api/admin/products` | Admin product and inventory list |
| POST | `/api/admin/products` | Create a product |
| PATCH | `/api/admin/products/:id` | Update product details or publish state |
| POST | `/api/admin/products/:id/image` | Upload and optimize a product image |
| POST | `/api/orders` | Validate, reserve stock, and record a WhatsApp order |
| GET | `/api/admin/orders` | List recent orders |
| PATCH | `/api/admin/orders/:orderId` | Advance or cancel an order |
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
